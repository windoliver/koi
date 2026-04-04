# @koi/task-tools

LLM-callable task management tools — `task_create`, `task_get`, `task_update`, `task_list`, `task_stop`, `task_output`, `task_delegate`.

## Layer

L2 — depends on `@koi/core` (L0). `@koi/tasks` is a `devDependency` (test-only).

## Purpose

Provides the 7 tool surfaces that an LLM agent calls to create, inspect, manage, and
delegate tasks on a `ManagedTaskBoard` during execution. Each tool validates its input with
Zod and routes to the appropriate `ManagedTaskBoard` method.

The package is the LLM-facing side of the task system. The persistence layer
(`@koi/tasks`) and the immutable board logic (`@koi/task-board`) are separate packages
that this one consumes via the `ManagedTaskBoard` interface defined in `@koi/core`.

## Key Design Decisions

### Single source of truth for schemas

Each tool's input schema is defined once as a Zod schema. The same schema drives:
- Runtime input validation (`schema.safeParse(args)`)
- LLM tool descriptor (`toJSONSchema(schema)` via Zod v4 built-in)

No hand-written JSON Schema objects — eliminates drift between LLM docs and validation.

### Atomic single-in-progress enforcement (worker agents)

`task_update(status: "in_progress")` does a preflight `board.snapshot().inProgress()` check
and rejects if any task is already `in_progress`. Workers use this to claim exactly one task
at a time.

### Coordinator fan-out via `task_delegate`

`task_delegate(task_id, agent_id)` assigns a pending task to a child agent ID using
`board.assign()` directly — bypassing the single-in-progress guard. Coordinators use this
to fan-out N tasks simultaneously to N child agents. The distinction is semantic:
- `task_update(in_progress)` = "I am working on this now" (single worker)
- `task_delegate(agent_id)` = "child agent X will work on this" (coordinator)

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

### Poll efficiency — `updated_since` filter

`task_list` accepts an optional `updated_since: number` (Unix ms timestamp). Only tasks
whose `updatedAt > updated_since` are returned. Coordinators store the timestamp of their
last poll and pass it on each resume to skip unchanged tasks — reduces N+1 polling overhead
for large fan-outs.

### Opt-in result schema validation

`TaskToolsConfig.resultSchemas` is an optional map from task kind string to a `ResultSchema`
(any object with a `safeParse` method — satisfied by Zod schemas). When `task_output`
returns a `completed` result with `result.results` set, it looks up
`task.metadata.kind` in the registry. If a schema is found and validation fails, the
response includes `resultsValidationError: string`. Tasks with no registered schema are
not validated (backward compatible).

## Public API

### `createTaskTools(config: TaskToolsConfig): readonly Tool[]`

Returns an array of 7 `Tool` objects in order: `task_create`, `task_get`, `task_update`,
`task_list`, `task_stop`, `task_output`, `task_delegate`.

```typescript
interface TaskToolsConfig {
  /** The managed task board. Must be created with resultsDir for completion to work. */
  readonly board: ManagedTaskBoard;
  /** Agent ID for assigning/completing/failing/killing tasks. */
  readonly agentId: AgentId;
  /**
   * Optional per-kind Zod (or compatible) schemas for validating TaskResult.results.
   * Key: task.metadata.kind. When a completed result's results field doesn't match
   * its schema, task_output returns resultsValidationError.
   */
  readonly resultSchemas?: Readonly<Record<string, ResultSchema>>;
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
  | { kind: "completed"; result: TaskResult; resultsValidationError?: string }
  | { kind: "failed"; task: Task; error: KoiError }
  | { kind: "killed"; task: Task }
  | { kind: "completed_no_result"; taskId: TaskItemId; message: string }
```

`resultsValidationError` is present only when `resultSchemas` is configured and validation
fails. The `result` is still returned in full — the error is advisory.

## Tool Descriptions

| Tool | Status arg | Notes |
|------|-----------|-------|
| `task_create` | — | Generates ID via `board.nextId()`. Accepts optional `metadata` (e.g. `{ kind: "research" }`). |
| `task_get` | — | Returns full `Task` including metadata and timestamps. |
| `task_update` | `in_progress`, `completed`, `failed`, `killed` | `completed` requires `output`. Accepts optional `results: JsonObject`. Single-in-progress guard. |
| `task_list` | — | Filters by `status`, `assigned_to`, `updated_since`. Returns `TaskSummary[]`, ordered in_progress → pending → terminal. |
| `task_stop` | — | Kills an `in_progress` task owned by the calling agent. Rejects pending and cross-agent. |
| `task_output` | — | Returns `TaskOutputResponse`. Validates `results` against registered schema if configured. |
| `task_delegate` | — | **Coordinator only.** Assigns a pending task to a child agent ID. No single-in-progress guard — multiple tasks may be delegated simultaneously. |

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
