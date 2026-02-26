# @koi/orchestrator — DAG-Based Task Board for Multi-Agent Swarms

Persistent, immutable task board coordinator for Koi agents. Provides a DAG-based task board with dependency tracking, concurrent worker spawning, failure/retry handling, cascade detection, and synthesis — enabling a copilot agent to decompose complex work into parallel subtasks executed by worker agents.

---

## Why It Exists

When a copilot agent faces a complex request ("Refactor authentication across 12 files"), it needs to:

- **Decompose** work into a dependency graph of subtasks
- **Dispatch** workers in parallel, respecting dependency order
- **Track** progress with immutable state transitions
- **Handle failures** — retry transient errors, cascade permanent failures to dependents
- **Synthesize** results in topological order for a coherent final answer
- **Enforce budgets** — concurrency limits, time budgets, output size caps

Without this package, every orchestration agent would reinvent DAG scheduling, retry logic, and result aggregation.

---

## Architecture

`@koi/orchestrator` is an **L2 feature package** — it depends only on L0 (`@koi/core`). Zero external dependencies.

```
┌──────────────────────────────────────────────────────────────┐
│  @koi/orchestrator  (L2)                                      │
│                                                                │
│  types.ts             ← Config, SpawnWorkerFn, tool descriptors│
│  board.ts             ← Immutable TaskBoard implementation     │
│  dag.ts               ← Cycle detection + topological sort     │
│  orchestrate-tool.ts  ← add/query/update board actions         │
│  assign-worker-tool.ts← Spawn worker, track assignment         │
│  synthesize-tool.ts   ← Aggregate results in topo order       │
│  review-output-tool.ts← Accept/reject/revise completed work   │
│  checkpoint.ts        ← Serialize/deserialize board snapshots  │
│  config.ts            ← Validate orchestrator config           │
│  provider.ts          ← ComponentProvider for engine wiring    │
│  index.ts             ← Public API surface                     │
│                                                                │
├──────────────────────────────────────────────────────────────  │
│  Dependencies                                                  │
│                                                                │
│  @koi/core  (L0)   TaskBoard, TaskItem, TaskBoardEvent,       │
│                     Result, KoiError, AgentId, TaskItemId      │
└──────────────────────────────────────────────────────────────  ┘
```

---

## How It Works

The orchestrator enables this flow through the L1 runtime:

```
┌──────────────────────────────────────────────────────────────┐
│                   User / Copilot Agent                         │
│  "Break this into tasks, run them, combine results"           │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                  L1: createKoi() Runtime                       │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐ │
│  │ Middleware   │  │ Tool         │  │ Lifecycle Hooks     │ │
│  │ wrapToolCall │──│ Resolution   │  │ onSessionStart/End  │ │
│  │ wrapModel*  │  │ agent.query  │  │ onBeforeTurn/After  │ │
│  └─────────────┘  └──────┬───────┘  └─────────────────────┘ │
└──────────────────────────┼───────────────────────────────────┘
                           │ tool calls routed through middleware
                           ▼
┌──────────────────────────────────────────────────────────────┐
│              L2: @koi/orchestrator Tools                       │
│                                                                │
│  ┌──────────────┐  ┌────────────────┐  ┌──────────────────┐ │
│  │ orchestrate   │  │ assign_worker  │  │ synthesize       │ │
│  │ add/query/    │  │ spawn worker   │  │ aggregate in     │ │
│  │ update tasks  │  │ track status   │  │ topo order       │ │
│  └──────┬───────┘  └───────┬────────┘  └──────────────────┘ │
│         │                  │                                  │
│         ▼                  ▼                                  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              Immutable TaskBoard (DAG)                  │  │
│  │                                                        │  │
│  │    ┌───┐         ┌───┐                                 │  │
│  │    │ A │────────>│ C │──┐                              │  │
│  │    └───┘         └───┘  │     ┌───┐                    │  │
│  │      │                  ├────>│ D │                     │  │
│  │      ▼                  │     └───┘                     │  │
│  │    ┌───┐                │                               │  │
│  │    │ B │────────────────┘                               │  │
│  │    └───┘                                                │  │
│  │                                                        │  │
│  │  Events: task:added -> task:assigned -> task:completed  │  │
│  │          task:failed -> task:retried                    │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
                           │
                           │ spawn()
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                  Worker Agents (parallel)                      │
│                                                                │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐ │
│  │ worker-1  │  │ worker-2  │  │ worker-3  │  │ worker-4  │ │
│  │ Task A    │  │ Task B    │  │ Task C    │  │ Task D    │ │
│  │ done      │  │ done      │  │ failed    │  │ unreachable│ │
│  └───────────┘  └───────────┘  └───────────┘  └───────────┘ │
└──────────────────────────────────────────────────────────────┘
```

