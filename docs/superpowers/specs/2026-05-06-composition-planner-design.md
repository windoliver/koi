# Composition Planner Design

## Summary

Issue `#1299` adds the missing bridge between raw system signals and autonomous multi-capability planning. Koi already has pieces that detect demand and operational state changes, but it does not yet normalize those events into a stable planning contract or generate composition plans that combine tools, agent spawns, scheduling, forge, and user notification.

This design introduces:

- a new L0 `CompositionTrigger` contract in `@koi/core`
- a normalized `SystemSignal -> CompositionTrigger` mapping utility in `@koi/proactive`
- a `CompositionPlanner` contract with both deterministic rule-based and optional LLM-backed implementations
- explicit approval classification based on confidence, estimated cost, and novelty

Execution remains out of scope. This work stops at validated plan generation.

## Goals

- Normalize planner-relevant `SystemSignal` events into a stable L0 trigger contract
- Generate `CompositionPlan` values that describe multi-step autonomous actions without executing them
- Ship a deterministic default planner that works without model access
- Ship an optional adapter-driven LLM planner that can reason over available capabilities and produce structured plans
- Keep approval decisions explicit and testable
- Fit existing Koi contracts for `EngineInput`, `DeliveryPolicy`, `ToolDescriptor`, `RegistryEntry`, `CronSchedule`, and `ForgeDemandSignal`

## Non-Goals

- Executing composition plans
- Adding new `SystemSignalSource` implementations
- Persisting novelty history or learning state
- Wiring planner execution into ACE, runtime, scheduler, or daemon flows
- Introducing runtime dependencies from `@koi/core`

## Current Repo Context

Relevant existing contracts and packages:

- [packages/kernel/core/src/system-signal.ts](/Users/sophiawj/.codex/worktrees/9345/koi/packages/kernel/core/src/system-signal.ts) defines raw system-facing events
- [packages/kernel/core/src/forge-demand.ts](/Users/sophiawj/.codex/worktrees/9345/koi/packages/kernel/core/src/forge-demand.ts) already models demand-triggered forge signals
- [packages/kernel/core/src/scheduler.ts](/Users/sophiawj/.codex/worktrees/9345/koi/packages/kernel/core/src/scheduler.ts) defines `ScheduleId`, `CronSchedule`, and scheduler event shapes
- [packages/kernel/core/src/engine.ts](/Users/sophiawj/.codex/worktrees/9345/koi/packages/kernel/core/src/engine.ts) defines `EngineInput`
- `DeliveryPolicy` and spawn delivery wiring already exist in `@koi/engine`
- [packages/lib/proactive/src/index.ts](/Users/sophiawj/.codex/worktrees/9345/koi/packages/lib/proactive/src/index.ts) currently exports sleep/cron tools only

The issue body references `.claude/plans/v2-rewrite.md`, but that file is not present in this checkout. The design therefore anchors on the current codebase rather than that missing document.

## Design Overview

The design splits the problem into three layers:

1. Raw event contract: `SystemSignal` stays the source-facing event vocabulary.
2. Normalized planning contract: `CompositionTrigger` becomes the planner-facing L0 vocabulary.
3. Planner implementations: `@koi/proactive` converts signals into triggers, then produces plans using either deterministic rules or an injected LLM adapter.

This keeps signal ingestion, planning, and execution as distinct responsibilities:

- signal adapters emit `SystemSignal`
- the mapper normalizes to `CompositionTrigger`
- planners produce `CompositionPlan`
- a future executor consumes `CompositionPlan`

## L0 Contract Additions

Add a new source file in `@koi/core` for composition planning types. These are L0 because they are shared contracts, not proactive-specific implementation details.

### CompositionTrigger

```ts
export interface CompositionTrigger {
  readonly id: string;
  readonly source: string;
  readonly confidence: number;
  readonly moment: CompositionMoment;
  readonly suggestedCapabilities: readonly string[];
  readonly context: Readonly<Record<string, unknown>>;
  readonly emittedAt: number;
}
```

### CompositionMoment

```ts
export type CompositionMoment =
  | { readonly kind: "capability_gap"; readonly missing: string }
  | {
      readonly kind: "threshold_crossed";
      readonly sensor: string;
      readonly value: number;
      readonly limit: number;
      readonly direction: "above" | "below";
    }
  | { readonly kind: "pattern_matched"; readonly patternId: string; readonly description: string }
  | {
      readonly kind: "task_terminal";
      readonly taskId: TaskId;
      readonly outcome: "completed" | "failed" | "dead_letter" | "cancelled";
    }
  | { readonly kind: "external_event"; readonly source: string; readonly eventType: string }
  | { readonly kind: "frontier_changed"; readonly metric: string; readonly improvement: number };
```

### Why `task_terminal` instead of `schedule_fired`

The issue draft used `schedule_fired`, but the current `SystemSignal` contract exposes scheduler-relevant composition events as terminal task outcomes, not raw cron firings. Matching the current contract avoids inventing an event shape that no existing upstream source produces.

### CompositionCapabilities

