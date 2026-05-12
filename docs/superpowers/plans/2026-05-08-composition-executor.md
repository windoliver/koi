# Composition Executor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared composition-execution contract in `@koi/core` and an MVP `@koi/proactive` executor that supports `submit_task`, `create_schedule`, and `notify_user` while failing closed on approval-required, unsupported, or failed steps.

**Architecture:** Keep execution vocabulary in `@koi/core` and concrete dependency wiring in `@koi/proactive`. Implement the executor as a thin sequential dispatcher over injected `scheduler` and `notify` seams, leaving `spawn_agent`, `forge_skill`, and `tool_call` explicitly unsupported in the first pass.

**Tech Stack:** TypeScript, Bun test runner, repo-local type-level contract tests, `@koi/core`, `@koi/proactive`, `@koi/scheduler`

---

## File Map

- Create: `packages/kernel/core/src/composition-executor.ts`
- Modify: `packages/kernel/core/src/index.ts`
- Modify: `packages/kernel/core/src/system-signal.test.ts`
- Create: `packages/lib/proactive/src/composition-executor.ts`
- Create: `packages/lib/proactive/src/composition-executor.test.ts`
- Modify: `packages/lib/proactive/src/index.ts`
- Modify: `docs/L2/proactive.md`

Responsibilities:

- `packages/kernel/core/src/composition-executor.ts`
  - Shared L0 execution contract and result vocabulary only
- `packages/kernel/core/src/index.ts`
  - Re-export the new core execution contract
- `packages/kernel/core/src/system-signal.test.ts`
  - Type-level structural coverage for the new execution contract
- `packages/lib/proactive/src/composition-executor.ts`
  - Concrete MVP executor over injected L2 dependencies
- `packages/lib/proactive/src/composition-executor.test.ts`
  - Runtime control-flow coverage for approval gating, supported steps, and fail-closed behavior
- `packages/lib/proactive/src/index.ts`
  - Export the new proactive executor surface
- `docs/L2/proactive.md`
  - Document the new executor capability and MVP support boundaries

### Task 1: Add Core Execution Contract

**Files:**
- Create: `packages/kernel/core/src/composition-executor.ts`
- Modify: `packages/kernel/core/src/index.ts`
- Modify: `packages/kernel/core/src/system-signal.test.ts`
- Test: `packages/kernel/core/src/system-signal.test.ts`

- [ ] **Step 1: Write the failing type-level contract assertions**

Add these assertions near the bottom of `packages/kernel/core/src/system-signal.test.ts`:

```ts
import type {
  CompositionExecutionError,
  CompositionExecutionResult,
  CompositionExecutor,
  CompositionStepResult,
  SuccessfulCompositionStepResult,
} from "./composition-executor.js";

const _stepResultConformance: CompositionStepResult = {
  step: {
    kind: "notify_user",
    channel: "inbox",
    message: "hello",
    priority: "normal",
  },
  status: "executed",
  output: { delivered: true },
};
void _stepResultConformance;

const _executionResultConformance: CompositionExecutionResult = {
  triggerId: "trigger-1",
  status: "executed",
  stepResults: [_stepResultConformance],
  executedCount: 1,
};
void _executionResultConformance;

// @ts-expect-error executed results cannot include unsupported step outcomes
const _invalidExecutedResult: CompositionExecutionResult = {
  triggerId: "trigger-invalid",
  status: "executed",
  stepResults: [
    {
      step: {
        kind: "notify_user",
        channel: "inbox",
        message: "hello",
        priority: "normal",
      },
      status: "unsupported",
      error: {
        code: "STEP_UNSUPPORTED",
        message: "notify_user is unsupported",
        stepKind: "notify_user",
      },
    },
  ],
  executedCount: 0,
};
void _invalidExecutedResult;

const _executionErrorConformance: CompositionExecutionError = {
  code: "STEP_UNSUPPORTED",
  message: "spawn_agent is unsupported",
  stepKind: "spawn_agent",
};
void _executionErrorConformance;

const _executorConformance: CompositionExecutor = {
  async execute(trigger, _plan): Promise<CompositionExecutionResult> {
    return {
      triggerId: trigger.id,
      status: "requires_approval",
      stepResults: [],
      executedCount: 0,
      error: {
        code: "APPROVAL_REQUIRED",
        message: "plan requires approval",
      },
    };
  },
};
void _executorConformance;
```

- [ ] **Step 2: Run the type-level test to verify it fails**

Run:

```bash
rtk bun test packages/kernel/core/src/system-signal.test.ts
```

Expected:

- FAIL with missing `./composition-executor.js` exports and the `executed` branch still accepting unsupported step results

- [ ] **Step 3: Write the core execution contract**

Create `packages/kernel/core/src/composition-executor.ts` with:

```ts
import type { CompositionPlan, CompositionStep, CompositionTrigger } from "./composition-planner.js";

export interface CompositionExecutor {
  readonly execute: (
    trigger: CompositionTrigger,
    plan: CompositionPlan,
  ) => Promise<CompositionExecutionResult>;
}

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

Update `packages/kernel/core/src/index.ts` by adding:

```ts
export type {
  CompositionExecutionError,
  CompositionExecutionResult,
  CompositionExecutor,
  CompositionStepResult,
  SuccessfulCompositionStepResult,
} from "./composition-executor.js";
```

- [ ] **Step 4: Run the type-level test to verify it passes**

Run:

```bash
rtk bun test packages/kernel/core/src/system-signal.test.ts
```

Expected:

- PASS

- [ ] **Step 5: Commit**

Run:

```bash
rtk git add packages/kernel/core/src/composition-executor.ts packages/kernel/core/src/index.ts packages/kernel/core/src/system-signal.test.ts
rtk git commit -m "feat: add composition executor core contracts"
```

### Task 2: Add Failing Proactive Executor Tests

**Files:**
- Create: `packages/lib/proactive/src/composition-executor.test.ts`
- Test: `packages/lib/proactive/src/composition-executor.test.ts`

- [ ] **Step 1: Write the failing runtime tests**

Create `packages/lib/proactive/src/composition-executor.test.ts` with:

```ts
import { describe, expect, test } from "bun:test";
import {
  agentId,
  CompositionPlan,
  CompositionTrigger,
  SchedulerComponent,
} from "../../../kernel/core/src/index.js";
import { createCompositionExecutor } from "./composition-executor.js";

function trigger(): CompositionTrigger {
  return {
    id: "trigger-1",
    source: "governance",
    confidence: 1,
    moment: { kind: "threshold_crossed", sensor: "error_rate", value: 1, limit: 0.2, direction: "above" },
    suggestedCapabilities: ["notify_user"],
    context: {},
    emittedAt: 1,
  };
}

function schedulerStub() {
  const calls: { submit: unknown[]; schedule: unknown[] } = { submit: [], schedule: [] };
  const scheduler = {
    async submit(...args: unknown[]) {
      calls.submit.push(args);
      return { id: "task-1" };
    },
    async schedule(...args: unknown[]) {
      calls.schedule.push(args);
      return { id: "schedule-1" };
    },
  } as unknown as SchedulerComponent;
  return { scheduler, calls };
}