---

## The TaskBoard Model

Every mutation returns a **new** board — the original is never modified. This enables safe concurrency, easy snapshotting, and predictable state transitions.

### Task Lifecycle

```
          add()              assign()            complete()
pending ──────> pending ──────> assigned ──────> completed
  (blocked)      (ready)

                               assign()       fail() + retries left
                              ──────> assigned ──────> pending (retry)
                                                         │
                               fail() + no retries left  │
                              ──────> failed <────────────┘
                                        │
                              dependents become "unreachable"
```

### Task States

| State | Meaning | Transitions to |
|-------|---------|----------------|
| `pending` (blocked) | Waiting on unfinished dependencies | `pending` (ready) when deps complete |
| `pending` (ready) | All dependencies completed, eligible for assignment | `assigned` via `assign()` |
| `assigned` | Worker spawned, execution in progress | `completed` or `failed` |
| `completed` | Worker finished successfully, result stored | Terminal |
| `failed` | Worker failed permanently (retries exhausted) | Terminal; dependents become unreachable |

### Board Events

The board emits events through the `onEvent` callback for observability:

| Event | Payload | When |
|-------|---------|------|
| `task:added` | `{ item: TaskItem }` | New task added to board |
| `task:assigned` | `{ taskId, agentId }` | Task assigned to worker |
| `task:completed` | `{ taskId, result }` | Worker finished successfully |
| `task:failed` | `{ taskId, error }` | Worker failed permanently |
| `task:retried` | `{ taskId, retries }` | Transient failure, re-queued for retry |

---

## The 4 Orchestrator Tools

### orchestrate (add / query / update)

The primary board management tool, discriminated by `action` field:

```
orchestrate({ action: "add", tasks: [...] })
    → Adds tasks with dependencies to the board
    → Validates DAG (no cycles), checks dependency existence
    → Returns: "Added N task(s). Ready: M. Total: K."

orchestrate({ action: "query", view: "summary" })
    → Board status overview
    → Returns: "Total: 5 | Ready: 2 | In-progress: 1 | Completed: 1 | Failed: 0 | Blocked: 1 | Unreachable: 0"

orchestrate({ action: "query", view: "ready" })
    → Lists tasks eligible for assignment
    → Views: summary | ready | pending | blocked | in_progress | completed | failed | all

orchestrate({ action: "update", taskId: "x", patch: { priority: 10 } })
    → Updates a pending/assigned task's priority, description, or metadata
    → Returns: "Task x updated: priority=10 [pending]"
```

### assign_worker

Assigns a ready task to a worker and spawns it:

```
assign_worker({ task_id: "a" })
    → Checks concurrency limit
    → Assigns task on board (pending → assigned)
    → Calls spawn() callback with task description + abort signal
    → On success: marks completed, stores result
    → On retryable failure: marks failed, re-queues if retries remain
    → On permanent failure: marks failed, dependents become unreachable
    → On timeout (signal aborted): returns "Orchestration timed out" without spawning
```

### synthesize

Aggregates completed task results in dependency (topological) order:

```
synthesize({ format: "summary" })
    → Collects all completed results
    → Orders by topological sort (dependencies first)
    → Returns formatted sections: "## taskId: description\n<output>"
```

### review_output

Optional verification gate for completed work:

```
review_output({ task_id: "a", verdict: "accept" })
    → Accepts the result (no state change)

review_output({ task_id: "a", verdict: "reject", feedback: "Missing tests" })
    → Fails the task so it can be retried with feedback

review_output({ task_id: "a", verdict: "revise", feedback: "Add error handling" })
    → Same as reject, but semantically "improve" rather than "redo"
```

---

## Configuration

```typescript
interface OrchestratorConfig {
  readonly spawn: SpawnWorkerFn             // Required: how to run a worker
  readonly verify?: VerifyResultFn          // Optional: auto-accept if absent
  readonly onEvent?: (e: TaskBoardEvent) => void  // Optional: observability
  readonly maxConcurrency?: number          // Default: 5
  readonly maxRetries?: number              // Default: 3
  readonly maxOutputPerTask?: number        // Default: 5000 chars
  readonly maxDurationMs?: number           // Default: 1,800,000 (30 min)
}
```

### SpawnWorkerFn

