# @koi/tasks

Task board persistence + runtime task lifecycle — stores, output streaming, task kinds,
registry, and runner for background task coordination.

## Layer

L2 — depends on `@koi/core` (L0), `@koi/task-board` (L0u), `@koi/validation` (L0u).

## Purpose

Provides concrete implementations of the `TaskBoardStore` interface, plus the runtime
task lifecycle system: output streaming, task kind types, a lifecycle registry, and
a task runner that orchestrates start/stop with board reconciliation.

### Persistence

Two store backends ship with this package:

1. **In-memory** — `Map`-backed store for tests and short-lived sessions. All operations
   are synchronous. State is lost when the process exits.
2. **File-based** — One JSON file per task in a flat directory. Atomic write-to-temp +
   rename for crash safety. Write-through cache for fast reads. State survives process
   restart.

Both backends share the same behavioral contract (verified by a shared test suite) and
implement the same `TaskBoardStore` interface, so consumers can swap backends without
code changes.

## `ManagedTaskBoard.unassign()` (#1241)

`unassign(taskId)` is an atomic `in_progress → pending` transition that resets an
assigned task back to pending without killing it. This preserves the task ID, description,
and metadata — unlike kill + re-add which creates a new task with a new ID.

```typescript
interface ManagedTaskBoard {
  // ... existing methods ...
  readonly unassign: (taskId: TaskItemId) => Promise<Result<TaskBoard, KoiError>>;
}
```

The `unassign` method is intended for coordinator crash recovery: when a coordinator
restarts and finds orphaned `in_progress` tasks from the previous session, it calls
`unassign` on each to make them available for re-delegation.

A corresponding `task:unassigned` event is emitted on the board's event bus when
`unassign` succeeds.

## L0 Interface

The `TaskBoardStore` interface lives in `@koi/core` (`task-board.ts`) alongside the
`TaskItem`, `TaskItemId`, and `TaskBoard` types. Key design decisions:

- **Bare returns** — `get()` returns `TaskItem | undefined`, `put()` returns `void`.
  Throws on unexpected failures (filesystem corruption). No `Result<T, KoiError>` wrapper
  for simple CRUD.
- **`T | Promise<T>` return types** — All methods return `T | Promise<T>` so in-memory
  backends can be synchronous while file/network backends return promises. Callers must
  always `await`.
- **`AsyncDisposable`** — Both backends implement `Symbol.asyncDispose` for cleanup.
- **ID generation inside the store** — `nextId()` returns monotonic integer IDs
  (`task_1`, `task_2`, ...) with a high water mark that never decreases, even after
  deletion or reset. The store owns the counter because only it knows what IDs exist.

```typescript
interface TaskBoardStore extends AsyncDisposable {
  readonly get: (id: TaskItemId) => TaskItem | undefined | Promise<TaskItem | undefined>;
  readonly put: (item: TaskItem) => void | Promise<void>;
  readonly delete: (id: TaskItemId) => void | Promise<void>;
  readonly list: (filter?: TaskBoardStoreFilter) => readonly TaskItem[] | Promise<readonly TaskItem[]>;
  readonly nextId: () => TaskItemId | Promise<TaskItemId>;
  readonly watch: (listener: (event: TaskBoardStoreEvent) => void) => () => void;
  readonly reset: () => void | Promise<void>;
}
```

## Public API

### `createMemoryTaskBoardStore(): TaskBoardStore`

Creates an in-memory store backed by a `Map<TaskItemId, TaskItem>`.

- All operations are synchronous (return values, not promises).
- IDs are monotonic integers: `task_1`, `task_2`, `task_3`, ...
- High water mark is never decremented — IDs are never reused after deletion.
- `reset()` clears all items but preserves the HWM.
- `dispose()` clears the map.

### `createFileTaskBoardStore(config): Promise<TaskBoardStore>`

Creates a file-based store with one JSON file per task.

Returns a promise because construction involves scanning the directory.

**Config:**

```typescript
interface FileTaskBoardStoreConfig {
  /** Directory for task JSON files. Created if it does not exist. */
  readonly baseDir: string;
  /** Delete orphaned .tmp files on startup. Default: true. */
  readonly cleanOrphanedTmp?: boolean;
}
```

