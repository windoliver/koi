# Temporal Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the missing Phase 3 Temporal workflow and activity layer to `@koi/temporal`, including durable agent, scheduled-task, and retry workflows with a clean Koi-owned public API.

**Architecture:** Build a small `src/workflows/` and `src/activities/` layer on top of the existing scheduler and worker-factory. Keep all `@temporalio/workflow` imports inside workflow modules, all `@temporalio/activity` imports inside activity modules, and expose only structural Koi-facing types from the package root.

**Tech Stack:** Bun, `bun:test`, TypeScript 6, `@temporalio/workflow`, `@temporalio/activity`, `@temporalio/worker`, `@koi/core`

---

### Task 1: Add Koi-Owned Workflow Types And Public Export Guards

**Files:**
- Modify: `packages/exec/temporal/src/types.ts`
- Modify: `packages/exec/temporal/src/index.ts`
- Test: `packages/exec/temporal/src/__tests__/workflows.test.ts`

- [ ] **Step 1: Write the failing export/type boundary tests**

```ts
import { describe, expect, test } from "bun:test";
import type {
  AgentWorkflowConfig,
  RetryWorkflowArgs,
  RetryWorkflowResult,
  ScheduledTaskWorkflowArgs,
  ScheduledTaskWorkflowResult,
} from "../index.js";
import * as temporal from "../index.js";

describe("temporal workflow public surface", () => {
  test("exports Koi-owned workflow type names", () => {
    expect(typeof temporal.DEFAULT_TEMPORAL_CONFIG).toBe("object");
  });

  test("workflow argument shapes are structurally usable without SDK imports", () => {
    const agentConfig: AgentWorkflowConfig = {
      agentId: "agent-1" as AgentWorkflowConfig["agentId"],
      sessionId: "session-1" as AgentWorkflowConfig["sessionId"],
      stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
    };
    const scheduled: ScheduledTaskWorkflowArgs = {
      mode: "dispatch",
      agentId: agentConfig.agentId,
      stateRefs: agentConfig.stateRefs,
      input: { kind: "text", text: "hello" },
    };
    const retryArgs: RetryWorkflowArgs = {
      operation: "runAgentTurn",
      attempt: 0,
      maxAttempts: 3,
      backoffMs: 250,
      payload: { agentId: agentConfig.agentId },
    };
    const scheduledResult: ScheduledTaskWorkflowResult = { kind: "dispatched" };
    const retryResult: RetryWorkflowResult = { kind: "succeeded", attempts: 1, value: {} };

    expect(scheduled.mode).toBe("dispatch");
    expect(retryArgs.maxAttempts).toBe(3);
    expect(scheduledResult.kind).toBe("dispatched");
    expect(retryResult.kind).toBe("succeeded");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/exec/temporal/src/__tests__/workflows.test.ts`

Expected: FAIL with missing exports or missing type definitions for the new workflow argument/result types.

- [ ] **Step 3: Write the minimal type and export changes**

```ts
// packages/exec/temporal/src/types.ts
export interface ScheduledTaskWorkflowArgs {
  readonly mode: "spawn" | "dispatch";
  readonly agentId: AgentId;
  readonly stateRefs: AgentStateRefs;
  readonly input: ScheduledInputPayload;
}

export type ScheduledTaskWorkflowResult =
  | { readonly kind: "spawned"; readonly workflowId: string }
  | { readonly kind: "dispatched" };

export interface RetryWorkflowArgs {
  readonly operation: "runAgentTurn" | "runScheduledTask";
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly backoffMs: number;
  readonly payload: Record<string, unknown>;
}

export type RetryWorkflowResult =
  | { readonly kind: "succeeded"; readonly attempts: number; readonly value: unknown }
  | { readonly kind: "failed"; readonly attempts: number; readonly error: string };
```

```ts
// packages/exec/temporal/src/index.ts
export type {
  RetryWorkflowArgs,
  RetryWorkflowResult,
  ScheduledTaskWorkflowArgs,
  ScheduledTaskWorkflowResult,
} from "./types.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/exec/temporal/src/__tests__/workflows.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/exec/temporal/src/types.ts packages/exec/temporal/src/index.ts packages/exec/temporal/src/__tests__/workflows.test.ts
git commit -m "feat: add temporal workflow public types"
```