The consumer provides this callback — it defines how workers are created:

```typescript
type SpawnWorkerFn = (request: SpawnWorkerRequest) => Promise<SpawnWorkerResult>;

// Request
interface SpawnWorkerRequest {
  readonly taskId: TaskItemId
  readonly description: string
  readonly agentId?: string
  readonly signal: AbortSignal          // Abort when maxDurationMs exceeded
}

// Result — discriminated union
type SpawnWorkerResult =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly error: KoiError }
```

**Example:** A simple spawn that delegates to a child agent:

```typescript
const config: OrchestratorConfig = {
  spawn: async (req) => {
    try {
      const result = await runWorkerAgent(req.description, { signal: req.signal });
      return { ok: true, output: result };
    } catch (e: unknown) {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: e instanceof Error ? e.message : String(e),
          retryable: true,
        },
      };
    }
  },
  maxConcurrency: 3,
  maxRetries: 2,
  maxDurationMs: 600_000, // 10 minutes
  onEvent: (event) => console.log(`[orch] ${event.kind}`, event),
};
```

---

## Failure Handling

### Retry Flow

```
Worker fails with retryable error
           │
           ▼
    retries < maxRetries?
     ┌──────┴──────┐
     │ YES         │ NO
     ▼             ▼
  task:retried   task:failed
  status→pending status→failed
  retries++      dependents→unreachable
```

### Cascade Failure (Unreachable Detection)

When a task fails permanently, all transitive dependents become **unreachable** — they can never be assigned because their dependency chain includes a failed task.

```
  ┌──────┐     ┌───────┐     ┌────────────┐
  │ root │────>│ child │────>│ grandchild │
  │ FAIL │     │ pend. │     │   pend.    │
  └──────┘     └───────┘     └────────────┘

  root fails permanently
    → child is unreachable (blocked by root)
    → grandchild is unreachable (blocked by root, transitively)

  query(summary) → "Unreachable: 2 | child→blocked by root, grandchild→blocked by root"
```

### Abort Signal (maxDurationMs)

The orchestrator creates an `AbortController` that fires after `maxDurationMs`. When the signal fires, `assign_worker` returns immediately with "Orchestration timed out" **without spawning a worker**:

```
  Time ──────────────────────────────────────>
  │                                           │
  │  assign(a)  assign(b)  assign(c)          │
  │  ✓ spawn    ✓ spawn    ✗ timed out        │
  │                        (signal.aborted)    │
  │                        spawn() NOT called  │
  │                                           │
  0                                     maxDurationMs
```

---

## Wiring into createKoi()

### Option A: Use createOrchestratorProvider (production)

The provider creates tools with `{ name, execute }` shape for the engine's internal tool registry:

```typescript
import { createOrchestratorProvider } from "@koi/orchestrator";
import type { OrchestratorConfig } from "@koi/orchestrator";

const config: OrchestratorConfig = {
  spawn: async (req) => ({ ok: true, output: `done: ${req.description}` }),
  onEvent: (e) => console.log(e.kind),
};

const runtime = await createKoi({
  manifest: { name: "my-copilot", version: "0.1.0", model: { name: "..." } },
  adapter,
  providers: [createOrchestratorProvider(config)],
});
```

### Option B: Manual Tool wiring (testing / custom schemas)

For E2E tests or custom input schemas, create proper `Tool` objects wrapping the execute functions:

```typescript
import {
  createTaskBoard,
  executeOrchestrate,
  executeAssignWorker,
  executeSynthesize,
} from "@koi/orchestrator";
import type { BoardHolder, OrchestratorConfig } from "@koi/orchestrator";
import { toolToken } from "@koi/core/ecs";
import type { Tool, ComponentProvider } from "@koi/core";

// Mutable holder for the current immutable board
let board = createTaskBoard({ maxRetries: 3, onEvent: (e) => console.log(e) });
const holder: BoardHolder = {
  getBoard: () => board,
  setBoard: (b) => { board = b; },
};

const config: OrchestratorConfig = { spawn: mySpawnFn };
const signal = new AbortController().signal;

const tools: Tool[] = [
  {
    descriptor: {
      name: "orchestrate",
      description: "Manage task board",
      inputSchema: { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
    },
    trustTier: "sandbox",
    execute: async (args) => executeOrchestrate(args, holder),
  },
  {
    descriptor: {
      name: "assign_worker",
      description: "Assign a ready task",
      inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] },
    },
    trustTier: "sandbox",
    execute: async (args) => executeAssignWorker(args, holder, config, signal),
  },
];

const provider: ComponentProvider = {
  name: "orchestrator-tools",
  attach: async () => {
    const components = new Map<string, unknown>();
    for (const tool of tools) {
      components.set(toolToken(tool.descriptor.name), tool);
    }
    return components;
  },
};
```

