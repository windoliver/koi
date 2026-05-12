# `@koi/proactive` Monitor Tool Design

Date: 2026-05-09
Issue: `#1195`
Status: Proposed

## Summary

Implement the first unblocked `monitor` slice for `@koi/proactive` as a
first-class CRUD tool family backed by the existing scheduler. This version
does not introduce a predicate engine, durable monitor storage, or delivery
channels. Instead, it stores process-local monitor specs, schedules recurring
agent wake-ups, and re-dispatches the same agent with a synthesized monitoring
brief on each scheduled fire.

## Goals

- Add a real `monitor` abstraction without leaking raw cron semantics into the
  user-facing API.
- Keep `@koi/proactive` thin and scheduler-backed, consistent with the existing
  `sleep` and `schedule_cron` tools.
- Make the first version flexible enough for practical recurring checks without
  forcing a typed target/predicate DSL too early.
- Provide full CRUD for monitor specs in the current process/attach lifecycle.

## Non-Goals

- No durable monitor registry across process restart or provider reattach.
- No notification-channel delivery in this slice.
- No monitor execution history, last-run status, or result persistence.
- No typed target/resource contract for checks.
- No new L0 contract widening for monitor reconciliation.
- No replacement of `schedule_cron`; the raw cron primitive remains available.

## Recommended Approach

The first version should implement a first-class monitor spec on top of the
current scheduler-facing proactive package rather than:

1. exposing `monitor` as a thin alias of `schedule_cron`, or
2. building a full monitoring framework with typed predicates and delivery.

This keeps the product surface understandable while preserving the package's
current architectural boundary: scheduler underneath, thin tool layer above.

## User-Facing Tool Surface

This slice introduces four tools:

- `create_monitor`
- `list_monitors`
- `update_monitor`
- `cancel_monitor`

These tools live beside the existing proactive tools:

- `sleep`
- `cancel_sleep`
- `schedule_cron`
- `cancel_schedule`

`monitor` is a higher-level recurring check abstraction. `schedule_cron`
remains the lower-level primitive for callers that want direct cron control.

## Monitor Spec

Each monitor record stores:

- `monitor_id`: tool-generated stable identifier
- `name`: human-readable label
- `goal`: what the monitor is checking for
- `check_prompt`: recurring instruction delivered back to the agent
- `expression`: cron expression
- `context_hint?`: optional short reminder about where or how to look
- `idempotency_key?`: optional create-time same-process dedupe key
- `schedule_id`: backing scheduler schedule identifier

The caller does not supply `monitor_id`. It is created by the tool.

## Tool Contracts

### `create_monitor`

Creates a recurring monitor spec and registers its backing scheduler entry.

Suggested inputs:

- `name`
- `goal`
- `check_prompt`
- `expression`
- `context_hint?`
- `timezone?`
- `idempotency_key?`

Suggested result:

```ts
{ ok: true, monitor_id, schedule_id, deduped? }
```

Behavior:

- Validates all inputs up front.
- Stores a monitor record in process-local state.
- Schedules a recurring wake-up using the scheduler.
- If `idempotency_key` is reused with an identical monitor spec in the same
  running process, returns the existing `monitor_id` and `schedule_id` with
  `deduped: true`.
- If the same key is reused with a different spec, fails closed.

### `list_monitors`

Returns active monitor records known to the current tool state.

Suggested result:

```ts
{
  ok: true,
  monitors: readonly {
    monitor_id: string;
    name: string;
    goal: string;
    expression: string;
    context_hint?: string;
    schedule_id: string;
  }[];
}
```

Behavior:

- Reads directly from process-local monitor state.
- Does not query the scheduler for hidden or orphaned schedules.

### `update_monitor`

Updates an existing monitor and rotates the backing schedule.

Suggested inputs:

- `monitor_id`
- any subset of:
  - `name`
  - `goal`
  - `check_prompt`
  - `expression`
  - `context_hint`
  - `timezone`

Suggested result:

```ts
{ ok: true, monitor_id, schedule_id }
```

Behavior:

- Fails closed if `monitor_id` is unknown.
- Treats the update as patch semantics, using existing field values for omitted
  fields.
- Cancels the old schedule, registers the new schedule, then replaces the
  monitor record.
- If the replacement schedule cannot be created, returns an error and leaves
  the original monitor record intact.

### `cancel_monitor`

Cancels the backing schedule and removes the monitor record.

Suggested inputs:

- `monitor_id`

Suggested result:

```ts
{ ok: true, removed: boolean }
```

Behavior:

- If the monitor exists, calls `SchedulerComponent.unschedule(scheduleId)`,
  removes the record, and clears any create-time idempotency mapping.
- If `monitor_id` is unknown, returns `{ ok: true, removed: false }`.
- Unknown or already-removed scheduler IDs remain idempotent at the scheduler
  layer.

Returning `removed: false` for unknown monitor IDs keeps the cancel contract
consistent with the existing proactive cancellation tools.

## Execution Model