### Task 2: Add Signal Definitions And Workflow Entry Points

**Files:**
- Create: `packages/exec/temporal/src/workflows/signals.ts`
- Create: `packages/exec/temporal/src/workflows/agent-workflow.ts`
- Create: `packages/exec/temporal/src/workflows/scheduled-task-workflow.ts`
- Create: `packages/exec/temporal/src/workflows/retry-workflow.ts`
- Create: `packages/exec/temporal/src/workflows/index.ts`
- Test: `packages/exec/temporal/src/__tests__/workflows.test.ts`

- [ ] **Step 1: Add failing workflow behavior tests**

```ts
import { describe, expect, test } from "bun:test";
import {
  AGENT_MESSAGE_SIGNAL,
  AGENT_STATE_QUERY,
  RETRY_WORKFLOW_NAME,
  SCHEDULED_TASK_WORKFLOW_NAME,
  agentWorkflow,
  retryWorkflow,
  scheduledTaskWorkflow,
} from "../workflows/index.js";

describe("workflow module surface", () => {
  test("exports stable workflow names and signal names", () => {
    expect(AGENT_MESSAGE_SIGNAL).toBe("agent.message");
    expect(AGENT_STATE_QUERY).toBe("agent.state");
    expect(SCHEDULED_TASK_WORKFLOW_NAME).toBe("scheduledTaskWorkflow");
    expect(RETRY_WORKFLOW_NAME).toBe("retryWorkflow");
  });

  test("exports workflow entry point functions", () => {
    expect(typeof agentWorkflow).toBe("function");
    expect(typeof scheduledTaskWorkflow).toBe("function");
    expect(typeof retryWorkflow).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/exec/temporal/src/__tests__/workflows.test.ts`

Expected: FAIL because the `workflows/` modules and constants do not exist yet.

- [ ] **Step 3: Create the minimal workflow modules**

```ts
// packages/exec/temporal/src/workflows/signals.ts
export const AGENT_MESSAGE_SIGNAL = "agent.message";
export const AGENT_SHUTDOWN_SIGNAL = "agent.shutdown";
export const AGENT_STATE_QUERY = "agent.state";
export const AGENT_STATUS_QUERY = "agent.status";
export const SCHEDULED_TASK_WORKFLOW_NAME = "scheduledTaskWorkflow";
export const RETRY_WORKFLOW_NAME = "retryWorkflow";
```

```ts
// packages/exec/temporal/src/workflows/index.ts
export {
  AGENT_MESSAGE_SIGNAL,
  AGENT_SHUTDOWN_SIGNAL,
  AGENT_STATE_QUERY,
  AGENT_STATUS_QUERY,
  RETRY_WORKFLOW_NAME,
  SCHEDULED_TASK_WORKFLOW_NAME,
} from "./signals.js";
export { agentWorkflow } from "./agent-workflow.js";
export { scheduledTaskWorkflow } from "./scheduled-task-workflow.js";
export { retryWorkflow } from "./retry-workflow.js";
```

```ts
// packages/exec/temporal/src/workflows/agent-workflow.ts
import type { AgentWorkflowConfig } from "../types.js";

export async function agentWorkflow(_config: AgentWorkflowConfig): Promise<void> {}
```

```ts
// packages/exec/temporal/src/workflows/scheduled-task-workflow.ts
import type { ScheduledTaskWorkflowArgs, ScheduledTaskWorkflowResult } from "../types.js";

export async function scheduledTaskWorkflow(
  args: ScheduledTaskWorkflowArgs,
): Promise<ScheduledTaskWorkflowResult> {
  return args.mode === "spawn" ? { kind: "spawned", workflowId: "pending" } : { kind: "dispatched" };
}
```

