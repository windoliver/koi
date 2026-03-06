# @koi/long-running — Multi-Session Agent Harness with Delegation

State manager for agents that operate over hours or days across multiple sessions. Tracks task progress, bridges context between sessions, auto-dispatches spawn tasks to worker agents, reconciles external state, and persists engine state at meaningful boundaries — enabling an agent to manage complex multi-agent workflows end-to-end.

---

## Why It Exists

Single-session agents lose all context when a session ends. Crash recovery (`SessionPersistence`) restores opaque engine state, but it knows nothing about _what the agent was doing_ — which tasks are done, what was learned, or what to work on next.

Before the delegation consolidation (#860), multi-agent dispatch was split across 4 packages (`orchestrator`, `parallel-minions`, `task-spawn`, `long-running`) with 11 overlapping tools. This created confusion about which package to use and made it impossible to combine features.

`@koi/long-running` now serves as the **single coordination harness** for multi-session agents:

- **Task tracking** — immutable DAG-based task board with dependency ordering
- **Delegation bridge** — auto-dispatches `delegation: "spawn"` tasks to worker agents
- **Reconciler hook** — external reconciliation (cancel/update/add tasks) at configurable cadence
- **Context bridging** — structured resume prompts from summaries and artifacts
- **Batch execution** — concurrent dispatch with lane-based concurrency limits
- **Periodic state saves** — engine state persisted every N turns for crash recovery
- **7 tools, clear progression** — plan -> dispatch (auto) -> review -> synthesize

---

## What This Enables

### Unified Multi-Agent Orchestration

```
Agent creates a plan with delegation hints:
  plan_autonomous → [
    { id: "research",  delegation: "spawn", agentType: "researcher" },
    { id: "code",      delegation: "spawn", agentType: "coder", deps: ["research"] },
    { id: "review",    delegation: "self",  deps: ["code"] },
  ]

Delegation bridge auto-dispatches:
  1. "research" is ready + spawn → assign → acquire semaphore → spawn worker
  2. Worker completes → bridge completes task → cascade check
  3. "code" is now ready (dep met) → auto-dispatch to coder worker
  4. "code" completes → "review" is ready but delegation: "self" → agent handles it
  5. Agent uses task_review + task_synthesize to merge results
```

### External Reconciliation

```
Reconciler checks external state every N turns:
  - GitHub PR merged → cancel "fix-bug" task (no longer needed)
  - New requirement discovered → add "update-docs" task
  - Scope changed → update "research" description

Harness applies changes immutably, agent sees updated board.
```

### Multi-Session Continuity

```
Session 1                    Session 2                    Session 3
─────────────────────────    ─────────────────────────    ──────────────
start(plan)                  resume()                     resume()
  bridge dispatches spawn      bridge dispatches spawn      all tasks done
  tasks automatically          tasks automatically          task_synthesize
  engine state saved @5,10   completeTask("task-2")       → final output
  completeTask("task-1")
pause(sessionResult)         pause(sessionResult)
```

---

## Architecture

`@koi/long-running` is an **L2 feature package** — depends on L0 (`@koi/core`) and L0u (`@koi/task-board`).

```
┌──────────────────────────────────────────────────────────────────┐
│  @koi/long-running  (L2)                                          │
│                                                                    │
│  Core:                                                             │
│    types.ts              ← Config, interfaces                      │
│    harness.ts            ← Factory + state machine                 │
│    context-bridge.ts     ← Resume context from snapshots           │
│    checkpoint-policy.ts  ← Engine state save timing                │
│                                                                    │
│  Delegation (NEW — #860):                                          │
│    delegation-bridge.ts  ← Auto-dispatch spawn tasks via SpawnFn   │
│    lane-semaphore.ts     ← Per-agent-type concurrency limits       │
│    semaphore.ts          ← FIFO counting semaphore                 │
│    reconciler-hook.ts    ← External reconciliation with timeout    │
│                                                                    │
│  Tools:                                                            │
│    task-tools.ts         ← task_complete, task_update, task_status, │
│                            task_review, task_synthesize             │
│    plan-autonomous-tool.ts ← plan_autonomous                       │
│                                                                    │
│  Middleware:                                                       │
│    inbox-middleware.ts      ← Inbound message handling              │
│    checkpoint-middleware.ts ← Periodic state saves                  │
│    thread-compactor.ts     ← Context window management             │
│                                                                    │
├──────────────────────────────────────────────────────────────────  │
│  Dependencies                                                      │
│    @koi/core  (L0)      types, branded IDs                         │
│    @koi/task-board (L0u) board, DAG, helpers                       │
└──────────────────────────────────────────────────────────────────  ┘
```

---

## Tool Surface (7 tools)

| Tool | Phase | Description |
|------|-------|-------------|
| `plan_autonomous` | Plan | Create a DAG plan with delegation hints (`"spawn"` or `"self"`) |
| `task_complete` | Execute | Mark a task done with output |
| `task_update` | Execute | Revise a task's description |
| `task_status` | Execute | Check current board state |
| `task_review` | Review | Accept, reject, or revise a completed task's output |
| `task_synthesize` | Synthesize | Merge all results in topological (dependency) order |
| `task` | Dispatch | Single-task delegation (from `@koi/task-spawn`, unchanged) |

Clear progression: **plan -> dispatch (auto) -> review -> synthesize**.

---

## Delegation Bridge

The bridge implements the **Symphony single-authority + claimed-set** pattern for auto-dispatching spawn tasks.

### How It Works

```
bridge.dispatchReady(board)
  │
  ├── Scan board.ready() for delegation === "spawn" tasks
  │
  ├── For each ready spawn task:
  │   1. Claim: board.assign(taskId, agentId) — prevents duplicate dispatch
  │   2. Build upstream context from completed dependencies
  │   3. Acquire semaphore (global + per-lane concurrency)
  │   4. Spawn worker with DEFERRED delivery policy
  │   5. On success: board.complete() → release semaphore
  │   6. On clean failure: board.fail(retryable: true) → immediate retry
  │   7. On abnormal failure: board.fail() + exponential backoff
  │
  └── Cascade: after any completion, re-scan for newly unblocked tasks
```

### Configuration

```typescript
interface DelegationBridgeConfig {
  readonly spawn: SpawnFn;                              // Required — how to spawn workers
  readonly deliveryPolicy?: DeliveryPolicy;             // Default: { kind: "deferred" }
  readonly maxConcurrency?: number;                     // Default: 5
  readonly laneConcurrency?: ReadonlyMap<string, number>; // Per-agentType limits
  readonly maxOutputPerTask?: number;                   // Default: 5000 chars
  readonly maxUpstreamContextPerTask?: number;          // Default: 2000 chars
  readonly onTaskDispatched?: (taskId: TaskItemId) => void;
  readonly onTaskCompleted?: (taskId: TaskItemId) => void;
}
```

### Retry Strategy (Dual)

| Failure type | Behavior |
|-------------|----------|
| Clean failure (worker returns `{ ok: false }`) | `board.fail(retryable: true)` — immediate retry if retries < maxRetries |
| Abnormal failure (spawn throws/timeout) | `board.fail()` + exponential backoff: `min(10s * 2^(retries-1), 5min)` |

### Lane Semaphore

Per-agent-type concurrency limits prevent one type of worker from consuming all slots:

```typescript
const bridge = createDelegationBridge({
  spawn,
  maxConcurrency: 10,
  laneConcurrency: new Map([
    ["researcher", 3],  // Max 3 concurrent researcher workers
    ["coder", 5],       // Max 5 concurrent coder workers
  ]),
});
```

---

## Reconciler Hook

Optional external reconciliation that checks outside state at configurable cadence.

### How It Works

```
Every N turns (configurable):
  reconciler.check(boardSnapshot)
    → returns TaskReconcileAction[]
    → apply actions in order: cancel > update > add
    → return updated board

On timeout (default 5s) or error:
  → proceed without changes (fail-open for liveness)
```

### Actions

| Action | Effect |
|--------|--------|
| `{ kind: "cancel", taskId, reason }` | Marks task as failed with reason |
| `{ kind: "update", taskId, description }` | Updates task description |
| `{ kind: "add", task }` | Adds a new task to the board |

### Configuration

```typescript
const hook = createReconcilerHook({
  reconciler: {
    check: async (snapshot) => {
      // Query external state (GitHub, Jira, etc.)
      return [{ kind: "cancel", taskId: taskItemId("old-task"), reason: "PR already merged" }];
    },
  },
  intervalTurns: 5,  // Check every 5 turns (default)
  timeoutMs: 5000,   // Timeout protection (default)
});
```

---

## Multi-Session Lifecycle

### Start -> Pause -> Resume Cycle

```
Session 1                    Session 2                    Session 3
─────────────────────────    ─────────────────────────    ──────────────
start(plan)                  resume()                     resume()
  │                            │                            │
  │ engine runs with           │ engine resumes with        │ engine resumes
  │ harness middleware         │ context bridge OR          │ ...
  │                            │ engine state recovery      │
  │ onAfterTurn:               │                            │
  │   save engine state @5,10  │ completeTask("task-2")     │ completeTask("task-3")
  │                            │                            │  → all done!
  │ completeTask("task-1")     │                            │  → phase = completed
  │                            │                            │
pause(sessionResult)         pause(sessionResult)
```

### Resume Strategy

1. **Engine state recovery** (hot path) — loads `SessionRecord.lastEngineState`
2. **Context bridge fallback** (cold path) — builds `InboundMessage[]` from task board, summaries, artifacts. Messages marked `pinned: true` to survive compaction.

---

## Configuration

```typescript
interface LongRunningConfig {
  readonly harnessId: HarnessId;
  readonly agentId: AgentId;
  readonly harnessStore: HarnessSnapshotStore;
  readonly sessionPersistence: SessionPersistence;
  readonly softCheckpointInterval?: number;     // Default: 5 turns
  readonly maxKeyArtifacts?: number;            // Default: 10
  readonly maxContextTokens?: number;           // Default: 3000
  readonly artifactToolNames?: readonly string[];
  readonly pruningPolicy?: PruningPolicy;
  readonly saveState?: SaveStateCallback;
  readonly spawn?: SpawnFn;                     // Enables delegation bridge
  readonly reconciler?: TaskReconciler;         // Enables reconciler hook
  readonly reconcileIntervalTurns?: number;
  readonly reconcileTimeoutMs?: number;
}
```

---

## Examples

### With Delegation Bridge

```typescript
import { createTaskBoard } from "@koi/task-board";
import { createDelegationBridge } from "@koi/long-running";
import { taskItemId } from "@koi/core";

const board = createTaskBoard({ maxRetries: 3 });
const result = board.addAll([
  { id: taskItemId("research"), description: "Research topic", dependencies: [], delegation: "spawn", agentType: "researcher" },
  { id: taskItemId("write"), description: "Write report", dependencies: [taskItemId("research")], delegation: "self" },
]);

if (result.ok) {
  const bridge = createDelegationBridge({
    spawn: async (req) => {
      // Dispatch to worker agent
      return { ok: true, output: "Research complete." };
    },
    maxConcurrency: 5,
    laneConcurrency: new Map([["researcher", 2]]),
  });

  const updatedBoard = await bridge.dispatchReady(result.value);
  // "research" auto-dispatched and completed
  // "write" now ready but delegation: "self" — handled by agent
}
```

### With Reconciler

```typescript
import { createReconcilerHook } from "@koi/long-running";

const hook = createReconcilerHook({
  reconciler: {
    check: async (snapshot) => {
      const prMerged = await checkGitHubPR("fix-123");
      if (prMerged) {
        return [{ kind: "cancel", taskId: taskItemId("fix-123"), reason: "PR already merged" }];
      }
      return [];
    },
  },
  intervalTurns: 3,
});

if (hook.shouldCheck(turnCount)) {
  board = await hook.reconcile(board);
}
```

### Full Pipeline (createKoi)

```typescript
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createTaskTools } from "@koi/long-running";
import { createTaskBoard } from "@koi/task-board";

const board = createTaskBoard({ maxRetries: 3 });
const tools = createTaskTools({ board, agentId: agentId("orchestrator") });

const runtime = await createKoi({
  manifest: { name: "orchestrator", version: "0.0.1", model: { name: "claude-haiku" } },
  adapter: createLoopAdapter({ modelCall, maxTurns: 10 }),
  tools: tools.descriptors,
});

for await (const event of runtime.run({ kind: "text", text: "Plan and execute the task." })) {
  // Agent uses plan_autonomous, task_complete, task_review, task_synthesize
}
```

---

## Migration from orchestrator / parallel-minions

| Before (4 packages, 11 tools) | After (2 packages, 7 tools) |
|---|---|
| `@koi/orchestrator` — `orchestrate`, `assign_worker`, `review_output`, `synthesize` | `@koi/long-running` — `plan_autonomous`, `task_review`, `task_synthesize` |
| `@koi/parallel-minions` — `parallel_task` | Delegation bridge auto-dispatches (no tool needed) |
| `@koi/long-running` — `task_complete`, `task_update`, `task_status` | Unchanged |
| `@koi/task-spawn` — `task` | Unchanged |

Key changes:
- **Board extracted** to `@koi/task-board` (L0u) — reusable by any package
- **Spawn dispatch is automatic** via delegation bridge — no tool call needed
- **Concurrency control** via lane semaphore (ported from parallel-minions)
- **External reconciliation** via reconciler hook (new capability)
- **`delegation` field on TaskItem** hints whether task is self-handled or spawned

---

## API Reference

### Factory Functions

| Function | Returns | Description |
|----------|---------|-------------|
| `createLongRunningHarness(config)` | `LongRunningHarness` | Multi-session harness with full lifecycle |
| `createDelegationBridge(config)` | `DelegationBridge` | Auto-dispatch spawn tasks |
| `createReconcilerHook(config)` | `ReconcilerHook` | Cadence-gated external reconciliation |
| `createTaskTools(config)` | Task tool descriptors | All 5 task tools for agent use |
| `createAutonomousProvider(config)` | `ComponentProvider` | Registers tools + middleware on agent |

### DelegationBridge Methods

| Method | Description |
|--------|-------------|
| `dispatchReady(board)` | Scan and dispatch ready spawn tasks, returns updated board |
| `abort()` | Abort all in-flight spawns |
| `inFlightCount()` | Number of currently in-flight spawns |

### ReconcilerHook Methods

| Method | Description |
|--------|-------------|
| `shouldCheck(turnCount)` | Whether to reconcile at this turn |
| `reconcile(board)` | Run reconciler, apply actions, return updated board |

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────────────┐
    TaskBoard, TaskItem, TaskItemId, TaskResult, SpawnFn,        │
    DeliveryPolicy, TaskReconciler, TaskReconcileAction,         │
    Result, KoiError, KoiMiddleware, AgentId                     │
                                                                  │
L0u @koi/task-board ─────────────────────────────────────────────┤
    createTaskBoard, formatUpstreamContext, topologicalSort       │
                                                                  ▼
L2  @koi/long-running <──────────────────────────────────────────┘
    imports from L0 and L0u only
    x never imports @koi/engine (L1)
    x never imports peer L2 packages
    x zero external dependencies
```
