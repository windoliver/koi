# Issue 1647: Team Runtime Design

## Summary

Issue #1647 introduces parallel multi-agent team orchestration for Koi v2 as a new L2 package, `@koi/team-runtime`. The package owns decomposition, dependency-aware scheduling, parallel dispatch, checkpoint/replay recovery, shared-resource coordination, and final result merging. It builds on `@koi/task-board` as the authoritative task/DAG read model, uses an append-only event log as the durability layer, and attaches vector-clock metadata to shared-state mutations and merge points for conflict detection.

The first shipped design aims for the fuller cut requested in the issue rather than a narrow MVP. That means the initial architecture includes:

- durable event sourcing
- replayable checkpoints
- vector-clock conflict metadata
- hybrid write coordination with isolation-first policy
- per-agent budget slicing

The scheduler still treats the materialized task board as the source of truth for dependency state. Vector clocks are deliberately scoped to conflict metadata and merge ordering, not to replace the board as the scheduling read model.

## Goals

- Add a reusable `@koi/team-runtime` package for dependency-aware multi-agent orchestration.
- Support fan-out/fan-in execution across a decomposed task DAG.
- Respect dependency boundaries while running parallel-safe tasks concurrently.
- Persist orchestration state through an append-only event log and replay it on resume.
- Detect and manage shared-resource conflicts using vector-clock metadata plus explicit serialization.
- Slice and enforce per-agent or per-task budget allocations from a team-level budget.
- Provide a merge path that combines subtask outputs into a single coherent result.

## Non-Goals

- Replacing `@koi/agent-runtime` as the home for agent definitions and manifest loading.
- Making vector clocks the sole source of truth for team scheduling state.
- Solving arbitrary semantic source-code merge conflicts automatically.
- Delivering cross-machine or multi-zone orchestration in the first cut. The design should remain compatible with that future, but the initial runtime is scoped to one orchestrated team run domain.

## Package Boundary

`@koi/team-runtime` is a new L2 orchestration package. It sits above `@koi/task-board` and beside `@koi/agent-runtime`.

`@koi/agent-runtime` remains focused on:

- built-in and custom agent definitions
- manifest parsing and validation
- definition resolution
- coordinator agent manifests and tool ceilings

`@koi/team-runtime` owns:

- team spec and runtime configuration
- subtask materialization into a task board
- dependency analysis and runnable-set planning
- agent dispatch orchestration
- event sourcing and replay
- shared-resource coordination
- budget slicing and enforcement
- merge synthesis

This separation keeps the existing definition-oriented surface of `@koi/agent-runtime` stable while creating a clean home for scheduling and recovery logic.

## Dependencies

Planned direct dependencies:

- `@koi/task-board` for authoritative task DAG state and helper functions
- `@koi/agent-runtime` types and built-in coordinator manifest where needed
- `@koi/cost-aggregator` for budget tracking and usage accounting
- `@koi/core` for shared task, result, error, and branded ID types

Conceptual references:

- `packages/lib/federation` for sync/event patterns in v2
- `archive/v1/packages/ipc/federation` for vector clock helpers and conflict metadata patterns
- `/Users/sophiawj/private/claude-code-source-code` for team/task orchestration ideas such as team creation, in-process teammates, and team memory sync

## Public API

The initial public surface should stay compact and runtime-oriented.

```ts
export interface TeamRuntime {
  start(goal: TeamGoalInput): Promise<TeamRunHandle>;
  resume(input: TeamResumeInput): Promise<TeamRunHandle>;
  replay(events: readonly TeamEvent[]): TeamRuntimeSnapshot;
  getSnapshot(): TeamRuntimeSnapshot;
}

export function createTeamRuntime(
  spec: TeamSpec,
  deps: TeamRuntimeDependencies,
): TeamRuntime;
```

Primary public types:

- `TeamSpec`
- `TeamAgentSpec`
- `TeamGoalInput`
- `TeamTaskSpec`
- `TeamRunHandle`
- `TeamRuntimeSnapshot`
- `TeamEvent`
- `TeamBudgetPolicy`
- `WriteCoordinationPolicy`