`monitor` does not execute a tool or evaluate a predicate directly. Each fire
re-dispatches the same agent with a synthesized text prompt describing the
monitor check.

The scheduler remains the execution engine. `@koi/proactive` only:

1. stores the monitor spec in process-local state,
2. compiles it into a recurring scheduler registration, and
3. synthesizes the recurring wake/check message.

This keeps the first version thin and avoids introducing a new polling engine.

## Wake Payload

The scheduled payload should remain plain text, not a new `EngineInput` kind or
structured envelope. This matches the current design of `sleep` and
`schedule_cron`.

Conceptual wake message shape:

```text
Monitor check: dependency-watch
Goal: detect whether issue #1212 is unblocked
Check: inspect current repo and GitHub state, then decide whether follow-up is warranted
Context: look at scheduler/channel restoration issues first
```

Required sections:

- monitor label (`name`)
- goal (`goal`)
- recurring instruction (`check_prompt`)

Optional section:

- context hint (`context_hint`)

The message should be deterministic from the stored monitor record so updates
behave predictably and tests can assert exact content.

## Internal State Model

Add a new shared `MonitorToolState` created alongside the existing proactive
state objects.

Suggested shape:

```ts
interface MonitorRecord {
  readonly monitorId: string;
  readonly name: string;
  readonly goal: string;
  readonly checkPrompt: string;
  readonly expression: string;
  readonly timezone?: string;
  readonly contextHint?: string;
  readonly idempotencyKey?: string;
  readonly scheduleId: string;
}

interface MonitorToolState {
  readonly monitorsById: Map<string, MonitorRecord>;
  readonly monitorIdByIdempotencyKey: Map<string, string>;
}
```

This state is process-local and attach-local, matching the conservative pattern
already used for cron state where durable reconciliation is not yet available.

## Idempotency Model

`create_monitor` supports optional caller-supplied `idempotency_key`.

Semantics:

- Same-process only.
- Exact-match replay returns the original `monitor_id` / `schedule_id`.
- Mismatched replay fails closed.
- Failed create removes any pending reservation.
- Update and cancel do not accept idempotency keys in this first slice.

Like existing proactive cron semantics, this is explicitly not durable across
process restart or provider reattach.

## Restart And Reattach Behavior

This slice does not attempt to reconcile process-local monitor records with
durable scheduler state after restart or reattach.

Consequences:

- `list_monitors` only reflects monitors created in the current live tool state.
- A durable scheduler may still own recurring schedules after process restart,
  but `@koi/proactive` will not rediscover them in this slice.
- Recreating a monitor after restart may produce a second recurring schedule if
  the previous one still exists.

This is acceptable for the first slice because:

- it matches the current documented non-durable behavior for proactive
  idempotency state,
- it avoids inventing hidden scheduler contracts inside an L2 package, and
- true reconciliation belongs in a focused L0/L2 widening if the product needs
  durable monitor registry behavior later.

## Error Handling

All tools return result objects and must not throw for expected failures.

Expected failures include:

- invalid input schema
- duplicate idempotency key with mismatched fields
- unknown `monitor_id` on update
- scheduler schedule/unschedule failures

Errors should follow the current proactive style:

```ts
{ ok: false, error: "..." }
```

## Testing Strategy

Add colocated unit tests plus integration coverage against the real scheduler,
matching the current package convention.

Unit tests:

- `create_monitor` validates required fields before scheduler calls
- identical create + `idempotency_key` dedupes
- mismatched create + reused `idempotency_key` fails closed
- `list_monitors` returns current records
- `update_monitor` patches stored fields and rotates schedule IDs
- `update_monitor` fails for unknown monitor IDs
- `cancel_monitor` removes existing record and clears idempotency entry
- `cancel_monitor` on unknown monitor returns `{ removed: false }`
- synthesized wake message matches stored record deterministically

Integration tests:

- recurring schedule created by `create_monitor` re-dispatches the agent with
  the expected synthesized text payload
- `update_monitor` replaces the live schedule and later fires with updated text
- `cancel_monitor` prevents future firings

## File Plan

Expected files:

- `packages/lib/proactive/src/monitor-tools.ts`
- `packages/lib/proactive/src/monitor-tools.test.ts`
- updates in `packages/lib/proactive/src/create-proactive-tools.ts`
- updates in `packages/lib/proactive/src/provider.ts`
- updates in `packages/lib/proactive/src/index.ts`
- documentation updates in `docs/L2/proactive.md`

If helper extraction is needed, keep it local to `@koi/proactive` and avoid any
L0 widening in this slice.

## Open Follow-Ons

This design intentionally leaves later work for future issues or later slices
of `#1195`:

- durable monitor reconciliation across restart
- monitor execution history / last-run status
- notification-channel delivery
- `brief` integration
- typed targets or predicates
- packaging the monitor wake path into broader autonomous composition flows

## Decision

Proceed with a first-class, scheduler-backed `monitor` CRUD surface in
`@koi/proactive`, using process-local state and plain-text recurring wake
messages, while keeping durable reconciliation and delivery concerns out of
scope for this first implementation.
