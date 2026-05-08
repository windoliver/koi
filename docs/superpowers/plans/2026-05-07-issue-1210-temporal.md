# Issue 1210 Temporal Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the missing workflow and activity runtime inside `@koi/temporal`, including gateway streaming, child-spawn handling, and a non-leaky public API.

**Architecture:** Keep all new work inside `packages/exec/temporal`. Reuse the existing scheduler, error-mapping, and worker-factory surfaces, then add a Temporal sandbox workflow layer plus a host-side activity factory that runs Koi turns through injected runtime dependencies.

**Tech Stack:** Bun, TypeScript, Temporal SDK (`@temporalio/workflow`, `@temporalio/activity`, `@temporalio/worker`), `@koi/core`

---

### Task 1: Restore Types And Public API Surface

**Files:**
- Create: `packages/exec/temporal/src/workflows/signals.ts`
- Modify: `packages/exec/temporal/src/types.ts`
- Modify: `packages/exec/temporal/src/index.ts`
- Test: `packages/exec/temporal/src/__tests__/api-surface.test.ts`

- [ ] **Step 1: Write the failing API-surface test**

```ts
import { describe, expect, test } from "bun:test";
import * as temporal from "../index.js";

describe("@koi/temporal restored API surface", () => {
  test("exports workflow signal constants and activity factory", () => {
    expect(typeof temporal.MESSAGE_SIGNAL_NAME).toBe("string");
    expect(typeof temporal.SHUTDOWN_SIGNAL_NAME).toBe("string");
    expect(typeof temporal.STATE_QUERY_NAME).toBe("string");
    expect(typeof temporal.STATUS_QUERY_NAME).toBe("string");
    expect(typeof temporal.PENDING_COUNT_QUERY_NAME).toBe("string");
    expect(typeof temporal.createActivities).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/exec/temporal/src/__tests__/api-surface.test.ts`
Expected: FAIL because `createActivities` and signal exports do not exist yet.

- [ ] **Step 3: Add the missing types and signal/query module**

```ts
// packages/exec/temporal/src/workflows/signals.ts
import type { AgentStateRefs, IncomingMessage } from "../types.js";

export const MESSAGE_SIGNAL_NAME = "message" as const;
export const SHUTDOWN_SIGNAL_NAME = "shutdown" as const;
export const STATE_QUERY_NAME = "getState" as const;
export const STATUS_QUERY_NAME = "getStatus" as const;
export const PENDING_COUNT_QUERY_NAME = "getPendingCount" as const;

export type AgentActivityStatus = "idle" | "working" | "shutting_down";
export type MessageSignalPayload = IncomingMessage;
export type ShutdownSignalPayload = { readonly reason: string };
export type StateQueryResult = AgentStateRefs;
export type StatusQueryResult = AgentActivityStatus;
export type PendingCountQueryResult = number;
```

```ts
// packages/exec/temporal/src/types.ts
export interface AgentTurnInput {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly message: IncomingMessage;
  readonly stateRefs: AgentStateRefs;
  readonly gatewayUrl: string | undefined;
  readonly nexusApiKey?: string | undefined;
  readonly delegationId?: string | undefined;
}

export interface SpawnChildRequest {
  readonly childAgentId: AgentId;
  readonly childConfig: AgentWorkflowConfig;
}

export interface AgentTurnResult {
  readonly turnId: string;
  readonly blocks: readonly ContentBlock[];
  readonly updatedStateRefs: AgentStateRefs;
  readonly spawnChild: SpawnChildRequest | undefined;
}

export interface WorkerWorkflowConfig extends AgentWorkflowConfig {
  readonly parentAgentId: AgentId;
  readonly nexusApiKey?: string | undefined;
  readonly delegationId?: string | undefined;
}
```

```ts
// packages/exec/temporal/src/index.ts
export {
  type AgentActivityStatus,
  MESSAGE_SIGNAL_NAME,
  type MessageSignalPayload,
  PENDING_COUNT_QUERY_NAME,
  type PendingCountQueryResult,
  SHUTDOWN_SIGNAL_NAME,
  type ShutdownSignalPayload,
  STATE_QUERY_NAME,
  STATUS_QUERY_NAME,
  type StateQueryResult,
  type StatusQueryResult,
} from "./workflows/signals.js";
```

- [ ] **Step 4: Run the API-surface test to verify it passes**