`TeamRunHandle` should expose structured status and final result retrieval rather than leaking scheduler internals.

## Team Spec

`TeamSpec` defines the static orchestration policy for a run:

- participating agent types or agent pools
- decomposition hook or acceptance of a caller-supplied task graph
- budget policy
- checkpoint/replay policy
- workspace coordination policy
- merge policy
- retry/crash policy

High-level shape:

```ts
interface TeamSpec {
  readonly name: string;
  readonly agents: readonly TeamAgentSpec[];
  readonly decomposer?: TeamDecomposer;
  readonly budget: TeamBudgetPolicy;
  readonly workspacePolicy: WriteCoordinationPolicy;
  readonly retryPolicy?: TeamRetryPolicy;
  readonly checkpointPolicy?: TeamCheckpointPolicy;
  readonly mergePolicy?: TeamMergePolicy;
}
```

Each task produced by decomposition should declare:

- stable `taskId`
- human-readable subject/description
- dependency IDs
- target agent type or selection hints
- optional `fileScope`
- optional `resourceScope`
- optional budget override
- optional result kind for downstream validation

## Internal Module Layout

Proposed initial modules:

- `spec.ts`: runtime spec and configuration types
- `events.ts`: event schema and helpers
- `state.ts`: reducer from event stream to materialized runtime snapshot
- `planner.ts`: dependency analysis and runnable-wave computation
- `scheduler.ts`: dispatch, assignment, backpressure, and synchronization
- `replay.ts`: checkpoint hydrate and replay helpers
- `conflicts.ts`: vector clock compare/merge helpers and conflict decisions
- `workspace.ts`: isolation policy and shared-resource serializer
- `budget.ts`: budget slicing and remaining-budget computation
- `runtime.ts`: `createTeamRuntime()` and top-level orchestration glue
- `index.ts`: public exports

## Execution Model

Each team run proceeds through six phases.

### 1. Decompose

The caller either:

- provides a ready DAG of `TeamTaskSpec` items, or
- invokes a decomposer hook that returns tasks plus dependencies

The decomposer contract is explicit: every subtask must declare dependencies rather than relying on scheduler inference alone.

### 2. Materialize

The runtime appends initial planning events such as:

- `team.created`
- `team.started`
- `task.added`
- `dependency.declared`

These events are reduced into a `TaskBoard` snapshot. The board is now the authoritative scheduling read model.

### 3. Schedule

The planner computes runnable waves from the task board:

- tasks with all dependencies completed are runnable
- blocked tasks remain pending
- unreachable tasks are surfaced when dependencies fail terminally

The scheduler works from materialized board state, not directly from the raw event log.

### 4. Dispatch

Each runnable task is assigned to an agent runner with:

- scoped prompt/input
- upstream summaries
- target agent type
- workspace policy
- budget slice
- expected result kind

Dispatch is performed through a pluggable runner interface so the runtime does not hard-code one execution backend.

### 5. Synchronize

As workers complete, fail, heartbeat, or crash:

- append execution events
- reduce into the latest snapshot
- update task board state
- recompute runnable tasks
- honor dependency boundaries
- serialize writes for shared resources when required

### 6. Merge

Once the run reaches a terminal state, the runtime:

- collects subtask outputs
- emits merge/result events
- synthesizes a final result
- returns terminal status plus metadata

Partial success is allowed. A terminally failed branch should not block the merge of successful sibling branches unless the merge policy explicitly requires all branches.

## Event Model

The event log is append-only and durable. Checkpoints are optimization points, not authority.

Event families:

- lifecycle: `team.created`, `team.started`, `team.completed`, `team.failed`
- planning: `task.added`, `task.updated`, `dependency.declared`
- scheduling: `task.became_runnable`, `task.assigned`, `task.blocked`
- execution: `task.started`, `task.heartbeat`, `task.completed`, `task.failed`, `task.killed`
- recovery: `task.crash_detected`, `task.requeued`, `checkpoint.created`, `checkpoint.restored`
- writes/conflicts: `resource.locked`, `resource.released`, `write.conflict_detected`, `write.serialized`
- budget/merge: `budget.slice_assigned`, `budget.usage_reported`, `budget.exhausted`, `result.merged`

