# Composition Executor Design

## Summary

Issue `#1300` needs the execution half of the proactive composition flow that now exists in planning form. The repo already has:

- shared planning vocabulary in `@koi/core`
- signal-to-trigger mapping in `@koi/proactive`
- deterministic and LLM-backed planners in `@koi/proactive`

What is still missing is a thin executor that can consume a `CompositionPlan`, enforce approval gates, and delegate supported steps into existing runtime infrastructure without inventing new core systems inside `@koi/proactive`.

This design introduces:

- a shared `CompositionExecutor` contract in `@koi/core`
- shared execution result and error contracts in `@koi/core`
- a concrete `CompositionExecutionContext` in `@koi/proactive`
- an MVP executor implementation in `@koi/proactive`

The first executor pass intentionally supports only the thinnest and best-understood step kinds:

- `submit_task`
- `create_schedule`
- `notify_user`

Other step kinds remain typed but unsupported until their runtime seams are explicitly wired.

## Goals

- Add a stable shared execution contract next to the existing planning contract
- Keep `@koi/core` dependency-free and execution-context agnostic
- Keep `@koi/proactive` thin by delegating to existing scheduler and host-owned notification seams
- Enforce `requiresApproval` as a hard fail-closed gate
- Ship an MVP executor that is immediately useful for scheduler and notification flows
- Make unsupported steps explicit instead of burying speculative runtime behavior in the executor

## Non-Goals

- No rollback or compensating transactions in v1
- No parallel execution of plan steps
- No persistence layer for execution history beyond what downstream systems already persist
- No direct channel binding in the executor
- No implicit capability discovery or dynamic dependency lookup inside the executor
- No first-pass implementation of `spawn_agent`, `forge_skill`, or `tool_call`

## Current Repo Context

Relevant existing code and documentation:

- [packages/kernel/core/src/composition-planner.ts](/Users/sophiawj/.codex/worktrees/2fcf/koi/packages/kernel/core/src/composition-planner.ts) defines `CompositionTrigger`, `CompositionPlan`, and `CompositionStep`
- [packages/lib/proactive/src/composition-trigger.ts](/Users/sophiawj/.codex/worktrees/2fcf/koi/packages/lib/proactive/src/composition-trigger.ts) maps `SystemSignal` into planner triggers
- [packages/lib/proactive/src/rule-based-composition-planner.ts](/Users/sophiawj/.codex/worktrees/2fcf/koi/packages/lib/proactive/src/rule-based-composition-planner.ts) produces deterministic plans
- [packages/lib/proactive/src/llm-composition-planner.ts](/Users/sophiawj/.codex/worktrees/2fcf/koi/packages/lib/proactive/src/llm-composition-planner.ts) validates adapter-produced plans
- [packages/kernel/engine/src/delivery-policy.ts](/Users/sophiawj/.codex/worktrees/2fcf/koi/packages/kernel/engine/src/delivery-policy.ts) already handles spawn delivery policy resolution
- [packages/kernel/engine/src/koi.ts](/Users/sophiawj/.codex/worktrees/2fcf/koi/packages/kernel/engine/src/koi.ts) already contains inbox-driven idle/wake flow
- [packages/lib/proactive/src/provider.ts](/Users/sophiawj/.codex/worktrees/2fcf/koi/packages/lib/proactive/src/provider.ts) shows the current package pattern: thin wrappers over `SchedulerComponent`

This design follows the same pattern: shared contracts in L0, concrete dependency seams in L2, and no direct ownership of scheduler core, spawn lifecycle, or channel implementation inside `@koi/proactive`.

## Design Overview

The execution design is split into two layers:

1. `@koi/core` owns the shared execution contract and result vocabulary
2. `@koi/proactive` owns the concrete executor context and implementation

This keeps the stable cross-package contract small while letting the L2 implementation evolve as runtime seams for spawn, forge, and notifications become clearer.

## L0 Contract Additions

Add a new source file in `@koi/core`:

- [packages/kernel/core/src/composition-executor.ts](/Users/sophiawj/.codex/worktrees/2fcf/koi/packages/kernel/core/src/composition-executor.ts)

Re-export its public surface from:

- [packages/kernel/core/src/index.ts](/Users/sophiawj/.codex/worktrees/2fcf/koi/packages/kernel/core/src/index.ts)

### CompositionExecutor

```ts
export interface CompositionExecutor {
  readonly execute: (
    trigger: CompositionTrigger,
    plan: CompositionPlan,
  ) => Promise<CompositionExecutionResult>;
}
```

The executor accepts both `trigger` and `plan` because:

- the shared result should retain trigger identity
- future policy, logging, or auditing may need trigger context
- the planner and executor remain separate responsibilities

### CompositionExecutionResult

```ts
export type CompositionExecutionResult =
  | {
      readonly triggerId: string;
      readonly status: "executed";
      readonly stepResults: readonly SuccessfulCompositionStepResult[];
      readonly executedCount: number;
      readonly error?: undefined;
    }
  | {
      readonly triggerId: string;
      readonly status: "requires_approval";
      readonly stepResults: readonly [];
      readonly executedCount: 0;
      readonly error: CompositionExecutionError & { readonly code: "APPROVAL_REQUIRED" };
    }
  | {
      readonly triggerId: string;
      readonly status: "unsupported";
      readonly stepResults: readonly CompositionStepResult[];
      readonly executedCount: number;
      readonly error: CompositionExecutionError & {
        readonly code: "STEP_UNSUPPORTED" | "INVALID_PLAN";
      };
    }
  | {
      readonly triggerId: string;
      readonly status: "failed";
      readonly stepResults: readonly CompositionStepResult[];
      readonly executedCount: number;
      readonly error: CompositionExecutionError & { readonly code: "STEP_FAILED" | "INVALID_PLAN" };
    };
```

Semantics:

- `executed`
  - all step results are successful (`executed` or `skipped`) and no failure metadata is present
- `requires_approval`
  - the plan was not executed because `plan.requiresApproval === true`
- `unsupported`
  - execution stopped because the first unsupported step was encountered before any failure
- `failed`
  - execution stopped because a supported step failed

`executedCount` counts only steps with `CompositionStepResult.status === "executed"`.

### CompositionStepResult

```ts
export type CompositionStepResult =
  | {
      readonly step: CompositionStep;
      readonly status: "executed";
      readonly output?: unknown;
      readonly error?: undefined;
    }
  | {
      readonly step: CompositionStep;
      readonly status: "skipped";
      readonly output?: undefined;
      readonly error?: undefined;
    }
  | {
      readonly step: CompositionStep;
      readonly status: "unsupported";
      readonly output?: undefined;
      readonly error: CompositionExecutionError & {
        readonly code: "STEP_UNSUPPORTED" | "INVALID_PLAN";
      };
    }
  | {
      readonly step: CompositionStep;
      readonly status: "failed";
      readonly output?: undefined;
      readonly error: CompositionExecutionError & { readonly code: "STEP_FAILED" | "INVALID_PLAN" };
    };

export type SuccessfulCompositionStepResult = Extract<
  CompositionStepResult,
  { readonly status: "executed" | "skipped" }
>;
```

Notes:

- `skipped` is included in the shared vocabulary now even though the MVP executor does not use it yet. It is the natural fit for future policy-based or condition-based step omission.
- `output` is intentionally `unknown` because different step kinds return fundamentally different values. Normalizing output shapes belongs in a future iteration if real consumers need it.

### CompositionExecutionError

```ts
export interface CompositionExecutionError {
  readonly code:
    | "APPROVAL_REQUIRED"
    | "STEP_UNSUPPORTED"
    | "STEP_FAILED"
    | "INVALID_PLAN";
  readonly message: string;
  readonly stepKind?: CompositionStep["kind"] | undefined;
}
```

`INVALID_PLAN` is included to cover future invariants and host misuse even though the LLM-backed planner already performs strict plan validation before execution.

## L2 Contract Additions in `@koi/proactive`

Add a new source file:

- [packages/lib/proactive/src/composition-executor.ts](/Users/sophiawj/.codex/worktrees/2fcf/koi/packages/lib/proactive/src/composition-executor.ts)

Export it from:

- [packages/lib/proactive/src/index.ts](/Users/sophiawj/.codex/worktrees/2fcf/koi/packages/lib/proactive/src/index.ts)

