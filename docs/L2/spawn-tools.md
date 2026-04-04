# @koi/spawn-tools

LLM-callable agent spawn tool + coordinator orchestration utilities — `agent_spawn`, `TaskCascade`, `recoverOrphanedTasks`.

## Layer

L2 — depends on `@koi/core` (L0) and `@koi/task-board` (L0u). `@koi/tasks` is a `devDependency` (test-only).

## Purpose

Provides the tool surface and orchestration helpers that coordinator agents use to spawn
child agents, find ready tasks in a dependency graph, and recover from crashes. Pairs with
`@koi/task-tools` for the full coordinator workflow:

- `@koi/task-tools` manages the task board (create, delegate, list, poll)
- `@koi/spawn-tools` handles agent spawning and cascade logic

## Public API

### `createSpawnTools(config: SpawnToolsConfig): readonly Tool[]`

Returns `[agent_spawn]` — one LLM-callable tool that wraps a `SpawnFn`.

```typescript
interface SpawnToolsConfig {
  readonly spawnFn: SpawnFn;       // L0 contract — injected by the runtime
  readonly board: ManagedTaskBoard;
  readonly agentId: AgentId;
  readonly signal: AbortSignal;
}
```

### `createTaskCascade(board: ManagedTaskBoard): TaskCascade`

Returns a board-aware helper for coordinator orchestration:

```typescript
interface TaskCascade {
  /** Pending tasks whose all dependencies are completed — ready to delegate. */
  readonly findReady: () => readonly TaskItemId[];
  /** Returns cycle paths if the dependency graph has cycles; undefined for a valid DAG. */
  readonly detectCycles: () => readonly (readonly TaskItemId[])[] | undefined;
}
```

Uses `topologicalSort` and `detectCycle` from `@koi/task-board` — O(V+E), no redundant computation.

### `recoverOrphanedTasks(board, coordinatorAgentId): Promise<OrphanRecoveryResult>`

Coordinator crash recovery. Finds `in_progress` tasks assigned to a different agent
(orphaned from a previous session), kills them, and re-queues equivalent pending tasks.

```typescript
interface OrphanRecoveryResult {
  readonly killed: readonly TaskItemId[];   // terminal — these IDs are gone
  readonly requeued: readonly TaskItemId[]; // new pending tasks with same descriptions
}
```

**Limitation:** Re-queued tasks get new IDs (kill + re-add pattern). A proper
`unassign(taskId)` on `ManagedTaskBoard` (L0) would preserve IDs — deferred.

## Tool Description

| Tool | Notes |
|------|-------|
| `agent_spawn` | Spawns a named child agent via injected `SpawnFn`. Returns `{ ok, output }`. Call `task_delegate` first to mark the task on the board, then pass `task_id` here so the child's result can be matched back. |

## Key Design Decisions

### SpawnFn is injected, not imported

`agent_spawn` wraps the L0 `SpawnFn` contract rather than a concrete implementation.
The runtime injects the real spawn function; tests inject a stub. This keeps the package
free of L1 engine dependencies.

### TaskCascade reuses @koi/task-board dag utilities

`findReady` and `detectCycles` delegate to `topologicalSort`, `detectCycle`, and
`snapshotToItemsMap` already exported from `@koi/task-board` (L0u). No duplicate
dependency graph logic.

### Recovery uses kill + re-add, not unassign

`recoverOrphanedTasks` cannot transition `in_progress → pending` because the task
board's state machine doesn't include that edge (valid transitions from `in_progress`
are `completed`, `failed`, `killed` only). The kill + re-add pattern is correct for
MVP; a future `ManagedTaskBoard.unassign()` method would be the cleaner long-term fix.

## Coordinator Workflow (with @koi/task-tools)

```
1. task_create × N          — add all subtasks to the board (set metadata.kind)
2. task_delegate + agent_spawn — fan-out: delegate then spawn for each task
3. task_list({ updated_since }) — poll for changed tasks only
4. task_output              — fetch results one at a time, summarize each
5. synthesize               — combine summaries into final answer
```

On restart: call `recoverOrphanedTasks` to reset any tasks left in_progress from the
previous session, then resume from step 3.

## Relationship to Other Packages

| Package | Relationship |
|---------|-------------|
| `@koi/core` | `SpawnFn`, `ManagedTaskBoard`, `AgentId`, `TaskItemId`, `Tool` |
| `@koi/task-board` | `detectCycle`, `topologicalSort`, `snapshotToItemsMap` (L0u) |
| `@koi/task-tools` | Companion package — manages task board; spawn-tools handles agent spawning |
| `@koi/tasks` | `createManagedTaskBoard`, `createMemoryTaskBoardStore` (devDep — test only) |
| `@koi/agent-runtime` | Provides the `coordinator` built-in agent definition that uses this package |

## v1 Reference

- `archive/v1/packages/sched/long-running/src/delegation-bridge.ts` — v1 dispatch loop
  (scan → claim → spawn → cascade → retry). v2 separates concerns: `task_delegate` handles
  board-level assignment, `agent_spawn` handles spawning, `TaskCascade` handles cascade logic.