```ts
export interface CompositionCapabilities {
  readonly tools: readonly ToolDescriptor[];
  readonly agents: readonly RegistryEntry[];
  readonly schedules: readonly CronSchedule[];
  readonly forgeStore?: ForgeStore | undefined;
}
```

### CompositionPlan and Steps

```ts
export interface CompositionPlan {
  readonly triggerId: string;
  readonly steps: readonly CompositionStep[];
  readonly estimatedCost: number;
  readonly requiresApproval: boolean;
}

export type CompositionStep =
  | { readonly kind: "tool_call"; readonly toolName: string; readonly input: unknown }
  | {
      readonly kind: "spawn_agent";
      readonly agentType: string;
      readonly input: EngineInput;
      readonly delivery: DeliveryPolicy;
    }
  | {
      readonly kind: "submit_task";
      readonly agentId: AgentId;
      readonly input: EngineInput;
      readonly delayMs: number;
    }
  | {
      readonly kind: "create_schedule";
      readonly expression: string;
      readonly agentId: AgentId;
      readonly input: EngineInput;
      readonly timezone?: string | undefined;
    }
  | { readonly kind: "forge_skill"; readonly demand: ForgeDemandSignal }
  | {
      readonly kind: "notify_user";
      readonly channel: string;
      readonly message: string;
      readonly priority: "low" | "normal" | "high";
    };
```

### Why split scheduling into `submit_task` and `create_schedule`

The current scheduler contract distinguishes one-shot delayed submission from recurring cron registration. A single generic `schedule_task` step would blur those two primitives and make executor work harder later.

### Planner Contracts

```ts
export interface CompositionPlanner {
  readonly plan: (
    trigger: CompositionTrigger,
    capabilities: CompositionCapabilities,
  ) => Promise<CompositionPlan>;
}

export interface CompositionApprovalPolicy {
  readonly confidenceThreshold: number;
  readonly maxEstimatedCost: number;
  readonly requireApprovalOnNovelty: boolean;
}

export interface CompositionApprovalContext {
  readonly isNovel: boolean;
}
```

The novelty input is explicit rather than inferred from persistence. That keeps this contract usable before any ACE learning loop or plan-history store exists.

## Mapper Design

Add a mapper module to `@koi/proactive`:

```ts
mapSystemSignalToCompositionTrigger(
  signal: SystemSignal,
): CompositionTrigger | undefined
```

This function is pure, deterministic, and side-effect free.

### Mapping Rules

- `SystemSignal.kind === "governance"`:
  - map to `threshold_crossed`
  - source becomes `"governance"`
  - suggested capabilities depend on the sensor name when obvious, otherwise empty
- `SystemSignal.kind === "forge_demand"`:
  - map to `capability_gap`
  - `missing` comes from the most specific trigger field available
  - preserve the original `ForgeDemandSignal` inside `context`
- `SystemSignal.kind === "schedule"`:
  - map terminal scheduler outcomes to `task_terminal`
- `SystemSignal.kind === "vfs"`:
  - ignore in this first pass unless a future adapter promotes it to a stronger pattern signal
- `SystemSignal.kind === "agent_lifecycle"`:
  - ignore in the first pass
- `SystemSignal.kind === "anomaly"`:
  - map only anomaly shapes that clearly imply threshold or frontier movement; otherwise ignore
- `SystemSignal.kind === "compaction"`:
  - ignore in the first pass

### Forge Demand Mapping

Forge demand is treated as a subset of composition rather than a parallel planner input. The mapper turns a forge-demand signal into a normalized `CompositionTrigger` with `moment.kind = "capability_gap"`, which lets the planner consider forge as one possible step in a broader plan.

## Rule-Based Planner Design

The deterministic planner is the default implementation and lives in `@koi/proactive`.

Suggested public factory:

```ts
createRuleBasedCompositionPlanner(config?: {
  readonly approvalPolicy?: CompositionApprovalPolicy | undefined;
  readonly classifyNovelty?: ((trigger: CompositionTrigger) => boolean) | undefined;
}): CompositionPlanner
```

### Rule Table

- `capability_gap`
  - produce a plan containing `forge_skill`
  - optionally add `notify_user` for high-confidence missing capability scenarios
- `threshold_crossed`
  - if the sensor implies failure or degradation, spawn a diagnostic agent
  - if the sensor implies resource pressure, notify the user and optionally schedule follow-up work
- `pattern_matched`
  - produce the specific combination implied by the pattern
  - first pass can support a small hard-coded table keyed by `patternId`
- `task_terminal` with failed or dead-letter outcome
  - spawn a recovery or analysis agent
  - optionally notify the user for repeated failures
- `frontier_changed`
  - spawn a researcher or replicator agent with a deferred or streaming delivery policy depending on urgency
- `external_event`
  - reserved for downstream callers that generate normalized external triggers directly

### Rule Planner Behavior

- Always return a valid `CompositionPlan`
- Prefer empty `steps` plus `requiresApproval: true` over speculative behavior when a trigger is recognized but under-specified
- Estimate cost with simple additive heuristics based on step kinds
- Compute `requiresApproval` using:
  - trigger confidence below threshold
  - cost over budget
  - novelty classification when configured