**Behavior:**

- **Startup**: Scans filenames only (no content reads) to compute the high water mark
  from existing IDs. O(n) filenames, zero file I/O.
- **Write-through cache**: `put()` writes to disk AND updates an in-memory `Map`. `get()`
  and `list()` serve from cache after initial population. Cache is populated lazily on
  first `get()` or `list()` call.
- **Atomic writes**: Each `put()` writes to a temp file (`task_N.json.<timestamp>.<random>.tmp`)
  then renames to the final path. This ensures the target file is either the old version
  or the new version, never corrupted.
- **Orphaned temp cleanup**: On startup (unless `cleanOrphanedTmp: false`), scans for
  `.tmp` files left by interrupted writes and deletes them.
- **Self-healing**: If a known ID has no backing file (deleted externally) or the file is
  corrupted JSON, `get()` returns `undefined` and removes the ID from the known set.
- **Flat directory**: No hash sharding. Task boards typically have 5–50 items, rarely
  >100. Sharding can be added behind the same interface if needed.

**File layout:**

```
<baseDir>/
  task_1.json
  task_2.json
  task_5.json      (gaps are normal — IDs are never reused)
```

## Watch / Notification

Both backends emit events via the `watch()` method using the generic `ChangeNotifier<E>`
pattern (shared with `StoreChangeNotifier` for brick stores):

```typescript
type TaskBoardStoreEvent =
  | { readonly kind: "put"; readonly item: TaskItem }
  | { readonly kind: "deleted"; readonly id: TaskItemId };
```

- `watch()` returns an unsubscribe function (idempotent).
- Subscriber cap: 64 (throws if exceeded — catches listener leaks).
- Snapshot-before-iterate: safe if a listener unsubscribes during notification.
- Error isolation: one listener throwing does not break others.

The generic `ChangeNotifier<E>` interface lives in `@koi/core` (`change-notifier.ts`).
The in-memory implementation `createMemoryChangeNotifier<E>()` lives in `@koi/validation`
(L0u) for reuse across all store implementations.

## ID Generation

Both backends use monotonic integer IDs with a high water mark:

- Format: `task_1`, `task_2`, ..., `task_N`
- The counter only increases — deleting `task_3` does not make `3` available again.
- `reset()` clears all items but preserves the HWM.
- File-based store: on startup, scans filenames to find `max(existing IDs)` and
  continues from there. No `.meta` file needed.

This matches CC's task ID model — human-readable integers that the LLM can reference
naturally ("task_3 is blocked by task_1").

## Contract Test Suite

`task-board-store.contract.ts` defines 21 behavioral tests that any `TaskBoardStore`
implementation must pass. Test categories:

| Category | Tests | What it verifies |
|----------|-------|------------------|
| CRUD | 7 | Round-trip, overwrite, delete, list, field preservation |
| List filters | 3 | Filter by status, assignedTo, combined |
| ID + HWM | 5 | Monotonicity, no reuse after delete, reset preserves HWM, gaps |
| Watch | 4 | Put/delete events, unsubscribe, no event on no-op delete |
| Reset | 1 | Clears items, preserves HWM |

Future store implementations (e.g., Nexus-backed) import and run the contract:

```typescript
import { runTaskBoardStoreContract } from "@koi/tasks/src/task-board-store.contract.js";
runTaskBoardStoreContract(() => createMyStore());
```

## EngineEvent Bridging (#1555)

`ManagedTaskBoardConfig` gains two optional fields for automatic engine event emission:

- `onEngineEvent: (event: EngineEvent) => void` — callback receiving `plan_update` and `task_progress` events
- `agentId: AgentId` — branded agent ID attached to emitted events

When both are provided, the managed board automatically bridges `TaskBoardEvent` mutations
to `EngineEvent` kinds via `mapTaskBoardEventToEngineEvents()` (a pure function in
`@koi/task-board` L0u). Events are buffered during persistence and flushed after the store
write succeeds, so consumers never observe events for uncommitted state.

On construction, a `plan_update` snapshot is emitted as the initial hydration event so
downstream consumers (TUI, trajectory) receive the full board state at startup.

