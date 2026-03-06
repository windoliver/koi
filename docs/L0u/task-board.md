# @koi/task-board — Immutable TaskBoard with DAG Validation (L0u)

Pure, immutable task board with cycle detection, topological sort, and serialization helpers. Extracted from the former `@koi/orchestrator` as a reusable foundation for all delegation packages.

---

## Why It Exists

Multiple delegation packages (long-running, task-spawn) need an immutable DAG-based task board to plan, track, and order tasks. Before this package, the board implementation lived inside `@koi/orchestrator`, forcing a heavyweight dependency for any package that just needed task tracking.

`@koi/task-board` extracts the board into a standalone L0u utility that any L1 or L2 package can import without pulling in scheduling logic.

---

## What It Provides

| Export | Purpose |
|--------|---------|
| `createTaskBoard(config?, snapshot?)` | Factory — returns an immutable `TaskBoard` with all operations |
| `detectCycle(items, deps, newId)` | Checks whether adding a node would create a cycle in the DAG |
| `topologicalSort(items)` | Returns tasks in dependency order — O(V+E) with reverse adjacency map |
| `snapshotToItemsMap(board)` | Converts `board.all()` to `Map<TaskItemId, TaskItem>` for sort input |
| `formatUpstreamContext(results, maxChars)` | Formats completed upstream results as a context block for workers |
| `serializeBoard(board)` / `deserializeBoard(snapshot)` | Snapshot round-trip for persistence |
| `isRecord`, `parseStringField`, `parseEnumField` | Typed parse helpers for tool input validation |

---

## Architecture

```
L0  @koi/core ──────────────────────────────────────────────────┐
    TaskBoard, TaskItem, TaskItemId, TaskItemInput, TaskResult,  │
    TaskBoardSnapshot, TaskBoardConfig, TaskBoardEvent,          │
    Result, KoiError, AgentId                                    │
                                                                  ▼
L0u @koi/task-board <────────────────────────────────────────────┘
    imports from L0 only
    x zero external dependencies
    ~ package.json: { "dependencies": { "@koi/core": "workspace:*" } }
```

### Module Map

```
src/
  board.ts          Immutable TaskBoard implementation (~370 LOC)
  dag.ts            detectCycle + topologicalSort (~105 LOC)
  helpers.ts        snapshotToItemsMap, formatUpstreamContext, serialize/deserialize
  parse-helpers.ts  isRecord, parseStringField, parseEnumField
  index.ts          Public exports
```

---

## TaskBoard API

All operations return `Result<TaskBoard, KoiError>` — a new immutable board on success, or an error. The original board is never mutated.

| Method | Signature | Description |
|--------|-----------|-------------|
| `add(input)` | `(TaskItemInput) -> Result<TaskBoard>` | Add a task; rejects duplicates and cycles |
| `addAll(inputs)` | `(TaskItemInput[]) -> Result<TaskBoard>` | Batch add with cycle detection |
| `assign(id, agentId)` | `(TaskItemId, AgentId) -> Result<TaskBoard>` | Claim a task (pending -> assigned) |
| `complete(id, result)` | `(TaskItemId, TaskResult) -> Result<TaskBoard>` | Mark done (assigned -> completed) |
| `fail(id, error)` | `(TaskItemId, KoiError) -> Result<TaskBoard>` | Fail with retry logic (retries < maxRetries -> pending) |
| `update(id, patch)` | `(TaskItemId, TaskItemPatch) -> Result<TaskBoard>` | Update description or fields |
| `get(id)` | `(TaskItemId) -> TaskItem \| undefined` | Look up a task |
| `all()` | `() -> readonly TaskItem[]` | All tasks |
| `ready()` | `() -> readonly TaskItem[]` | Tasks with all dependencies met, status pending |
| `completed()` | `() -> readonly TaskResult[]` | All completed results |
| `result(id)` | `(TaskItemId) -> TaskResult \| undefined` | Result for a specific task |

### TaskItem Fields

```typescript
interface TaskItem {
  readonly id: TaskItemId;
  readonly description: string;
  readonly status: "pending" | "assigned" | "completed" | "failed";
  readonly dependencies: readonly TaskItemId[];
  readonly retries: number;
  readonly maxRetries: number;
  readonly priority: number;
  readonly delegation?: "self" | "spawn" | undefined;  // NEW — dispatch hint
  readonly agentType?: string | undefined;              // NEW — worker lane key
}
```

The `delegation` and `agentType` fields were added in the delegation consolidation (#860):
- `delegation: "spawn"` — task should be dispatched to a worker agent via `SpawnFn`
- `delegation: "self"` or `undefined` — task is handled by the current agent
- `agentType` — key for lane-based concurrency limiting (e.g., "researcher", "coder")

---

## DAG Functions

### detectCycle

Before adding a task, checks if its dependencies would create a cycle:

```typescript
const cycle = detectCycle(itemsMap, ["task-b"], taskItemId("task-a"));
if (cycle) throw new Error(`Cycle: ${cycle.join(" -> ")}`);
```

### topologicalSort

Returns tasks in dependency-first order. Uses a reverse adjacency map for O(V+E) performance:

```typescript
const sorted = topologicalSort(snapshotToItemsMap(board));
// ["setup-db", "create-schema", "seed-data", "run-tests"]
```

---

## Examples

### Create and Populate

```typescript
import { createTaskBoard } from "@koi/task-board";
import { taskItemId } from "@koi/core";

const board = createTaskBoard({ maxRetries: 3 });

const result = board.addAll([
  { id: taskItemId("research"), description: "Research topic", dependencies: [], delegation: "spawn" },
  { id: taskItemId("write"), description: "Write report", dependencies: [taskItemId("research")], delegation: "self" },
]);

if (result.ok) {
  const ready = result.value.ready(); // ["research"] — no unmet deps
}
```

### Serialize / Deserialize

```typescript
import { serializeBoard, deserializeBoard } from "@koi/task-board";

const snapshot = serializeBoard(board);     // { items, results }
const restored = deserializeBoard(snapshot); // Same board state
```

### Upstream Context

```typescript
import { formatUpstreamContext } from "@koi/task-board";

const context = formatUpstreamContext(board.completed(), 2000);
// "--- Upstream Context ---\n[Upstream: research]\nOutput: ...\n--- End Upstream Context ---"
```