Run: `bun test packages/exec/temporal/src/__tests__/api-surface.test.ts`
Expected: PASS with 1 passing test.

- [ ] **Step 5: Commit the type and export restoration**

```bash
git add \
  packages/exec/temporal/src/workflows/signals.ts \
  packages/exec/temporal/src/types.ts \
  packages/exec/temporal/src/index.ts \
  packages/exec/temporal/src/__tests__/api-surface.test.ts
git commit -m "feat(temporal): restore workflow signals and api types"
```

### Task 2: Restore The Host Activity Factory

**Files:**
- Create: `packages/exec/temporal/src/activities/agent-activity.ts`
- Modify: `packages/exec/temporal/src/index.ts`
- Test: `packages/exec/temporal/src/__tests__/agent-activity.test.ts`

- [ ] **Step 1: Write the failing activity tests**

```ts
import { describe, expect, mock, test } from "bun:test";
import { createActivities } from "../activities/agent-activity.js";

describe("createActivities", () => {
  test("collects text deltas and streams them to the gateway", async () => {
    const sendGatewayFrame = mock(async () => {});
    const runtime = {
      run: async function* () {
        yield { kind: "text_delta", delta: "Hello " };
        yield { kind: "text_delta", delta: "world" };
        yield { kind: "done" };
      },
    };

    const { runAgentTurn } = createActivities({
      engineCache: { getOrCreate: async () => runtime },
      sendGatewayFrame,
      createEngineInput: () => ({ kind: "text", text: "hi" }),
      computeCacheKey: () => ({ manifestHash: "m", forgeGeneration: 1 }),
      getCreateKoiOptions: async () => ({ manifest: {}, adapter: {} }),
    });

    const result = await runAgentTurn({
      agentId: "agent-1" as never,
      sessionId: "session-1" as never,
      message: { id: "m1", senderId: "u1", content: [], timestamp: Date.now() },
      stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
      gatewayUrl: "ws://gateway",
    });

    expect(result.blocks).toEqual([
      { kind: "text", text: "Hello " },
      { kind: "text", text: "world" },
    ]);
    expect(sendGatewayFrame).toHaveBeenCalledTimes(2);
  });

  test("captures spawn_requested and returns spawnChild", async () => {
    const runtime = {
      run: async function* () {
        yield { kind: "spawn_requested", childAgentId: "child-1" };
        yield { kind: "done" };
      },
    };

    const { runAgentTurn } = createActivities({
      engineCache: { getOrCreate: async () => runtime },
      sendGatewayFrame: async () => {},
      createEngineInput: () => ({ kind: "text", text: "hi" }),
      computeCacheKey: () => ({ manifestHash: "m", forgeGeneration: 1 }),
      getCreateKoiOptions: async () => ({ manifest: {}, adapter: {} }),
    });

    const result = await runAgentTurn({
      agentId: "agent-1" as never,
      sessionId: "session-1" as never,
      message: { id: "m1", senderId: "u1", content: [], timestamp: Date.now() },
      stateRefs: { lastTurnId: undefined, turnsProcessed: 1 },
      gatewayUrl: undefined,
    });

    expect(result.spawnChild?.childAgentId).toBe("child-1");
  });
});
```

- [ ] **Step 2: Run the activity tests to verify they fail**

Run: `bun test packages/exec/temporal/src/__tests__/agent-activity.test.ts`
Expected: FAIL because `activities/agent-activity.ts` does not exist yet.

- [ ] **Step 3: Implement the minimal activity factory**

