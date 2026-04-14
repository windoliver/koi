# @koi/task-tools

LLM-callable task management tools — `task_create`, `task_get`, `task_update`, `task_list`, `task_stop`, `task_output`, `task_delegate`.

## Layer

L2 — depends on `@koi/core` (L0), `@koi/tools-core` (L0u). `@koi/tasks` is a `devDependency` (test-only).

## Purpose

Provides the 7 tool surfaces that an LLM agent calls to create, inspect, manage, and
delegate tasks on a `ManagedTaskBoard` during execution. Each tool validates its input with
Zod and routes to the appropriate `ManagedTaskBoard` method.

Also provides `createTaskToolsProvider()` — a `ComponentProvider` that wraps all 7 tools
for ECS agent assembly, and offset-based incremental output reads via the `task_output` tool.

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

`task_delegate(task_id, agent_id)` records delegation intent in `metadata.delegatedTo`
only — it does NOT change `task.status` or `task.assignedTo`. The task remains `pending`
with no owner so the spawned worker can claim it via `task_update(status: "in_progress")`.

The distinction is semantic:
- `task_update(in_progress)` = "I am working on this now" (worker self-assignment)
- `task_delegate(agent_id)` = "record that child agent X is intended for this task" (coordinator metadata — no ownership change)

**Why metadata-only (not `assignedTo`)?** Assigning the coordinator's `AgentId` as owner
breaks the worker ownership contract: `task_update`, `task_output`, and orphan recovery
all use `assignedTo` as source of truth. Workers cannot close tasks they don't own.
Keeping `assignedTo` empty lets the worker claim the task normally.

**Rejection cases for `task_delegate`:**
- Task not found
- Task is not `pending` (already `in_progress`, `completed`, etc.)
- Task already has `metadata.delegatedTo` set (undelegate first or create a new task)

**Autonomous bridge (#1553):** For swarm use, a future bridge component (modelled on v1's
`dispatchSpawnTasks`) will atomically couple `task_delegate → agent_spawn → auto-complete`,
handle clearing stale `metadata.delegatedTo` on crash recovery, and provide an undelegate
path. That bridge is a separate layer, not part of this package.

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

### Completion output defaulting (#1785)

When `output` is omitted or blank on `task_update(status: "completed")`, the tool
auto-defaults to `"Completed: <task.subject>"` instead of returning an error. This avoids
LLM re-prompt friction where the model had to ask the user for a summary. The Zod schema
still type-validates `output` as `string | undefined` — non-string values are rejected at
the schema level. Explicit `output` values are always preferred and passed through unchanged.

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
| `task_update` | `in_progress`, `completed`, `failed`, `killed` | `completed` accepts optional `output`; defaults to `"Completed: <subject>"` when omitted (#1785). Accepts optional `results: JsonObject`. Single-in-progress guard. |
| `task_list` | — | Filters by `status`, `assigned_to`, `updated_since`. Returns `TaskSummary[]`, ordered in_progress → pending → terminal. |
| `task_stop` | — | Kills an `in_progress` task owned by the calling agent. Rejects pending and cross-agent. |
| `task_output` | — | Returns `TaskOutputResponse`. Validates `results` against registered schema if configured. |
| `task_delegate` | — | **Coordinator only.** Records `metadata.delegatedTo` on a pending task. Does NOT change `assignedTo` or status — task stays `pending` for the worker to claim. No single-in-progress guard. |

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

## Review hardening (#1557 review — PR #1659)

### `task_update.execute()` split into per-status handlers

The original `execute()` closure was 165 lines with 5 levels of nesting and 5
near-duplicate "rebuild-success-response-from-snapshot" blocks. It's now a 15-line
dispatcher that validates input, looks up the task, and delegates to one of 5 per-status
handlers (`handleStartInProgress`, `handleComplete`, `handleFail`, `handleKill`,
`handleMetadataPatch`), each <30 lines. A single `buildSuccess(board, id, extras?)`
helper replaces the duplicate response construction. `computeDurationMs(task)` centralizes
the `task.startedAt ?? task.updatedAt` fallback. Pure refactor — all 70 existing tests
pass unchanged, including the `durationMs` regression added in PR #1 of this punch list.

### Named-tool test lookup

`task-tools.test.ts` previously used positional destructuring
(`const [create, , update] = tools as [Tool, Tool, Tool, Tool, Tool, Tool]`) with three
different stale length checks (`< 6` vs `< 7`) because the file wasn't updated when
`task_delegate` was added. Replaced with a `createNamedTaskTools(config)` helper that
looks up each tool by `descriptor.name` and asserts the expected count once (one
`EXPECTED_TOOL_COUNT` constant). Zero positional destructures remain.

### `durationMs` anchored to `Task.startedAt`

`task_update(completed)` now computes `durationMs` from `task.startedAt ?? task.updatedAt`
instead of `task.updatedAt` alone. The new `startedAt` field is set by the board on every
`pending → in_progress` transition and is NOT bumped by `update()` patches, so an
`activeForm` mid-run patch no longer silently shortens the reported run duration.
Backfilled for snapshots loaded from pre-field-existence versions.