describe("createCompositionExecutor", () => {
  test("returns requires_approval without executing steps", async () => {
    const { scheduler, calls } = schedulerStub();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      steps: [{ kind: "notify_user", channel: "inbox", message: "hello", priority: "high" }],
      estimatedCost: 1,
      requiresApproval: true,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("requires_approval");
    expect(result.executedCount).toBe(0);
    expect(result.stepResults).toEqual([]);
    expect(result.error).toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(calls.submit).toHaveLength(0);
    expect(calls.schedule).toHaveLength(0);
  });

  test("executes submit_task for the attached agent and records output", async () => {
    const { scheduler, calls } = schedulerStub();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      steps: [
        {
          kind: "submit_task",
          agentId: agentId("agent-1"),
          mode: "dispatch",
          input: { kind: "text", text: "follow up" },
          taskOptions: { delayMs: 5 },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("executed");
    expect(result.executedCount).toBe(1);
    expect(result.stepResults[0]?.status).toBe("executed");
    expect(result.stepResults[0]?.output).toEqual({ id: "task-1" });
    expect(calls.submit).toHaveLength(1);
    expect(calls.submit[0]).toEqual([
      { kind: "text", text: "follow up" },
      "dispatch",
      { delayMs: 5 },
    ]);
  });

  test("fails when submit_task targets a different agentId than the attached scheduler", async () => {
    const { scheduler, calls } = schedulerStub();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      steps: [
        {
          kind: "submit_task",
          agentId: agentId("agent-2"),
          mode: "dispatch",
          input: { kind: "text", text: "follow up" },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("failed");
    expect(result.executedCount).toBe(0);
    expect(result.error).toMatchObject({
      code: "INVALID_PLAN",
      stepKind: "submit_task",
    });
    expect(calls.submit).toHaveLength(0);
  });

  test("stops on unsupported spawn_agent after executed prefix", async () => {
    const { scheduler } = schedulerStub();
    const notifications: unknown[] = [];
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async (notification) => {
        notifications.push(notification);
        return { delivered: true };
      },
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      steps: [
        { kind: "notify_user", channel: "inbox", message: "hello", priority: "normal" },
        {
          kind: "spawn_agent",
          agentType: "researcher",
          input: { kind: "text", text: "investigate" },
          delivery: { kind: "deferred" },
        },
      ],
      estimatedCost: 3,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("unsupported");
    expect(result.executedCount).toBe(1);
    expect(result.stepResults[0]?.status).toBe("executed");
    expect(result.stepResults[1]?.status).toBe("unsupported");
    expect(result.error).toMatchObject({
      code: "STEP_UNSUPPORTED",
      stepKind: "spawn_agent",
    });
    expect(result.stepResults[1]?.error?.code).toBe("STEP_UNSUPPORTED");
    expect(notifications).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the proactive test to verify it fails**

Run:

```bash
rtk bun test packages/lib/proactive/src/composition-executor.test.ts
```

Expected:

- FAIL because `./composition-executor.js` does not exist yet

- [ ] **Step 3: Commit**

Run:

```bash
rtk git add packages/lib/proactive/src/composition-executor.test.ts
rtk git commit -m "test: add composition executor coverage"
```

### Task 3: Implement the MVP Proactive Executor

**Files:**
- Create: `packages/lib/proactive/src/composition-executor.ts`
- Modify: `packages/lib/proactive/src/index.ts`
- Test: `packages/lib/proactive/src/composition-executor.test.ts`

- [ ] **Step 1: Write the minimal executor implementation**

Create `packages/lib/proactive/src/composition-executor.ts` with:

```ts
import type {
  CompositionExecutionError,
  CompositionExecutionResult,
  CompositionExecutor,
  CompositionPlan,
  CompositionStep,
  CompositionStepResult,
  CompositionTrigger,
  DeliveryPolicy,
  EngineInput,
  ForgeDemandSignal,
  SchedulerComponent,
  SuccessfulCompositionStepResult,
} from "@koi/core";

export interface CompositionNotification {
  readonly channel: string;
  readonly message: string;
  readonly priority: "low" | "normal" | "high";
}

export interface CompositionSpawnRequest {
  readonly agentType: string;
  readonly input: EngineInput;
  readonly delivery: DeliveryPolicy;
}

export interface CompositionForgeRequest {
  readonly demand: ForgeDemandSignal;
}

export interface CompositionExecutionContext {
  readonly agentId: AgentId;
  readonly scheduler: SchedulerComponent;
  readonly notify: (notification: CompositionNotification) => Promise<unknown>;
  readonly spawn?: ((request: CompositionSpawnRequest) => Promise<unknown>) | undefined;
  readonly forge?: ((request: CompositionForgeRequest) => Promise<unknown>) | undefined;
}

function stepUnsupported(step: CompositionStep): CompositionStepResult {
  return {
    step,
    status: "unsupported",
    error: {
      code: "STEP_UNSUPPORTED",
      message: `Unsupported composition step: ${step.kind}`,
      stepKind: step.kind,
    },
  };
}

function approvalRequired(trigger: CompositionTrigger): CompositionExecutionResult {
  return {
    triggerId: trigger.id,
    status: "requires_approval",
    stepResults: [],
    executedCount: 0,
    error: {
      code: "APPROVAL_REQUIRED",
      message: "Composition plan requires approval before execution.",
    },
  };
}

function stepFailed(step: CompositionStep, cause: unknown): CompositionStepResult {
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    step,
    status: "failed",
    error: {
      code: "STEP_FAILED",
      message,
      stepKind: step.kind,
    },
  };
}

export function createCompositionExecutor(
  context: CompositionExecutionContext,
): CompositionExecutor {
  return {
    async execute(trigger: CompositionTrigger, plan: CompositionPlan): Promise<CompositionExecutionResult> {
      if (plan.requiresApproval) return approvalRequired(trigger);

      const stepResults: SuccessfulCompositionStepResult[] = [];
      let executedCount = 0;

      for (const step of plan.steps) {
        try {
          switch (step.kind) {
            case "submit_task": {
              if (step.agentId !== context.agentId) {
                const error = {
                  code: "INVALID_PLAN",
                  message: `submit_task agentId ${String(step.agentId)} does not match attached agent ${String(context.agentId)}`,
                  stepKind: step.kind,
                } satisfies CompositionExecutionError;
                stepResults.push({ step, status: "failed", error });
                return {
                  triggerId: trigger.id,
                  status: "failed",
                  stepResults,
                  executedCount,
                  error,
                };
              }
              const output = await context.scheduler.submit(
                step.input,
                step.mode,
                step.taskOptions,
              );
              stepResults.push({ step, status: "executed", output });
              executedCount += 1;
              break;
            }
            case "create_schedule": {
              if (step.agentId !== context.agentId) {
                const error = {
                  code: "INVALID_PLAN",
                  message: `create_schedule agentId ${String(step.agentId)} does not match attached agent ${String(context.agentId)}`,
                  stepKind: step.kind,
                } satisfies CompositionExecutionError;
                stepResults.push({ step, status: "failed", error });
                return {
                  triggerId: trigger.id,
                  status: "failed",
                  stepResults,
                  executedCount,
                  error,
                };
              }
              const output = await context.scheduler.schedule(
                step.expression,
                step.input,
                step.mode,
                { ...step.taskOptions, ...(step.timezone !== undefined ? { timezone: step.timezone } : {}) },
              );
              stepResults.push({ step, status: "executed", output });
              executedCount += 1;
              break;
            }
            case "notify_user": {
              const output = await context.notify({
                channel: step.channel,
                message: step.message,
                priority: step.priority,
              });
              stepResults.push({ step, status: "executed", output });
              executedCount += 1;
              break;
            }
            case "spawn_agent":
            case "forge_skill":
            case "tool_call": {
              const unsupported = stepUnsupported(step);
              stepResults.push(unsupported);
              return {
                triggerId: trigger.id,
                status: "unsupported",
                stepResults,
                executedCount,
                error: unsupported.error,
              };
            }
          }
        } catch (cause) {
          const failed = stepFailed(step, cause);
          stepResults.push(failed);
          return {
            triggerId: trigger.id,
            status: "failed",
            stepResults,
            executedCount,
            error: failed.error,
          };
        }
      }

      return {
        triggerId: trigger.id,
        status: "executed",
        stepResults,
        executedCount,
      };
    },
  };
}
```

- [ ] **Step 2: Export the executor from proactive index**

Update `packages/lib/proactive/src/index.ts` by adding:

```ts
export {
  createCompositionExecutor,
  type CompositionExecutionContext,
  type CompositionForgeRequest,
  type CompositionNotification,
  type CompositionSpawnRequest,
} from "./composition-executor.js";
```

- [ ] **Step 3: Run the proactive test to verify it passes**

Run:

```bash
rtk bun test packages/lib/proactive/src/composition-executor.test.ts
```

Expected:

- PASS

- [ ] **Step 4: Run the full proactive package test suite**

Run:

```bash
rtk bun test packages/lib/proactive/src
```

Expected:

- PASS

- [ ] **Step 5: Commit**

Run:

```bash
rtk git add packages/lib/proactive/src/composition-executor.ts packages/lib/proactive/src/index.ts packages/lib/proactive/src/composition-executor.test.ts
rtk git commit -m "feat: add proactive composition executor"
```

### Task 4: Update Docs and Run Final Verification

**Files:**
- Modify: `docs/L2/proactive.md`
- Test: `packages/kernel/core/src/system-signal.test.ts`
- Test: `packages/lib/proactive/src/composition-executor.test.ts`

- [ ] **Step 1: Update the proactive package doc**

Add this section to `docs/L2/proactive.md` after the planner section:

```md
## Composition executor (issue #1300, MVP)

`@koi/proactive` now also exposes an execution layer that consumes
`CompositionPlan` values after planning. The executor is intentionally thin:
it enforces the plan approval gate, executes steps sequentially, and delegates
work into injected runtime seams rather than owning new infrastructure.

### Public API

```typescript
createCompositionExecutor(
  context: CompositionExecutionContext,
): CompositionExecutor
```

Supported MVP step kinds:

- `submit_task`
- `create_schedule`
- `notify_user`

Unsupported in the MVP:

- `spawn_agent`
- `forge_skill`
- `tool_call`

Execution stops on the first unsupported or failed step. No rollback is
attempted in this version; the result reports any successfully executed prefix.
```
```

- [ ] **Step 2: Run targeted verification commands**

Run:

```bash
rtk bun test packages/kernel/core/src/system-signal.test.ts
rtk bun test packages/lib/proactive/src/composition-executor.test.ts
rtk bun test packages/lib/proactive/src
```

Expected:

- PASS on all three commands

- [ ] **Step 3: Run package typechecks**

Run:

```bash
rtk bun run --cwd packages/kernel/core typecheck
rtk bun run --cwd packages/lib/proactive typecheck
```

Expected:

- PASS on both commands

- [ ] **Step 4: Commit**

Run:

```bash
rtk git add docs/L2/proactive.md
rtk git commit -m "docs: describe composition executor mvp"
```

## Self-Review Checklist

Spec coverage:

- Shared L0 contract: Task 1
- L2 execution context: Task 3
- MVP support for `submit_task`, `create_schedule`, `notify_user`: Task 3
- Explicit unsupported handling for `spawn_agent`, `forge_skill`, `tool_call`: Task 2 + Task 3
- Documentation update: Task 4

Placeholder scan:

- No `TODO`, `TBD`, or deferred implementation placeholders remain in tasks
- Every code-changing step includes concrete code
- Every verification step includes exact commands and expected outcomes

Type consistency:

- `CompositionExecutionResult.status` values are consistent across Tasks 1 and 3
- `CompositionExecutionContext` property names match the approved spec
- Unsupported step kinds are handled consistently in tests, implementation, and docs