### CompositionExecutionContext

```ts
export interface CompositionExecutionContext {
  readonly agentId: AgentId;
  readonly scheduler: SchedulerComponent;
  readonly notify: (notification: CompositionNotification) => Promise<unknown>;
  readonly spawn?: ((request: CompositionSpawnRequest) => Promise<unknown>) | undefined;
  readonly forge?: ((request: CompositionForgeRequest) => Promise<unknown>) | undefined;
}
```

This interface is intentionally L2-owned because it depends on concrete runtime seams and design choices that should not be frozen into L0 yet.

### Notification Shape

```ts
export interface CompositionNotification {
  readonly channel: string;
  readonly message: string;
  readonly priority: "low" | "normal" | "high";
}
```

The executor uses a generic `notify()` sink rather than a raw `ChannelAdapter` because the first expected target is inbox-style follow-up delivery, not immediate direct-channel dispatch. Keeping notification behind a host-supplied seam lets the runtime route it to inbox, channel, or another operator-owned destination without coupling `@koi/proactive` to channel package internals.

### Optional Future Seams

```ts
export interface CompositionSpawnRequest {
  readonly agentType: string;
  readonly input: EngineInput;
  readonly delivery: DeliveryPolicy;
}

export interface CompositionForgeRequest {
  readonly demand: ForgeDemandSignal;
}
```

These seams are part of the L2 context now so the executor implementation can grow into them later without redesigning the surrounding context shape.

### Factory

```ts
export function createCompositionExecutor(
  context: CompositionExecutionContext,
): CompositionExecutor
```

## MVP Step Support

The first implementation supports:

### `submit_task`

Supported.

`SchedulerComponent` is already agent-pinned, so the executor must first validate:

- `step.agentId === context.agentId`

Then it maps to `context.scheduler.submit(...)` using only the step’s:

- `mode`
- `input`
- `taskOptions`

The returned scheduler result is stored in `CompositionStepResult.output`.

### `create_schedule`

Supported.

`SchedulerComponent` is already agent-pinned, so the executor must first validate:

- `step.agentId === context.agentId`

Then it maps directly to `context.scheduler.schedule(...)` using the step’s:

- `expression`
- `mode`
- `input`
- `timezone`
- `taskOptions`

The returned scheduler result is stored in `CompositionStepResult.output`.

### `notify_user`

Supported.

Maps directly to:

```ts
await context.notify({
  channel: step.channel,
  message: step.message,
  priority: step.priority,
});
```

The return value from `notify()` is stored in `CompositionStepResult.output`.

### `spawn_agent`

Unsupported in the MVP.

Even though the repo already has real spawn and delivery machinery, this issue should not widen into runtime-owned spawn wiring until the dependency seam is explicitly chosen and tested. If a plan includes `spawn_agent`, the executor returns a `STEP_UNSUPPORTED` error with `stepKind: "spawn_agent"`.

### `forge_skill`

Unsupported in the MVP.

The repo has real forge and skill-stack machinery, but this design keeps `#1300` focused on execution contract and thin scheduler/notification dispatch. If a plan includes `forge_skill`, the executor returns `STEP_UNSUPPORTED`.

### `tool_call`

Unsupported in the MVP.

Calling arbitrary tools from an autonomous executor needs stronger policy and resolution decisions than this issue should absorb.

## Execution Semantics

### Sequential Execution

Steps run strictly in order.

This keeps behavior deterministic and easy to test, and it avoids inventing dependency ordering or partial concurrency semantics before there is a real need.

### Approval Gate

If `plan.requiresApproval` is `true`, the executor:

- returns `status: "requires_approval"`
- returns `executedCount: 0`
- returns `stepResults: []`
- includes a top-level `CompositionExecutionError` with code `APPROVAL_REQUIRED`

No step execution occurs before this gate.

### Fail-Closed on First Unsupported or Failed Step

The MVP executor stops at the first non-executable step.

That means:

- if a supported step throws or rejects, top-level status becomes `failed`
- if a step kind is unsupported, top-level status becomes `unsupported`
- execution does not continue after that point

This is deliberate. Continuing after an unsupported or failed autonomous step would create ambiguous partial-action behavior without rollback.