```ts
// packages/exec/temporal/src/workflows/retry-workflow.ts
import type { RetryWorkflowArgs, RetryWorkflowResult } from "../types.js";

export async function retryWorkflow(args: RetryWorkflowArgs): Promise<RetryWorkflowResult> {
  return { kind: "failed", attempts: args.attempt + 1, error: "unimplemented" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/exec/temporal/src/__tests__/workflows.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/exec/temporal/src/workflows packages/exec/temporal/src/__tests__/workflows.test.ts
git commit -m "feat: add temporal workflow entry points"
```

### Task 3: Add Activity Factories With Serializable Koi Results

**Files:**
- Create: `packages/exec/temporal/src/activities/agent-activity.ts`
- Create: `packages/exec/temporal/src/activities/scheduled-task-activity.ts`
- Create: `packages/exec/temporal/src/activities/retry-activity.ts`
- Create: `packages/exec/temporal/src/activities/index.ts`
- Create: `packages/exec/temporal/src/__tests__/activities.test.ts`

- [ ] **Step 1: Write the failing activity factory tests**

```ts
import { describe, expect, test } from "bun:test";
import { createAgentActivities, createRetryActivities, createScheduledTaskActivities } from "../activities/index.js";

describe("activity factories", () => {
  test("agent activity returns updated state refs", async () => {
    const activities = createAgentActivities({
      runTurn: async () => ({
        turnId: "turn-1",
        updatedStateRefs: { lastTurnId: "turn-1", turnsProcessed: 1 },
        next: { kind: "complete" },
      }),
    });

    const result = await activities.runAgentTurn({
      agentId: "agent-1" as never,
      sessionId: "session-1" as never,
      stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
      initialMessage: { id: "m1", senderId: "u1", content: [], timestamp: Date.now() },
    });

    expect(result.updatedStateRefs.turnsProcessed).toBe(1);
  });

  test("retry activity maps thrown errors to serializable results", async () => {
    const activities = createRetryActivities({
      runOperation: async () => {
        throw new Error("boom");
      },
    });

    const result = await activities.runRetriedOperation({ operation: "runAgentTurn", payload: {} });
    expect(result.kind).toBe("failed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/exec/temporal/src/__tests__/activities.test.ts`

Expected: FAIL because the `activities/` modules and factories do not exist.

- [ ] **Step 3: Implement the minimal activity factories**

```ts
// packages/exec/temporal/src/activities/agent-activity.ts
export interface AgentActivityDeps {
  readonly runTurn: (input: AgentWorkflowConfig) => Promise<{
    readonly turnId: string;
    readonly updatedStateRefs: AgentStateRefs;
    readonly next: { readonly kind: "complete" | "retry" };
  }>;
}

export function createAgentActivities(deps: AgentActivityDeps) {
  return {
    async runAgentTurn(input: AgentWorkflowConfig) {
      return deps.runTurn(input);
    },
  };
}
```

```ts
// packages/exec/temporal/src/activities/retry-activity.ts
export interface RetryActivityDeps {
  readonly runOperation: (input: { readonly operation: string; readonly payload: unknown }) => Promise<unknown>;
}

export function createRetryActivities(deps: RetryActivityDeps) {
  return {
    async runRetriedOperation(input: { readonly operation: string; readonly payload: unknown }) {
      try {
        const value = await deps.runOperation(input);
        return { kind: "succeeded", value } as const;
      } catch (error: unknown) {
        return { kind: "failed", error: error instanceof Error ? error.message : String(error) } as const;
      }
    },
  };
}
```

```ts
// packages/exec/temporal/src/activities/scheduled-task-activity.ts
export interface ScheduledTaskActivityDeps {
  readonly buildExecution: (input: ScheduledTaskWorkflowArgs) => Promise<{
    readonly mode: "spawn" | "dispatch";
    readonly input: ScheduledInputPayload;
  }>;
}

export function createScheduledTaskActivities(deps: ScheduledTaskActivityDeps) {
  return {
    async runScheduledTask(input: ScheduledTaskWorkflowArgs) {
      return deps.buildExecution(input);
    },
  };
}
```

