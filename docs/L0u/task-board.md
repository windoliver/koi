# @koi/task-board — Immutable TaskBoard with DAG Validation (L0u)

Pure, immutable task board with 5-state lifecycle, cycle detection, topological sort, eager unreachable tracking, and serialization helpers.

---

## Why It Exists

Multiple delegation packages (long-running, task-spawn) need an immutable DAG-based task board to plan, track, and order tasks. `@koi/task-board` provides a standalone L0u utility that any L1 or L2 package can import without pulling in scheduling logic.

---

## What It Provides

| Export | Purpose |
|--------|---------|
| `createTaskBoard(config?, snapshot?)` | Factory — returns an immutable `TaskBoard` with all operations |
| `detectCycle(items, deps, newId)` | Checks whether adding a node would create a cycle in the DAG |
| `topologicalSort(items)` | Returns tasks in dependency order — O(V+E) with reverse adjacency map |
| `snapshotToItemsMap(board)` | Converts `board.all()` to `Map<TaskItemId, Task>` for sort input |
| `formatUpstreamContext(results, maxChars)` | Formats completed upstream results as a context block for workers |
| `serializeBoard(board)` / `deserializeBoard(snapshot)` | Snapshot round-trip for persistence |

---

## Architecture

```
L0  @koi/core ──────────────────────────────────────────────────────┐
    Task, TaskStatus, TaskBoard, TaskInput, TaskItemId, TaskResult,  │
    TaskBoardSnapshot, TaskBoardConfig, TaskBoardEvent,              │
    VALID_TASK_TRANSITIONS, isTerminalTaskStatus, isValidTransition, │
    Result, KoiError, AgentId                                        │
                                                                      ▼
L0u @koi/task-board <────────────────────────────────────────────────┘
    imports from L0 only
    × zero external dependencies
    ~ package.json: { "dependencies": { "@koi/core": "workspace:*" } }
```

### Module Map

```
src/
  board.ts          Immutable TaskBoard implementation (~380 LOC)
  dag.ts            detectCycle + topologicalSort (~115 LOC)
  helpers.ts        snapshotToItemsMap, formatUpstreamContext, serialize/deserialize
  index.ts          Public exports
```

---

## Task Domain Model

### TaskStatus — 5-State Lifecycle

```
pending → in_progress → completed
                      → failed
                      → killed
pending → killed
```

| Status | Meaning | Terminal? |
|--------|---------|-----------|
| `pending` | Waiting for dependencies or assignment | No |
| `in_progress` | Assigned to an agent and running | No |
| `completed` | Finished successfully | Yes |
| `failed` | Errored (potentially retried first) | Yes |
| `killed` | Externally cancelled (never retryable) | Yes |

Key distinction: `failed` = task attempted and errored. `killed` = externally cancelled. These have different retry/recovery semantics.

### Task Fields

```typescript
interface Task {
  readonly id: TaskItemId;
  readonly subject: string;            // Short title for lists/dashboards
  readonly description: string;        // Full task spec
  readonly dependencies: readonly TaskItemId[];
  readonly status: TaskStatus;
  readonly assignedTo?: AgentId;       // Branded AgentId, set by assign()
  readonly error?: KoiError;
  readonly metadata?: Record<string, unknown>;
  readonly createdAt: number;          // Unix timestamp ms
  readonly updatedAt: number;          // Unix timestamp ms
}
```

### Scheduling Hints (separate type)

Scheduling concerns (priority, retries, delegation) are separated into `TaskSchedulingHints`, owned by scheduler consumers — not baked into the core task type.

```typescript
interface TaskSchedulingHints {
  readonly priority?: number;
  readonly maxRetries?: number;
  readonly retries?: number;
  readonly delegation?: "self" | "spawn";
  readonly agentType?: string;
}
```

---

## TaskBoard API

All mutations return `Result<TaskBoard, KoiError>` — a new immutable board on success, or an error. The original board is never mutated.

