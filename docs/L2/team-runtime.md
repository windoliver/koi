# @koi/team-runtime

Parallel multi-agent team orchestration with dependency-aware scheduling, replay-friendly event reduction, budget slicing, and shared-resource conflict control.

## Purpose

`@koi/team-runtime` is the L2 orchestration kernel for issue #1647 and the team-tool surface for issue #1416. It turns decomposed work into a stable task-board snapshot, computes runnable waves, keeps replay as the recovery boundary, and exposes file-backed coordination primitives for lead/member team workflows.

## Architecture

- `reduceTeamEvents()` is the authoritative reducer for task, assignment, and output state.
- `replayTeamRun()` is the shared replay entry point used by `createTeamRuntime()` to rebuild resumable snapshots.
- `planRunnableTasks()` and `createTeamScheduler()` sit on top of the reduced board state so scheduling stays deterministic and testable.
- Budget and conflict helpers stay separate from replay so recovery logic remains pure and side-effect free.
- `createTeamManager()` owns the user-facing team registry, validates lead/member identity, and exposes LLM-callable tool providers for team create/delete, task assignment, and task reports.
- `createFileTeamMailbox()` persists coordination messages in JSON files with lockfile-guarded writes so team handoffs survive process boundaries.
- Plan-approval helpers track in-process teammate work and route approval requests/responses back through the mailbox protocol.

## Main API

```ts
import {
  createTeamRuntime,
  createTeamScheduler,
  createTeamManager,
  createFileTeamMailbox,
  handlePlanApprovalResponse,
  planRunnableTasks,
  replayTeamRun,
} from "@koi/team-runtime";
```

Use `createTeamRuntime(spec)` when you want a small orchestration surface with `start()`, `resume()`, `replay()`, and `getSnapshot()`. Use `replayTeamRun(events)` directly in tests or recovery code when you only need deterministic snapshot reconstruction.

Use `createTeamManager({ agentId, agentName, mailbox })` when a host wants to expose the issue #1416 team tools. The manager enforces lead-only assignment, rejects duplicate teams or duplicate/blank member ids, validates reporter identity on task reports, and can call an injected spawn hook when assigning work. `createTeamToolProviders(manager)` returns the four tool providers consumed by L3 hosts:

- `TeamCreate`
- `TeamDelete`
- `TeamAssignTask`
- `TeamReportTask`

Use `createFileTeamMailbox({ dir })` to exchange typed protocol messages between teammates. The mailbox supports read/unread queries, mark-read, clear, and write operations, plus parsers for plan-approval requests/responses, task assignments, and task reports. Message writes are serialized with an advisory lock file and replace-on-write JSON updates.

In this Task 5 slice, `createTeamRuntime(spec)` only validates and retains enough of `spec` to seed a `team.created` replay snapshot. `start({ goal, tasks })` currently accepts `goal` and optional `tasks` for future API stability, but it does not schedule work, materialize tasks, or execute agents yet. It returns a snapshot handle whose `getStatus()` is always `"snapshot_ready"` and whose `getResult()` simply resolves to the same current snapshot returned by `getSnapshot()`.

## Replay Model

Team-runtime treats the event stream as the source of truth for recovery. A caller can persist `TeamEvent[]`, feed it back through `replayTeamRun()` or `runtime.replay()`, and receive the same `TeamRuntimeSnapshot` shape the scheduler reads during normal execution.

`resume({ events })` is likewise snapshot-only in this slice: it replays the provided events and returns a handle over that replayed snapshot. There is no background lifecycle, task execution, or completion tracking behind the handle yet.

## Team Tool Protocol

Team tools persist their state through the supplied mailbox, so hosts can reconstruct visible team state from messages instead of relying on process-local memory alone. `TeamAssignTask` writes a task-assignment message addressed to the assignee and marks the task `in_progress`; `TeamReportTask` accepts only the assigned teammate's report and writes a task-report message before updating the task status.

Plan-mode coordination is intentionally separate from generic task assignment. `isPlanModeRequired()` detects teammate tasks that need a plan approval gate, `setAwaitingPlanApproval()` records the waiting state, and `handlePlanApprovalResponse()` applies an approval/rejection response to the matching in-process teammate task.

## Recovery

Replay is the authority boundary. `task.crash_detected` returns orphaned in-progress work to a schedulable pending state so a resumed run can continue from the next valid dependency wave instead of keeping a dead assignment pinned forever.

## Related Packages

- [`@koi/agent-runtime`](/Users/sophiawj/.codex/worktrees/a000/koi/docs/L2/agent-runtime.md) provides the agent-definition layer that upstream orchestration can target.
- [`@koi/federation`](/Users/sophiawj/.codex/worktrees/a000/koi/docs/L2/federation.md) provides cross-zone coordination primitives that later team-runtime integrations can use for distributed execution.