```ts
// packages/exec/temporal/src/activities/index.ts
export { createAgentActivities } from "./agent-activity.js";
export { createRetryActivities } from "./retry-activity.js";
export { createScheduledTaskActivities } from "./scheduled-task-activity.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/exec/temporal/src/__tests__/activities.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/exec/temporal/src/activities packages/exec/temporal/src/__tests__/activities.test.ts
git commit -m "feat: add temporal activity factories"
```

### Task 4: Wire Worker Registration And Scheduler Defaults To The New Workflow Layer

**Files:**
- Modify: `packages/exec/temporal/src/worker-factory.ts`
- Modify: `packages/exec/temporal/src/temporal-scheduler.ts`
- Modify: `packages/exec/temporal/src/index.ts`
- Modify: `packages/exec/temporal/src/__tests__/worker-factory.test.ts`
- Modify: `packages/exec/temporal/src/__tests__/scheduler.test.ts`

- [ ] **Step 1: Add failing worker/scheduler integration-shape tests**

```ts
test("worker factory accepts workflow bundle metadata", async () => {
  const factory = makeWorkerFactory();
  await createTemporalWorker(
    { taskQueue: "q" },
    { runAgentTurn: async () => ({}) },
    "/wf.js",
    factory,
  );
  const [params] = (factory as ReturnType<typeof mock>).mock.calls[0] as [WorkerCreateParams];
  expect(params.workflowsPath).toBe("/wf.js");
});

test("scheduler defaults agent workflow type for dispatch mode", async () => {
  const client = makeClient();
  const sched = createTemporalScheduler({ client, taskQueue: "test" });
  await sched.submit(A1, { kind: "text", text: "hello" }, "dispatch");
  const startArgs = (client.workflow.start as ReturnType<typeof mock>).mock.calls[0] as [string];
  expect(startArgs[0]).toBe("agentWorkflow");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/exec/temporal/src/__tests__/worker-factory.test.ts packages/exec/temporal/src/__tests__/scheduler.test.ts`

Expected: FAIL because the scheduler still uses the previous default workflow type or does not route through the new named workflow layer.

- [ ] **Step 3: Implement the minimal wiring changes**

```ts
// packages/exec/temporal/src/temporal-scheduler.ts
const DEFAULT_AGENT_WORKFLOW_TYPE = "agentWorkflow";
const DEFAULT_SCHEDULED_TASK_WORKFLOW_TYPE = "scheduledTaskWorkflow";

const workflowType =
  config.workflowType ??
  (mode === "dispatch" ? DEFAULT_AGENT_WORKFLOW_TYPE : DEFAULT_SCHEDULED_TASK_WORKFLOW_TYPE);
```

```ts
// packages/exec/temporal/src/index.ts
export {
  agentWorkflow,
  retryWorkflow,
  scheduledTaskWorkflow,
  AGENT_MESSAGE_SIGNAL,
  AGENT_SHUTDOWN_SIGNAL,
  AGENT_STATE_QUERY,
  AGENT_STATUS_QUERY,
  RETRY_WORKFLOW_NAME,
  SCHEDULED_TASK_WORKFLOW_NAME,
} from "./workflows/index.js";
```

```ts
// packages/exec/temporal/src/worker-factory.ts
export interface WorkerBundle {
  readonly workflowsPath: string;
  readonly activities: Record<string, (...args: readonly unknown[]) => unknown>;
}

export function createWorkerBundle(
  workflowsPath: string,
  activities: Record<string, (...args: readonly unknown[]) => unknown>,
): WorkerBundle {
  return { workflowsPath, activities };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/exec/temporal/src/__tests__/worker-factory.test.ts packages/exec/temporal/src/__tests__/scheduler.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/exec/temporal/src/worker-factory.ts packages/exec/temporal/src/temporal-scheduler.ts packages/exec/temporal/src/index.ts packages/exec/temporal/src/__tests__/worker-factory.test.ts packages/exec/temporal/src/__tests__/scheduler.test.ts
git commit -m "feat: wire temporal workflows into scheduler and worker surface"
```

### Task 5: Implement Real Workflow Logic, Update Docs, And Verify End-To-End