### Partial Progress

If earlier steps succeed before a later failure or unsupported step, the result reflects that partial progress:

- earlier steps appear in `stepResults` with `status: "executed"`
- the stopping step appears with `status: "failed"` or `status: "unsupported"`
- `executedCount` reflects only the successful prefix

This keeps the executor honest about side effects while still failing closed.

### No Rollback

The executor does not attempt compensating actions in v1.

Rollback is explicitly out of scope because:

- step side effects belong to external systems
- not all step kinds have symmetric undo paths
- speculative rollback logic would hide important operational truth in the result surface

## Validation and Error Handling

The executor should defensively reject obviously invalid inputs even if well-behaved planners should never produce them.

Examples:

- empty `steps` with top-level status still returning `executed` is allowed if the caller passes such a plan and `requiresApproval` is false; this is treated as a successful no-op rather than an invalid plan
- malformed host-provided step data or impossible invariants should surface as `INVALID_PLAN`
- downstream scheduler or notification exceptions are wrapped into `STEP_FAILED`

The executor should not throw for expected operational failures. It should return `CompositionExecutionResult` with explicit error information.

## Testing

### `@koi/core`

Add type-level conformance coverage near:

- [packages/kernel/core/src/system-signal.test.ts](/Users/sophiawj/.codex/worktrees/2fcf/koi/packages/kernel/core/src/system-signal.test.ts)

Cover:

- concrete `CompositionExecutionResult` conformance
- concrete `CompositionStepResult` conformance
- `CompositionExecutor` structural conformance
- exhaustiveness for result status / error code unions where useful

### `@koi/proactive`

Add unit tests in:

- [packages/lib/proactive/src/composition-executor.test.ts](/Users/sophiawj/.codex/worktrees/2fcf/koi/packages/lib/proactive/src/composition-executor.test.ts)

Cover:

- approval-required plan returns without executing steps
- `submit_task` delegates to scheduler and records output
- `submit_task` rejects mismatched `agentId` against `context.agentId`
- `create_schedule` delegates to scheduler and records output
- `notify_user` delegates to `notify()` and records output
- unsupported `spawn_agent` stops execution with `unsupported`
- unsupported `forge_skill` stops execution with `unsupported`
- supported prefix + unsupported later step records partial progress and correct `executedCount`
- supported prefix + failing scheduler/notify step records `failed`

Use stubs rather than the full runtime. The goal is to test executor control flow, not re-test scheduler internals.

## Documentation Updates

Update:

- [docs/L2/proactive.md](/Users/sophiawj/.codex/worktrees/2fcf/koi/docs/L2/proactive.md)

Add:

- the new executor surface
- the execution result vocabulary
- explicit MVP support boundaries
- the fact that planner generation and plan execution are now separate but adjacent capabilities in `@koi/proactive`

## Recommended Implementation Order

1. Add L0 execution contracts in `@koi/core`
2. Re-export them from the core index
3. Add type-level coverage in core tests
4. Add failing unit tests for the proactive executor
5. Implement `createCompositionExecutor(context)` in `@koi/proactive`
6. Export the executor surface from proactive index
7. Update proactive docs

## Risks and Mitigations

### Risk: freezing the wrong L0 surface too early

Mitigation:

- keep L0 intentionally small
- keep execution dependencies out of L0
- push concrete context shapes into `@koi/proactive`

### Risk: executor silently drifting into runtime ownership

Mitigation:

- support only scheduler and notify seams in the MVP
- leave spawn/forge/tool execution explicit and unsupported
- avoid direct channel or engine coupling in the first implementation

### Risk: ambiguous partial execution semantics

Mitigation:

- stop on first unsupported or failed step
- report executed prefix explicitly
- do not attempt hidden rollback

## Decision Summary

This design chooses:

- a small shared L0 executor contract
- a concrete L2 execution context in `@koi/proactive`
- fail-closed sequential execution
- hard approval gating
- MVP support for `submit_task`, `create_schedule`, and `notify_user` only

This gives issue `#1300` a narrow, shippable first slice that fits the repo’s current layering and leaves more opinionated runtime execution paths for follow-up work instead of collapsing them into one oversized change.
