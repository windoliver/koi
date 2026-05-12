# @koi/team-runtime

Parallel multi-agent team orchestration with dependency-aware scheduling, replay-friendly event reduction, budget slicing, and shared-resource conflict control.

## Purpose

`@koi/team-runtime` is the L2 orchestration kernel for issue #1647. It turns decomposed work into a stable task-board snapshot, computes runnable waves, and keeps replay as the recovery boundary so callers can rebuild runtime state from an append-only event log.

## Architecture

- `reduceTeamEvents()` is the authoritative reducer for task, assignment, and output state.
- `replayTeamRun()` is the shared replay entry point used by `createTeamRuntime()` to rebuild resumable snapshots.
- `planRunnableTasks()` and `createTeamScheduler()` sit on top of the reduced board state so scheduling stays deterministic and testable.
- Budget and conflict helpers stay separate from replay so recovery logic remains pure and side-effect free.

## Main API

```ts
import {
  createTeamRuntime,
  createTeamScheduler,
  planRunnableTasks,
  replayTeamRun,
} from "@koi/team-runtime";
```

Use `createTeamRuntime(spec)` when you want a small orchestration surface with `start()`, `resume()`, `replay()`, and `getSnapshot()`. Use `replayTeamRun(events)` directly in tests or recovery code when you only need deterministic snapshot reconstruction.

In this Task 5 slice, `createTeamRuntime(spec)` only validates and retains enough of `spec` to seed a `team.created` replay snapshot. `start({ goal, tasks })` currently accepts `goal` and optional `tasks` for future API stability, but it does not schedule work, materialize tasks, or execute agents yet. It returns a snapshot handle whose `getStatus()` is always `"snapshot_ready"` and whose `getResult()` simply resolves to the same current snapshot returned by `getSnapshot()`.

## Replay Model

Team-runtime treats the event stream as the source of truth for recovery. A caller can persist `TeamEvent[]`, feed it back through `replayTeamRun()` or `runtime.replay()`, and receive the same `TeamRuntimeSnapshot` shape the scheduler reads during normal execution.

`resume({ events })` is likewise snapshot-only in this slice: it replays the provided events and returns a handle over that replayed snapshot. There is no background lifecycle, task execution, or completion tracking behind the handle yet.

## Recovery

Replay is the authority boundary. `task.crash_detected` returns orphaned in-progress work to a schedulable pending state so a resumed run can continue from the next valid dependency wave instead of keeping a dead assignment pinned forever.

## Related Packages

- [`@koi/agent-runtime`](/Users/sophiawj/.codex/worktrees/a000/koi/docs/L2/agent-runtime.md) provides the agent-definition layer that upstream orchestration can target.
- [`@koi/federation`](/Users/sophiawj/.codex/worktrees/a000/koi/docs/L2/federation.md) provides cross-zone coordination primitives that later team-runtime integrations can use for distributed execution.