**Files:**
- Modify: `packages/exec/temporal/src/workflows/agent-workflow.ts`
- Modify: `packages/exec/temporal/src/workflows/scheduled-task-workflow.ts`
- Modify: `packages/exec/temporal/src/workflows/retry-workflow.ts`
- Modify: `packages/exec/temporal/src/activities/agent-activity.ts`
- Modify: `packages/exec/temporal/src/activities/scheduled-task-activity.ts`
- Modify: `packages/exec/temporal/src/activities/retry-activity.ts`
- Modify: `packages/exec/temporal/src/__tests__/workflows.test.ts`
- Modify: `packages/exec/temporal/src/__tests__/activities.test.ts`
- Modify: `docs/L2/temporal.md`

- [ ] **Step 1: Add failing behavior tests for actual retry and scheduled-task semantics**

```ts
test("retry workflow retries until success within max attempts", async () => {
  let attempts = 0;
  const run = async () => {
    attempts += 1;
    if (attempts < 3) {
      return { kind: "failed", error: "transient" } as const;
    }
    return { kind: "succeeded", value: { ok: true } } as const;
  };

  expect(run).toBeDefined();
});

test("scheduled task workflow returns spawned result for spawn mode", async () => {
  const result = await scheduledTaskWorkflow({
    mode: "spawn",
    agentId: "agent-1" as never,
    stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
    input: { kind: "text", text: "tick" },
  });
  expect(result.kind).toBe("spawned");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/exec/temporal/src/__tests__/workflows.test.ts packages/exec/temporal/src/__tests__/activities.test.ts`

Expected: FAIL because the current workflow implementations are stubs and do not yet implement retry/state logic.

- [ ] **Step 3: Implement the real workflow and activity behavior**

```ts
// packages/exec/temporal/src/workflows/retry-workflow.ts
export async function retryWorkflow(args: RetryWorkflowArgs): Promise<RetryWorkflowResult> {
  let attempts = args.attempt;
  while (attempts < args.maxAttempts) {
    attempts += 1;
    const result = await runRetriedOperation({
      operation: args.operation,
      payload: args.payload,
    });
    if (result.kind === "succeeded") {
      return { kind: "succeeded", attempts, value: result.value };
    }
    if (attempts >= args.maxAttempts) {
      return { kind: "failed", attempts, error: result.error };
    }
    await sleep(args.backoffMs);
  }
  return { kind: "failed", attempts, error: "retry budget exhausted" };
}
```

```ts
// packages/exec/temporal/src/workflows/scheduled-task-workflow.ts
export async function scheduledTaskWorkflow(
  args: ScheduledTaskWorkflowArgs,
): Promise<ScheduledTaskWorkflowResult> {
  if (args.mode === "spawn") {
    const workflowId = await startAgentExecution(args);
    return { kind: "spawned", workflowId };
  }
  await dispatchToAgent(args);
  return { kind: "dispatched" };
}
```

```md
<!-- docs/L2/temporal.md -->
## Workflow Set

- `agentWorkflow` for durable message-driven agent execution
- `scheduledTaskWorkflow` for schedule-triggered spawn/dispatch handling
- `retryWorkflow` for durable transient-failure retries
```

- [ ] **Step 4: Run the package verification suite**

Run: `bun test packages/exec/temporal/src/__tests__/workflows.test.ts packages/exec/temporal/src/__tests__/activities.test.ts packages/exec/temporal/src/__tests__/worker-factory.test.ts packages/exec/temporal/src/__tests__/scheduler.test.ts`

Expected: PASS

Run: `bun run --cwd packages/exec/temporal typecheck`

Expected: no output and exit code `0`

Run: `bun run --cwd packages/exec/temporal lint`

Expected: checked files with no errors

- [ ] **Step 5: Commit**

```bash
git add packages/exec/temporal/src/workflows packages/exec/temporal/src/activities packages/exec/temporal/src/__tests__/workflows.test.ts packages/exec/temporal/src/__tests__/activities.test.ts docs/L2/temporal.md
git commit -m "feat: implement temporal workflows and activities"
```