---

## DAG Utilities

### Cycle Detection

```typescript
import { detectCycle } from "@koi/orchestrator";

// Returns undefined if no cycle, or the cycle path as TaskItemId[]
const cycle = detectCycle(items, ["dep1", "dep2"], newTaskId);
if (cycle !== undefined) {
  console.log(`Cycle: ${cycle.join(" → ")}`);
}
```

### Topological Sort

```typescript
import { topologicalSort } from "@koi/orchestrator";

// Returns TaskItemId[] in dependency order (roots first)
const sorted = topologicalSort(items);
```

---

## Checkpointing

Serialize and restore board state for persistence or handoff:

```typescript
import { serializeBoard, deserializeBoard, createTaskBoard } from "@koi/orchestrator";

// Save
const snapshot = serializeBoard(board);
const json = JSON.stringify(snapshot);

// Restore
const restored = createTaskBoard({ maxRetries: 3 }, JSON.parse(json));
```

The snapshot captures all task items and completed results — enough to reconstruct the full board state including dependency relationships, retry counts, and assignment status.

---

## API Reference

### Factory Functions

| Function | Returns | Description |
|----------|---------|-------------|
| `createTaskBoard(config?, snapshot?)` | `TaskBoard` | Creates an immutable task board |
| `createOrchestratorProvider(config)` | `ComponentProvider` | Wires 4 tools into createKoi |
| `validateOrchestratorConfig(raw)` | `Result<OrchestratorConfig, KoiError>` | Schema validation |

### Tool Executors

| Function | Signature | Description |
|----------|-----------|-------------|
| `executeOrchestrate(input, holder)` | `(unknown, BoardHolder) → string` | Board CRUD (add/query/update) |
| `executeAssignWorker(input, holder, config, signal)` | `(unknown, BoardHolder, OrchestratorConfig, AbortSignal) → Promise<string>` | Spawn worker for a task |
| `executeSynthesize(input, holder, maxOutput?)` | `(unknown, BoardHolder, number?) → string` | Aggregate completed results |
| `executeReviewOutput(input, holder)` | `(unknown, BoardHolder) → string` | Accept/reject/revise a result |

### DAG Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `detectCycle(items, deps, newId)` | `→ TaskItemId[] \| undefined` | Returns cycle path or undefined |
| `topologicalSort(items)` | `→ TaskItemId[]` | Kahn's algorithm, roots first |

### Checkpoint Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `serializeBoard(board)` | `→ TaskBoardSnapshot` | Extract items + results |
| `deserializeBoard(snapshot)` | `→ { items, results }` | Parse for `createTaskBoard` |

### Types

| Type | Description |
|------|-------------|
| `OrchestratorConfig` | Spawn fn, concurrency, retries, timeouts, events |
| `SpawnWorkerFn` | `(SpawnWorkerRequest) → Promise<SpawnWorkerResult>` |
| `SpawnWorkerRequest` | Task ID, description, agent ID, abort signal |
| `SpawnWorkerResult` | `{ ok: true, output }` or `{ ok: false, error }` |
| `VerifyResultFn` | Optional gate: `(taskId, output) → { verdict, feedback? }` |
| `BoardHolder` | Mutable reference to the current immutable board |

### Tool Descriptors (constants)

| Constant | Tool Name |
|----------|-----------|
| `ORCHESTRATE_TOOL_DESCRIPTOR` | `orchestrate` |
| `ASSIGN_WORKER_TOOL_DESCRIPTOR` | `assign_worker` |
| `REVIEW_OUTPUT_TOOL_DESCRIPTOR` | `review_output` |
| `SYNTHESIZE_TOOL_DESCRIPTOR` | `synthesize` |

---

## Layer Compliance

```
L0  @koi/core ─────────────────────────────────────────────┐
    TaskBoard, TaskItem, TaskItemId, TaskBoardEvent,        │
    TaskBoardConfig, Result, KoiError, AgentId              │
                                                            ▼
L2  @koi/orchestrator <────────────────────────────────────┘
    imports from L0 only
    x never imports @koi/engine (L1)
    x never imports peer L2 packages
    x zero external dependencies
    ~ package.json: { "dependencies": { "@koi/core": "workspace:*" } }
```