```ts
// packages/exec/temporal/src/activities/agent-activity.ts
import type { ContentBlock, EngineInput } from "@koi/core";
import { ApplicationFailure, heartbeat } from "@temporalio/activity";
import { mapKoiErrorToApplicationFailure } from "../temporal-errors.js";
import type { AgentStateRefs, AgentTurnInput, AgentTurnResult, SpawnChildRequest } from "../types.js";

export interface GatewayStreamFrame {
  readonly kind: "agent:text_delta";
  readonly delta: string;
  readonly sessionId: string;
}

export interface ActivityDeps {
  readonly engineCache: {
    getOrCreate: (
      key: { readonly manifestHash: string; readonly forgeGeneration: number },
      options: unknown,
    ) => Promise<{ run: (input: EngineInput) => AsyncIterable<unknown> }>;
  };
  readonly sendGatewayFrame: (agentId: string, frame: GatewayStreamFrame) => Promise<void>;
  readonly createEngineInput: (input: AgentTurnInput) => EngineInput;
  readonly computeCacheKey: () => { readonly manifestHash: string; readonly forgeGeneration: number };
  readonly getCreateKoiOptions: (agentId: string) => Promise<unknown>;
}

export function createActivities(deps: ActivityDeps) {
  return {
    async runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
      const turnId = `turn:${Date.now()}`;
      const blocks: ContentBlock[] = [];
      let spawnChild: SpawnChildRequest | undefined;
      try {
        const runtime = await deps.engineCache.getOrCreate(
          deps.computeCacheKey(),
          await deps.getCreateKoiOptions(input.agentId),
        );
        let eventCount = 0;
        for await (const event of runtime.run(deps.createEngineInput(input))) {
          const e = event as Record<string, unknown>;
          if (e.kind === "text_delta") {
            const delta = String(e.delta ?? "");
            blocks.push({ kind: "text", text: delta });
            if (input.gatewayUrl !== undefined) {
              await deps.sendGatewayFrame(input.agentId, {
                kind: "agent:text_delta",
                delta,
                sessionId: input.sessionId,
              });
            }
          }
          if (e.kind === "spawn_requested") {
            const childAgentId = e.childAgentId as string;
            spawnChild = {
              childAgentId: childAgentId as never,
              childConfig: {
                agentId: childAgentId as never,
                sessionId: input.sessionId,
                stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
              },
            };
          }
          eventCount++;
          if (eventCount % 10 === 0) heartbeat({ eventCount, turnId });
        }
        const updatedStateRefs: AgentStateRefs = {
          lastTurnId: turnId,
          turnsProcessed: input.stateRefs.turnsProcessed + 1,
        };
        return { turnId, blocks, updatedStateRefs, spawnChild };
      } catch (error: unknown) {
        const payload = mapKoiErrorToApplicationFailure({
          code: "INTERNAL",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
          context: { agentId: input.agentId, sessionId: input.sessionId },
        });
        throw ApplicationFailure.create({
          message: payload.message,
          type: payload.type,
          nonRetryable: payload.nonRetryable,
          details: [...payload.details],
        });
      }
    },
  };
}
```

- [ ] **Step 4: Run the activity tests to verify they pass**

Run: `bun test packages/exec/temporal/src/__tests__/agent-activity.test.ts`
Expected: PASS with 2 passing tests.

- [ ] **Step 5: Commit the activity restoration**

```bash
git add \
  packages/exec/temporal/src/activities/agent-activity.ts \
  packages/exec/temporal/src/index.ts \
  packages/exec/temporal/src/__tests__/agent-activity.test.ts
git commit -m "feat(temporal): restore agent activity factory"
```

### Task 3: Restore The Workflow Sandbox

**Files:**
- Create: `packages/exec/temporal/src/workflows/agent-workflow.ts`
- Test: `packages/exec/temporal/src/__tests__/agent-workflow.test.ts`

- [ ] **Step 1: Write the failing workflow tests**

```ts
import { describe, expect, test } from "bun:test";
import {
  MESSAGE_SIGNAL_NAME,
  PENDING_COUNT_QUERY_NAME,
  SHUTDOWN_SIGNAL_NAME,
  STATE_QUERY_NAME,
  STATUS_QUERY_NAME,
} from "../workflows/signals.js";

describe("agent workflow module", () => {
  test("exports the workflow entry point", async () => {
    const mod = await import("../workflows/agent-workflow.js");
    expect(typeof mod.agentWorkflow).toBe("function");
  });

  test("restored workflow signal names stay stable", () => {
    expect(MESSAGE_SIGNAL_NAME).toBe("message");
    expect(SHUTDOWN_SIGNAL_NAME).toBe("shutdown");
    expect(STATE_QUERY_NAME).toBe("getState");
    expect(STATUS_QUERY_NAME).toBe("getStatus");
    expect(PENDING_COUNT_QUERY_NAME).toBe("getPendingCount");
  });
});
```

- [ ] **Step 2: Run the workflow tests to verify they fail**

Run: `bun test packages/exec/temporal/src/__tests__/agent-workflow.test.ts`
Expected: FAIL because `workflows/agent-workflow.ts` does not exist yet.

- [ ] **Step 3: Implement the minimal workflow shell with queueing and child spawn orchestration**