## Runtime Task System (#1557)

### Output Streaming

`createOutputStream(config?)` provides an in-memory output stream with:
- Byte-accurate offsets (UTF-8 via `TextEncoder`)
- Memory cap (default 8MB) with oldest-chunk eviction
- Delta reads via `read(fromOffset)`
- Subscriber notifications with error isolation

### Task Kinds

`RuntimeTask` discriminated union: `LocalShellTask | LocalAgentTask | RemoteAgentTask | InProcessTeammateTask | DreamTask`. Each kind extends `RuntimeTaskBase` with kind-specific fields. Type guards: `isLocalShellTask()`, `isRuntimeTask()`, etc.

### Task Registry

`createTaskRegistry()` maps `TaskKindName` to `TaskKindLifecycle<TConfig, TState>` implementations. Lifecycles define `start()` and `stop()` methods.

### Task Runner

`createTaskRunner(config)` orchestrates task start/stop with:
- Board reconciliation via `store.watch()` — cleans up when tasks terminate externally
- Owned-task APIs (`startTask`, `killOwnedTask`) for atomic ownership checks
- `onExit` injection for natural process completion (with `pendingExits` for fast-exit races)
- Delta output reads via `readOutput(taskId, fromOffset?)`

### LocalShellTask Lifecycle

`createLocalShellLifecycle()` — spawns shell processes via `Bun.spawn()`, pipes stdout/stderr to `TaskOutputStream`, handles timeouts, and propagates exit codes.

## Relationship to Other Packages

| Package | Relationship |
|---------|-------------|
| `@koi/core` | Defines `TaskBoardStore` interface + `TaskItem` types (L0) |
| `@koi/validation` | Provides `createMemoryChangeNotifier<E>()` (L0u) |
| `@koi/tasks` (future: tools) | #1428 — task tools (`task_create`, `task_list`, etc.) will consume the store |
| `@koi/tasks` (future: reconciliation) | #1429 — transition guards and DAG validation will consume the store |
| `@koi/core` `TaskStore` | **Separate domain** — scheduler task persistence (`ScheduledTask`), not task board |

## Code Quality

Lint configured with `biome check --vcs-enabled=false src/` to avoid biome VCS resolution issues in git worktrees. All non-null assertions in source replaced with proper guards; test files use `biome-ignore` where the assertion is guarded by setup.

## v1 Reference

- `archive/v1/packages/sched/scheduler/src/sqlite-store.ts` — SQLite-backed scheduler
  store. We simplified: dropped SQLite (overkill for task-board scale), dropped scheduler
  fields (priority queue, retries, timeouts), kept the prepared-statement and
  async-dispose patterns.
- `archive/v1/packages/fs/store-fs/src/fs-store.ts` — File-based brick store with atomic
  writes and hash sharding. We reused the atomic-write pattern but dropped hash sharding
  (unnecessary at task-board scale).

## Task Kind Validation & Lifecycle Stubs (#1242)

### L0 Runtime Guard

`isValidTaskKindName(value: string): value is TaskKindName` — runtime narrowing guard
in `@koi/core`. Validates arbitrary strings (e.g., from `task.metadata.kind`) against
the closed `TaskKindName` union. `VALID_TASK_KIND_NAMES: ReadonlySet<string>` is the
single source of truth — L2 packages import it instead of maintaining local copies.

### Unsupported Lifecycle Stubs

`createUnsupportedLifecycle(kind)` creates a `TaskKindLifecycle` whose `start()` rejects
with `Task kind "${kind}" is not yet implemented`. Use for kinds that are defined in the
type system but not yet runnable (e.g., `dream`, `local_agent`).

### Default Registration

`registerDefaultLifecycles(registry)` registers all 5 `TaskKindName` values:

| Kind | Lifecycle |
|------|-----------|
| `local_shell` | Real — `createLocalShellLifecycle()` |
| `local_agent` | Stub — rejects on start |
| `remote_agent` | Stub — rejects on start |
| `in_process_teammate` | Stub — rejects on start |
| `dream` | Stub — rejects on start |

### Boundary Validation in TaskRunner

`TaskRunner.start()` validates the `kind` parameter before registry lookup:

- `VALIDATION` error — string is not a valid `TaskKindName` (boundary issue, e.g., typo)
- `NOT_FOUND` error — valid kind but no lifecycle registered (configuration issue)

This two-level check gives callers actionable diagnostics.

For unsupported kinds (registered stub lifecycles), `TaskRunner.start()` atomically
kills the task via `board.killIfPending()` with rejection metadata (`rejectedKind`,
`rejectedReason`). The kill is guarded by `expectedKind` — if the task has
`metadata.kind` and it doesn't match, a `CONFLICT` error is returned instead of killing.

### Known Design Considerations

**Runtime kind authority**: `TaskRunner.start(taskId, kind)` trusts the explicit `kind`
parameter as the runtime lifecycle selector. `task.metadata.kind` is optional/advisory
and used for mismatch protection when present. A follow-up issue should formalize whether
`metadata.kind` becomes mandatory for tasks that use the runner, or whether a dedicated
`runtimeKind` field should be added to the `Task` type.

**Killed vs failed for unsupported kinds**: Unsupported tasks are marked `killed` (the
only valid transition from `pending`). The rejection reason is stored in `metadata.rejectedReason`.
Downstream consumers should check this field for killed tasks to distinguish unsupported-kind
rejections from manual cancellations.

## Review hardening (#1557 review — PR #1659)

Multiple safety, performance, and test-infrastructure improvements landed as a review
punch list. Each item is a narrow fix to the already-shipped package rather than a
feature addition.

### Path-traversal defense (file-store)

`createFileTaskBoardStore` now calls `assertSafeTaskId` at every I/O boundary
(`get`/`put`/`delete`). Task IDs must match `^task_\d+$`; anything else throws at the
boundary. Defense in depth against `TaskItemId` being a branded-but-unvalidated string.

### Single-writer PID lock

A `.lock` file containing `{pid, ctime}` is written to `baseDir` on construction and
released on dispose. Second store instances against the same directory fail fast with
a clear error; dead-PID and malformed locks are reclaimed automatically. Use `lock: false`
to disable for tests that deliberately overlap stores. Documented crash-recovery
boundaries are in the file-store source header.

### Bounded I/O concurrency

`ensureCache` now processes task files in batches of 32 instead of an unbounded
`Promise.all`. Boards with thousands of tasks can't exhaust file descriptors on first
access.

### Output stream deque eviction

`createOutputStream` uses a head-pointer/deque pattern for eviction instead of
`chunks.slice(1)`. Eviction is now O(1) amortized; worst-case workloads with oversized
writes drop from O(N²) to O(N).

### TaskRunner selfWriteIds skip-set

The runner's internal board mutations are tagged with a `selfWriteIds` set; the store's
watch reconciler skips events for IDs in that set. Prevents double-stop on self-writes
and protects future code paths that forget the delete-before-board.X ordering.

### Start-path fallback chain

The `TaskRunner.start()` catch now mirrors `handleNaturalExit`'s three-tier fallback
(try `failOwnedTask`, fall back to `kill()`, then swallow). A cascading store failure
during lifecycle start leaves the task in a terminal state instead of stuck `in_progress`.

### Event-buffering invariant tests

`managed-board.test.ts` gained 6 tests pinning the "observer notifications fire only
after persistence succeeds" invariant, backed by a reusable `createFlakyStore` helper
(in `src/test-helpers.ts`) that injects controllable put() failures.

### Race-condition test coverage

`task-runner.test.ts` was rewritten to use a real in-memory `ManagedTaskBoard` instead
of fully mocked internals. 6 new race tests cover: fast-exit drain, post-stop natural
exit, cascading-failure fallback, `handleNaturalExit` complete-returns-ok-false fallback,
outer-catch fallback, and the selfWriteIds skip-set.

### Local-shell branch coverage

`local-shell.test.ts` gained 6 tests for previously-uncovered paths: timeout abort,
`onExit` exit-code propagation, env vars reaching the subprocess, multibyte UTF-8
output across chunk boundaries, stop-verify via `proc.exited` timing, and natural-exit
`onExit` firing.

### Test count delta

- Before: 73 `@koi/tasks` tests
- After: **159** tests (+86)