Common envelope fields:

- `eventId`
- `teamRunId`
- `timestamp`
- `taskId?`
- `agentId?`
- `vectorClock?`
- `payload`

The reducer in `state.ts` builds a `TeamRuntimeSnapshot` containing at least:

- current task board
- active assignments
- resource lock table
- per-agent and total budget usage
- last checkpoint metadata
- merged outputs/result summaries
- crash/retry bookkeeping

## Task Board As Read Model

`@koi/task-board` remains the authoritative representation of dependency state. The runtime should project event-log task changes into a board instance and ask the board for:

- ready tasks
- blocked tasks
- in-progress tasks
- unreachable tasks
- dependency ordering

This keeps scheduler logic aligned with the existing DAG and state-transition primitives already in the repo.

Vector clocks must not replace this model. They are attached to relevant mutations for conflict detection and merge ordering only.

## Dependency Analysis

The planner owns dependency-aware parallelization. It should support:

- pure chains
- fan-out/fan-in
- mixed DAGs with several runnable waves

Initial algorithm:

- use declared dependencies from task specs
- validate acyclicity through task-board/DAG utilities
- compute runnable sets from board readiness
- after each task state transition, recompute readiness incrementally

The planner does not need a separate global topological plan object as the main runtime state. It only needs enough ordering information to determine which tasks are currently runnable and what can run next after new completions.

## Runner Interface

The runtime should dispatch through an interface rather than directly owning sub-agent execution semantics.

Possible shape:

```ts
interface TeamAgentRunner {
  runTask(input: TeamTaskRunInput): Promise<TeamTaskRunResult>;
  resumeTask?(input: TeamTaskResumeInput): Promise<TeamTaskRunResult>;
  stopTask?(input: TeamTaskStopInput): Promise<void>;
}
```

This lets the scheduler work with:

- in-process workers
- spawned subprocess workers
- future remote workers

without rewriting the orchestration kernel.

## Recovery And Replay

Recovery is replay-first.

On resume:

1. load checkpoint if available
2. replay subsequent events into a fresh materialized snapshot
3. rebuild task board, lock table, and budget state
4. inspect any task left `in_progress`
5. detect missing heartbeats or dead workers
6. emit `task.crash_detected`
7. either requeue or fail based on retry policy

Rules:

- checkpoints are performance hints
- replay from raw events must always reconstruct state
- scheduler decisions must be reproducible from the reduced snapshot
- stale workers must not be able to complete a task after the task was requeued to another agent

## Conflict Handling

The first cut distinguishes partitioned work from shared resources.

### Partitioned Work

Tasks may declare:

- `fileScope`
- `resourceScope`

If scopes are disjoint, tasks may execute in parallel without serializer involvement.

### Shared Resources

For known shared artifacts or logical resources, writes must acquire a runtime-managed lock before mutation. Lock actions are represented in the event stream so recovery can rebuild serializer state.

Policy order for conflicting writes:

1. reject parallel completion into the same resource when no serializer lock was held
2. requeue one side if retry policy allows it
3. otherwise mark the run degraded or failed according to configured policy

The default runtime policy should prefer per-agent isolated workspaces and require serializer participation only for explicitly shared resources.

## Vector Clocks

Vector clocks are used in the first cut, but in a narrow, deliberate role.

Attach clocks to:

- task result publication
- shared metadata mutation
- lock-protected write completion
- merge events

They support:

- detection of concurrent updates
- deterministic merge/debug metadata
- replay inspection of causal ordering

They do not:

- replace the task board
- drive normal readiness/scheduling decisions
- solve semantic file merges by themselves

This approach gives the fuller conflict model requested in the issue without overloading the main scheduler with causal-resolution logic.

## Workspace Coordination Policy

The first design uses a hybrid model:

- prefer per-agent isolated workspaces when tasks claim file scopes
- allow shared workspace execution only when resources are explicitly serialized or declared safe

This policy is encoded in `WriteCoordinationPolicy`.

Recommended default behavior:

- isolated workspace for tasks with code/file mutation scope
- serializer lock manager for shared resources such as generated files, lockfiles, or coordination artifacts
- mergeback in dependency order when isolated workspaces produce overlapping downstream integration points

This follows the practical feedback captured on the issue: file-level contention is real, and isolation-first is safer than assuming parallel writes will merge cleanly.

## Budget Model

Each run has a total budget with reserve and slicing policy.

Suggested model:

```ts
interface TeamBudgetPolicy {
  readonly total: number;
  readonly reserve?: number;
  readonly defaultSlice?: number;
  readonly taskOverrides?: Readonly<Record<string, number>>;
  readonly agentOverrides?: Readonly<Record<string, number>>;
}
```

Runtime behavior:

- assign a slice when dispatching a task
- emit `budget.slice_assigned`
- consume usage reports from workers
- emit `budget.usage_reported`
- refuse new dispatch when remaining budget minus reserve is insufficient
- soft-stop and then hard-fail over-budget workers according to policy

The runtime should reuse `@koi/cost-aggregator` primitives instead of inventing a second cost-accounting system.

## Merge Policy

The runtime needs a structured merge step rather than implicit concatenation.

Responsibilities:

- collect terminal task outputs
- validate result kinds where configured
- summarize sibling branch outputs
- combine them into a final team result
- preserve partial-success metadata

The merge policy should support:

- all-success required
- partial success allowed
- best-effort synthesis with explicit failed-branch reporting

## Testing Strategy

Minimum acceptance coverage:

- fan-out/fan-in with independent tasks
- dependency chain
- mixed DAG with multiple runnable waves
- crash recovery of in-progress tasks after replay
- serializer behavior under shared-resource contention
- vector-clock detection of concurrent metadata/result updates
- budget exhaustion preventing downstream dispatch
- merge path for partial success when one branch fails terminally

Package-level tests should split between:

- reducer/event replay tests
- planner/scheduler tests
- serializer/conflict tests
- end-to-end runtime tests with a fake runner

## Documentation

Add package documentation in:

- `docs/L2/team-runtime.md`

That doc should explain:

- package role and dependency boundary
- runtime model
- event/replay model
- conflict policy
- budget model
- extension points for runners and decomposers

## Implementation Plan Shape

Implementation should land in three coherent increments.

### Increment 1: Foundation

- scaffold `@koi/team-runtime`
- define spec and event types
- implement reducer and snapshot model
- integrate `@koi/task-board`
- implement planner/runnable-wave logic
- add initial unit tests

### Increment 2: Execution

- add runner interface
- implement scheduler dispatch loop
- implement checkpoints and replay resume
- add budget slicing and usage accounting
- implement merge path

### Increment 3: Contention

- implement workspace policy abstraction
- add shared-resource serializer
- attach vector-clock conflict metadata
- add recovery tests under contention

## Risks

- The first cut may overfit to one runner backend unless the runner interface remains disciplined.
- File/resource scopes may be underdeclared by decomposers, leading to unsafe parallelism unless defaults are conservative.
- Vector-clock metadata can add complexity quickly if allowed to leak into ordinary scheduler reads.
- Replay determinism depends on clear event semantics and reducer purity.

## Open Decisions Resolved In This Spec

- Package boundary: new `@koi/team-runtime`
- Shared-state model: event-sourced core with task board snapshot authoritative
- File contention model: hybrid isolation-first plus serializer for shared resources
- Delivery target: fuller cut rather than narrow MVP

## Acceptance Mapping

Issue acceptance criteria map to this design as follows:

- Team spec schema: `TeamSpec` and related config types
- Dependency analyzer produces correct parallel plans: planner over task-board DAG state
- Scheduler dispatches with dependency respect: scheduler phase over runnable waves
- Shared task board with conflict resolution: materialized `TaskBoard` plus lock/conflict events
- Sub-agent crash recoverable via event replay: replay-first recovery model
- File write serialization works under contention: serializer/lock manager
- Tests cover target scenarios: testing strategy above
- Documented in `docs/L2/team-runtime.md`: explicit documentation deliverable