```ts
// packages/exec/temporal/src/workflows/agent-workflow.ts
import {
  condition,
  defineQuery,
  defineSignal,
  executeChild,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type { AgentTurnResult, AgentWorkflowConfig, IncomingMessage, WorkerWorkflowConfig } from "../types.js";
import {
  MESSAGE_SIGNAL_NAME,
  PENDING_COUNT_QUERY_NAME,
  SHUTDOWN_SIGNAL_NAME,
  STATE_QUERY_NAME,
  STATUS_QUERY_NAME,
  type AgentActivityStatus,
} from "./signals.js";

const messageSignal = defineSignal<[IncomingMessage]>(MESSAGE_SIGNAL_NAME);
const shutdownSignal = defineSignal<[ { readonly reason: string } ]>(SHUTDOWN_SIGNAL_NAME);
const stateQuery = defineQuery<AgentWorkflowConfig["stateRefs"]>(STATE_QUERY_NAME);
const statusQuery = defineQuery<AgentActivityStatus>(STATUS_QUERY_NAME);
const pendingCountQuery = defineQuery<number>(PENDING_COUNT_QUERY_NAME);

const { runAgentTurn } = proxyActivities<{ runAgentTurn: (input: unknown) => Promise<AgentTurnResult> }>({
  startToCloseTimeout: "10 minutes",
});

export async function agentWorkflow(config: AgentWorkflowConfig): Promise<void> {
  const pending: IncomingMessage[] = [];
  let stateRefs = config.stateRefs;
  let status: AgentActivityStatus = "idle";
  let shuttingDown = false;

  if (config.initialMessage) pending.push(config.initialMessage);
  if (config.initialMessages) pending.push(...config.initialMessages);

  setHandler(messageSignal, (message) => {
    pending.push(message);
  });
  setHandler(shutdownSignal, () => {
    shuttingDown = true;
    status = pending.length > 0 ? "working" : "shutting_down";
  });
  setHandler(stateQuery, () => stateRefs);
  setHandler(statusQuery, () => status);
  setHandler(pendingCountQuery, () => pending.length);

  while (!shuttingDown || pending.length > 0) {
    await condition(() => pending.length > 0 || shuttingDown);
    const next = pending.shift();
    if (!next) {
      if (shuttingDown) break;
      continue;
    }
    status = "working";
    const result = await runAgentTurn({
      agentId: config.agentId,
      sessionId: config.sessionId,
      message: next,
      stateRefs,
      gatewayUrl: undefined,
    });
    stateRefs = result.updatedStateRefs;
    if (result.spawnChild) {
      await executeChild(agentWorkflow, {
        args: [result.spawnChild.childConfig as WorkerWorkflowConfig],
        workflowId: `${result.spawnChild.childAgentId}:${Date.now()}`,
      });
    }
    status = shuttingDown ? "shutting_down" : "idle";
  }
}
```

- [ ] **Step 4: Run the workflow tests to verify they pass**

Run: `bun test packages/exec/temporal/src/__tests__/agent-workflow.test.ts`
Expected: PASS with 2 passing tests.

- [ ] **Step 5: Commit the workflow restoration**

```bash
git add \
  packages/exec/temporal/src/workflows/agent-workflow.ts \
  packages/exec/temporal/src/__tests__/agent-workflow.test.ts
git commit -m "feat(temporal): restore agent workflow shell"
```

### Task 4: Wire Integration, Tighten Tests, And Verify No Public Temporal Leakage

**Files:**
- Modify: `packages/exec/temporal/src/index.ts`
- Modify: `packages/exec/temporal/src/__tests__/integration.test.ts`
- Modify: `packages/exec/temporal/package.json`
- Test: `packages/exec/temporal/src/__tests__/smoke.test.ts`
- Test: `packages/exec/temporal/src/__tests__/integration.test.ts`

- [ ] **Step 1: Write the failing integration update**

