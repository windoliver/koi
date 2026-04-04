# @koi/task-tools

LLM-callable task management tools — `task_create`, `task_get`, `task_update`, `task_list`, `task_stop`, `task_output`.

## Layer

L2 — depends on `@koi/core` (L0). `@koi/tasks` is a `devDependency` (test-only).

## Purpose

Provides the 6 tool surfaces that an LLM agent calls to create, inspect, and manage tasks
on a `ManagedTaskBoard` during execution. Each tool validates its input with Zod and routes
to the appropriate `ManagedTaskBoard` method.

The package is the LLM-facing side of the task system. The persistence layer
(`@koi/tasks`) and the immutable board logic (`@koi/task-board`) are separate packages
that this one consumes via the `ManagedTaskBoard` interface defined in `@koi/core`.

## Key Design Decisions

### Single source of truth for schemas

Each tool's input schema is defined once as a Zod schema. The same schema drives:
- Runtime input validation (`schema.safeParse(args)`)
- LLM tool descriptor (`toJSONSchema(schema)` via Zod v4 built-in)

No hand-written JSON Schema objects — eliminates drift between LLM docs and validation.

### Atomic single-in-progress enforcement

`task_update(status: "in_progress")` calls `board.startTask(taskId, agentId)`, which
atomically checks that no task is already `in_progress` and assigns the task — all within
the managed-board mutex. A preflight `board.snapshot().inProgress()` check followed by
`board.assign()` would be a TOCTOU race; `startTask()` eliminates it.

### Atomic ownership enforcement

All terminal mutations (`complete`, `fail`, `kill`) and metadata updates use owned
variants (`completeOwnedTask`, `failOwnedTask`, `killOwnedTask`, `updateOwned`) that
re-read and verify `task.assignedTo === agentId` inside the single-writer lock.
A stale-snapshot check in the tool layer would not prevent cross-agent races.

### Durable result gate

`task_update(status: "completed")` fails fast when `board.hasResultPersistence()` returns
`false`. Without a `resultsDir`, completed `TaskResult` payloads are memory-only and
permanently lost after a restart, leaving tasks as `completed` with no retrievable output.
This prevents the silent data-loss path rather than handling it with a `completed_no_result`
fallback.

### Read authorization

`task_output` and `task_stop` reject access when `task.assignedTo` is set to a different
agent. Tasks with `assignedTo === undefined` (pending, or cleared on failure/retry) are
accessible — ownership cannot be reconstructed after the board clears the field.

### Verification nudge

`createTaskTools()` wraps `task_update` with a closure counter. After 3+ consecutive
non-verification task completions, the response includes a nudge message reminding the
agent to add a verification step. The counter resets when a task whose subject/description
contains "verif" is completed. The counter is ephemeral (resets on restart) — appropriate
for advisory behavior.

### TaskSummary projection

`task_list` returns `TaskSummary` objects (id, subject, status, activeForm, assignedTo,
dependencies, blockedBy) rather than full `Task` objects. Full details (metadata,
timestamps, error) are available via `task_get`. This keeps list responses compact and
avoids leaking large metadata blobs into LLM context on every list call.

## Public API

### `createTaskTools(config: TaskToolsConfig): readonly Tool[]`

Returns an array of 6 `Tool` objects in order: `task_create`, `task_get`, `task_update`,
`task_list`, `task_stop`, `task_output`.

```typescript
interface TaskToolsConfig {
  /**
   * The managed task board backing the 6 tools.
   * Must be created with `resultsDir` set — task_update(completed) fails fast
   * when result persistence is not configured.
   */
  readonly board: ManagedTaskBoard;
  /**
   * Agent ID used when assigning/completing/failing/killing tasks.
   * Typically the ID of the agent that owns this tool set.
   */
  readonly agentId: AgentId;
}
```

### `TaskToolsConfig`

See above. `board` must have `hasResultPersistence() === true` for completion to work.

### `TaskSummary`

Lean projection of `Task` for list responses:

```typescript
interface TaskSummary {
  readonly id: TaskItemId;
  readonly subject: string;
  readonly status: TaskStatus;
  readonly activeForm?: string;
  readonly assignedTo?: AgentId;
  readonly dependencies: readonly TaskItemId[];
  readonly blockedBy?: TaskItemId;   // first unmet dep, when pending
}
```

### `TaskOutputResponse`

Discriminated union returned by `task_output`:

```typescript
type TaskOutputResponse =
  | { kind: "not_found"; taskId: TaskItemId }
  | { kind: "pending"; task: TaskSummary }
  | { kind: "in_progress"; task: TaskSummary }
  | { kind: "completed"; result: TaskResult }
  | { kind: "failed"; task: Task; error: KoiError }
  | { kind: "killed"; task: Task }
  | { kind: "completed_no_result"; taskId: TaskItemId; message: string }
```

## Tool Descriptions

| Tool | Status arg | Notes |
|------|-----------|-------|
| `task_create` | — | Generates ID via `board.nextId()`. Sets `activeForm` if provided. |
| `task_get` | — | Returns full `Task` including metadata and timestamps. |
| `task_update` | `in_progress`, `completed`, `failed`, `killed` | `completed` requires `output` and durable persistence. `failed` requires `reason`. |
| `task_list` | — | Filters by `status`, `assigned_to`. Returns `TaskSummary[]`, ordered in_progress → pending → terminal. |
| `task_stop` | — | Kills an `in_progress` task owned by the calling agent. Rejects pending and cross-agent. |
| `task_output` | — | Returns `TaskOutputResponse` for the given task ID. Rejects cross-agent reads on assigned tasks. |

## Relationship to Other Packages

| Package | Relationship |
|---------|-------------|
| `@koi/core` | `ManagedTaskBoard` interface, `Task`, `TaskPatch`, `TaskResult`, `AgentId`, `Tool` |
| `@koi/task-board` | Immutable board logic (L0u) — consumed indirectly via `ManagedTaskBoard` |
| `@koi/tasks` | `ManagedTaskBoard` implementation, `createMemoryTaskBoardStore` (devDep — test only) |
| `@koi/tools-core` | Provides `buildTool()` pattern for reference; task-tools uses Zod + `toJSONSchema` directly |

## v1 Reference

- `archive/v1/packages/sched/long-running/src/task-tools.ts` — v1 task tools
  (`task_complete`, `task_update`, `task_status`, `task_review`, `task_synthesize`).
  v2 simplifies: drops review/synthesize (out of scope), adds get/list/stop/output,
  replaces ad-hoc validation with Zod schemas, and moves ownership enforcement into the
  board layer rather than the tool layer.