| Method | Signature | Description |
|--------|-----------|-------------|
| `add(input)` | `(TaskInput) -> Result<TaskBoard>` | Add a task; rejects duplicates and cycles |
| `addAll(inputs)` | `(TaskInput[]) -> Result<TaskBoard>` | Batch add with cycle detection |
| `assign(id, agentId)` | `(TaskItemId, AgentId) -> Result<TaskBoard>` | Claim a task (pending → in_progress) |
| `complete(id, result)` | `(TaskItemId, TaskResult) -> Result<TaskBoard>` | Mark done (in_progress → completed) |
| `fail(id, error)` | `(TaskItemId, KoiError) -> Result<TaskBoard>` | Fail with retry logic |
| `kill(id)` | `(TaskItemId) -> Result<TaskBoard>` | Cancel (pending/in_progress → killed) |
| `update(id, patch)` | `(TaskItemId, TaskPatch) -> Result<TaskBoard>` | Update subject/description/metadata |
| `get(id)` | `(TaskItemId) -> Task \| undefined` | Look up a task |
| `all()` | `() -> readonly Task[]` | All tasks |
| `ready()` | `() -> readonly Task[]` | Pending tasks with all deps completed |
| `blocked()` | `() -> readonly Task[]` | Pending tasks with unmet deps |
| `inProgress()` | `() -> readonly Task[]` | Tasks currently being worked on |
| `killed()` | `() -> readonly Task[]` | Killed tasks |
| `unreachable()` | `() -> readonly Task[]` | Pending tasks blocked by failed/killed deps (O(1)) |
| `dependentsOf(id)` | `(TaskItemId) -> readonly Task[]` | Direct dependents of a task |

---

## Events

The board emits events via `config.onEvent`. Consumer errors are caught and swallowed — mutations never fail due to event handlers.

| Event | When |
|-------|------|
| `task:added` | Task added to board |
| `task:assigned` | Task assigned to agent |
| `task:completed` | Task completed with result |
| `task:failed` | Task failed (terminal) |
| `task:retried` | Task auto-retried (back to pending) |
| `task:killed` | Task externally cancelled |
| `task:unreachable` | Downstream task became unreachable due to failed/killed dependency |

The `task:unreachable` event includes `blockedBy` — the ID of the task that caused the unreachability. Consumers decide how to handle orphaned tasks (the board doesn't auto-cascade).

---

## DAG Functions

### detectCycle

DFS-based. Checks if adding a task with given dependencies would create a cycle. Returns the cycle path for error messages.

### topologicalSort

Kahn's algorithm. Returns tasks in dependency-first order. O(V+E).

---

## Performance

- **Unreachable tracking**: Eager `Set<TaskItemId>` maintained incrementally on `fail()`/`kill()`. The `unreachable()` query is O(k) where k = unreachable count, not O(V+E).
- **Copy-on-write**: Each mutation copies the full `Map<TaskItemId, Task>`. Fine for boards with <1000 tasks (~20KB per copy).
- **Event safety**: `onEvent` wrapped in try/catch — consumer bugs cannot crash board mutations.

---

## Examples

### Create and Populate

```typescript
import { createTaskBoard } from "@koi/task-board";
import { taskItemId } from "@koi/core";

const board = createTaskBoard({ maxRetries: 3 });

const result = board.addAll([
  { id: taskItemId("research"), subject: "Research", description: "Research topic", dependencies: [] },
  { id: taskItemId("write"), subject: "Write", description: "Write report", dependencies: [taskItemId("research")] },
]);

if (result.ok) {
  const ready = result.value.ready(); // ["research"] — no unmet deps
}
```

### Kill and Check Unreachable

```typescript
const r = board.kill(taskItemId("research"));
if (r.ok) {
  r.value.unreachable(); // ["write"] — blocked by killed dep
}
```

### Serialize / Deserialize

```typescript
import { serializeBoard, deserializeBoard } from "@koi/task-board";

const snapshot = serializeBoard(board);     // { items, results }
const restored = deserializeBoard(snapshot); // Same board state
```