```ts
test("restored workflow round-trips through Worker + Client", async () => {
  const { NativeConnection, Worker } = await import("@temporalio/worker");
  const { Client, Connection } = await import("@temporalio/client");
  const nativeConn = await NativeConnection.connect({ address: "localhost:7233" });
  const worker = await Worker.create({
    connection: nativeConn,
    taskQueue: "restored-agent-workflow-test",
    workflowsPath: new URL("../workflows/agent-workflow.js", import.meta.url).pathname,
    activities: {
      async runAgentTurn() {
        return {
          turnId: "t1",
          blocks: [{ kind: "text", text: "ok" }],
          updatedStateRefs: { lastTurnId: "t1", turnsProcessed: 1 },
          spawnChild: undefined,
        };
      },
    },
  });
  const workerPromise = worker.run();
  try {
    const clientConn = await Connection.connect({ address: "localhost:7233" });
    const client = new Client({ connection: clientConn });
    const handle = await client.workflow.start("agentWorkflow", {
      taskQueue: "restored-agent-workflow-test",
      workflowId: `agent-workflow-${Date.now()}`,
      args: [{ agentId: "agent-1", sessionId: "s1", stateRefs: { lastTurnId: undefined, turnsProcessed: 0 } }],
    });
    await handle.signal("message", { id: "m1", senderId: "u1", content: [], timestamp: Date.now() });
    await handle.signal("shutdown", { reason: "test" });
    await handle.result();
    await clientConn.close();
  } finally {
    worker.shutdown();
    await workerPromise;
    await nativeConn.close();
  }
}, 60_000);
```

- [ ] **Step 2: Run the focused restored-workflow tests to verify they fail**

Run: `bun test packages/exec/temporal/src/__tests__/api-surface.test.ts packages/exec/temporal/src/__tests__/agent-activity.test.ts packages/exec/temporal/src/__tests__/agent-workflow.test.ts`
Expected: FAIL if any wiring or exports are still incomplete.

- [ ] **Step 3: Complete wiring and add the restored integration coverage**

```ts
// packages/exec/temporal/src/index.ts
export {
  type ActivityDeps,
  createActivities,
  type GatewayStreamFrame,
} from "./activities/agent-activity.js";
```

```json
// packages/exec/temporal/package.json
{
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  }
}
```

```ts
// packages/exec/temporal/src/__tests__/integration.test.ts
// Add one restored-workflow integration block gated by TEMPORAL_INTEGRATION=true
// that uses the new workflow file and a stubbed runAgentTurn activity.
```

- [ ] **Step 4: Run full package verification**

Run: `bun test packages/exec/temporal/src/__tests__/api-surface.test.ts packages/exec/temporal/src/__tests__/agent-activity.test.ts packages/exec/temporal/src/__tests__/agent-workflow.test.ts packages/exec/temporal/src/__tests__/worker-factory.test.ts packages/exec/temporal/src/__tests__/smoke.test.ts`
Expected: PASS with all targeted unit tests green.

Run: `bun run --cwd packages/exec/temporal typecheck`
Expected: PASS with exit code 0 and no leaked-type compile failures.

Optional live verification:
Run: `TEMPORAL_INTEGRATION=true bun test packages/exec/temporal/src/__tests__/integration.test.ts`
Expected: PASS if a Temporal dev server is running locally on `localhost:7233`.

- [ ] **Step 5: Commit the final restored Temporal runtime**

```bash
git add \
  packages/exec/temporal/src/index.ts \
  packages/exec/temporal/src/__tests__/integration.test.ts \
  packages/exec/temporal/src/__tests__/api-surface.test.ts \
  packages/exec/temporal/src/__tests__/agent-activity.test.ts \
  packages/exec/temporal/src/__tests__/agent-workflow.test.ts \
  packages/exec/temporal/src/workflows/agent-workflow.ts \
  packages/exec/temporal/src/workflows/signals.ts \
  packages/exec/temporal/src/activities/agent-activity.ts \
  packages/exec/temporal/src/types.ts
git commit -m "feat(temporal): restore durable agent workflow runtime"
```

## Self-Review

### Spec coverage

- Workflow definitions: covered by Task 3.
- Activity implementations: covered by Task 2.
- Gateway streaming: covered by Task 2.
- Child-spawn handling: covered by Tasks 2 and 3.
- Public API hygiene: covered by Tasks 1 and 4.
- Tests and integration coverage: covered by Tasks 1 through 4.

### Placeholder scan

- No `TBD`, `TODO`, or “implement later” language remains in the executable steps.
- Commands and file paths are explicit for every task.

### Type consistency

- `AgentTurnInput`, `AgentTurnResult`, `SpawnChildRequest`, `WorkerWorkflowConfig`, and the workflow signal constants are introduced in Task 1 and used consistently in later tasks.