## LLM Planner Design

The optional LLM planner should be adapter-driven, similar in spirit to the archived ACE reflector pattern, but specialized for structured composition planning rather than reflection.

### Public Shape

```ts
export interface CompositionPlannerAdapter {
  readonly plan: (input: CompositionPlannerAdapterInput) => Promise<string>;
}

export interface CompositionPlannerAdapterInput {
  readonly trigger: CompositionTrigger;
  readonly capabilities: CompositionCapabilities;
}

createLlmCompositionPlanner(config: {
  readonly adapter: CompositionPlannerAdapter;
  readonly approvalPolicy?: CompositionApprovalPolicy | undefined;
  readonly classifyNovelty?: ((trigger: CompositionTrigger) => boolean) | undefined;
  readonly fallbackToRulePlanner?: CompositionPlanner | undefined;
}): CompositionPlanner
```

### Behavior

- Build a structured prompt from:
  - normalized trigger
  - available tools
  - available agents
  - schedules
  - forge availability
- Require the adapter to return JSON only
- Parse and validate the JSON into a `CompositionPlan`
- Reject malformed output
- If a fallback planner is configured, use it on parse/validation failure
- Recompute `requiresApproval` after parsing so model output cannot bypass planner policy

### Validation

The LLM planner must not trust arbitrary model output. It should validate:

- trigger ID matches the input trigger
- step kinds are known
- required fields exist for each step kind
- `estimatedCost` is finite and non-negative
- `requiresApproval` is overwritten by local policy calculation

## Approval Policy

Approval classification belongs to the planner layer in this first pass.

Proposed helper:

```ts
computeCompositionApproval(
  trigger: CompositionTrigger,
  estimatedCost: number,
  policy: CompositionApprovalPolicy,
  context: CompositionApprovalContext,
): boolean
```

Rules:

- require approval when `trigger.confidence < confidenceThreshold`
- require approval when `estimatedCost > maxEstimatedCost`
- require approval when `requireApprovalOnNovelty` and `context.isNovel`

This helper should be shared by both planner implementations so approval behavior stays consistent.

## Error Handling

### Mapper

- Unsupported or intentionally ignored signals return `undefined`
- No thrown errors for normal unsupported input

### Rule Planner

- Does not throw for known trigger shapes
- Returns empty-step approval-gated plans for recognized but underspecified scenarios

### LLM Planner

- Parse and validation failures surface as deterministic planner errors or invoke configured fallback
- Never emit unvalidated plans

## File Layout

### `@koi/core`

- create `packages/kernel/core/src/composition-planner.ts`
- export the new contracts from the relevant core entrypoint(s) and API surface tests

### `@koi/proactive`

- create `packages/lib/proactive/src/composition-trigger.ts`
- create `packages/lib/proactive/src/composition-approval.ts`
- create `packages/lib/proactive/src/rule-based-composition-planner.ts`
- create `packages/lib/proactive/src/llm-composition-planner.ts`
- update `packages/lib/proactive/src/index.ts`

File responsibilities:

- `composition-trigger.ts`: normalization only
- `composition-approval.ts`: shared approval logic only
- `rule-based-composition-planner.ts`: deterministic planner only
- `llm-composition-planner.ts`: adapter prompt/parse/validate/fallback only

## Testing Strategy

### Core

- API surface tests for newly exported contracts
- Any type helper tests only if helpers are added in L0

### Proactive Mapper

Add table-driven tests covering:

- governance threshold signal to `threshold_crossed`
- forge demand to `capability_gap`
- scheduler terminal completed/failed/dead-letter/cancelled to `task_terminal`
- ignored signals returning `undefined`

### Rule Planner

Add deterministic tests asserting exact plans for:

- capability gap
- failure threshold crossed
- frontier changed
- approval required by low confidence
- approval required by high cost
- approval required by novelty

### LLM Planner

Add mocked-adapter tests for:

- valid structured JSON output
- malformed JSON
- structurally invalid JSON
- fallback-to-rule behavior
- local approval recomputation overriding model-provided approval

## Open Decisions Resolved In This Design

- Include the optional LLM planner in this first pass: yes
- Include `SystemSignal -> CompositionTrigger` normalization in this first pass: yes
- Keep execution out of scope: yes
- Match scheduler reality with `task_terminal` and split schedule-related step kinds: yes

## Risks

- The first-pass rule table may be intentionally conservative, which can produce empty-step approval-gated plans more often than a richer future planner.
- An LLM planner without tight validation would be dangerous; this design avoids that by requiring local validation and approval recomputation.
- Signal-to-trigger mapping will evolve as new `SystemSignal` sources land, so the mapper should stay focused and easily extensible.

## Rollout

1. Land L0 contracts and proactive exports.
2. Land mapper and rule-based planner with deterministic tests.
3. Land the optional LLM planner and validation/fallback tests.
4. Defer executor integration to the follow-up issue.
