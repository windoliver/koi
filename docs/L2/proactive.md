# @koi/proactive

Proactive / autonomous tool surfaces — thin LLM-callable wrappers over `@koi/scheduler`
that let an agent put itself to sleep, wake itself up, and register recurring (cron)
self-dispatches.

## Layer

L2 — runtime deps on `@koi/core` (L0) and `@koi/tools-core` (L0u — `buildTool` +
`createToolComponentProvider`). Zero peer L2 dependencies. The `SchedulerComponent`
the tools call is the L0 interface from `@koi/core`; the concrete scheduler is wired
in by the host (e.g. `@koi/runtime`) and passed in via `ProactiveToolsConfig`.

## Purpose

Phase 3a of the v2 rewrite (issue #1195). Provides the smallest useful surface for an
agent to express its own temporal autonomy:

- pause execution and request a delayed wake-up
- register a recurring cron-driven self-dispatch
- list and cancel its own cron schedules

All four tools are thin facades over `SchedulerComponent` (the agent-facing subset of
`TaskScheduler` exposed through the `SCHEDULER` component token). The package itself
holds no state, owns no lifecycle, and reaches no I/O.

## What this package does NOT own

| Concern | Owner |
|---------|-------|
| Daemon / background lifecycle | `@koi/daemon` (issue #1338) |
| Channel implementations (brief, notify) | channel packages |
| Gateway / webhook infrastructure | gateway packages |
| Scheduler core (queue, retry, cron parsing) | `@koi/scheduler` |
| SystemSignal contract / autonomous composition | issues #1297-#1301 |

If proactive needed any of these, it would either be expanded or split — never reimplement
infrastructure here.

## Public API

```typescript
// Core factory — returns the four tools as a frozen array
createProactiveTools(config: ProactiveToolsConfig): readonly Tool[]

// ComponentProvider for ECS assembly
createProactiveToolsProvider(config: ProactiveToolsProviderConfig): ComponentProvider

interface ProactiveToolsConfig {
  /** Agent-facing scheduler — typically the SCHEDULER component for the assembling agent. */
  readonly scheduler: SchedulerComponent;
  /** Default text dispatched on wake when the caller does not supply one. */
  readonly defaultWakeMessage?: string;
  /** Maximum sleep duration accepted by the `sleep` tool. Defaults to 24 h. */
  readonly maxSleepMs?: number;
}

interface ProactiveToolsProviderConfig extends ProactiveToolsConfig {
  /** Assembly priority. Defaults to COMPONENT_PRIORITY.BUNDLED. */
  readonly priority?: number;
}
```

## Tools

| Tool | Inputs | Returns |
|------|--------|---------|
| `sleep` | `duration_ms` (1..maxSleepMs), `wake_message?` | `{ ok: true, task_id, wake_at_ms }` |
| `schedule_cron` | `expression`, `wake_message?`, `timezone?` | `{ ok: true, schedule_id }` |
| `cancel_schedule` | `schedule_id` | `{ ok: true, removed }` |

Listing existing schedules is intentionally **not** exposed: the L0
`SchedulerComponent` does not currently surface a per-agent
`querySchedules`. Widening L0 to support listing belongs in its own focused
PR, not buried in a thin tool wrapper.

### `sleep`

Schedules a single deferred dispatch back to the calling agent after `duration_ms`.
Returns the `TaskId` of the queued dispatch and the absolute `wake_at_ms` so the model
can reason about the gap. The scheduler delivers an `EngineInput` of kind `"text"`
carrying `wake_message` (or `defaultWakeMessage`) when the delay elapses.

Bounds: `1 <= duration_ms <= maxSleepMs`. Out-of-bounds inputs return
`{ ok: false, error: "..." }` without ever touching the scheduler.

### `schedule_cron`

Registers a cron expression with the scheduler. The expression is parsed synchronously
by the scheduler (`croner`); invalid expressions surface as `{ ok: false, error: "..." }`.
Each fire delivers a fresh `EngineInput` of kind `"text"` containing `wake_message`.

### `cancel_schedule`

Calls `SchedulerComponent.unschedule(scheduleId)`. Returns the scheduler's boolean
removal flag inside `{ ok: true, removed }`. Unknown IDs return `removed: false`
(idempotent — safe to retry).

## Key Design Decisions

### No new L0 types

This package introduces zero new contracts. Every public concept (`SchedulerComponent`,
`TaskId`, `ScheduleId`, `EngineInput`) already lives in `@koi/core`. If a tool can't be
expressed via the existing scheduler surface, the right move is to widen the scheduler
contract — not to bury bespoke state inside `@koi/proactive`.

### Tools are stateless

`createProactiveTools` returns four `Tool` objects whose `execute` closures capture
only the injected `SchedulerComponent` and config. There is no in-memory queue,
no timers, no event listeners. Restart safety = scheduler restart safety.

### Wake message is text, not a structured envelope

A wake-up that says "the timer you set 30 minutes ago just fired" is sufficient context
for the model — we deliberately avoid inventing a "wake reason" envelope until a real
caller needs it. If/when that materializes, it goes into `EngineInput` (or a new kind),
not into proactive.

### Mode is always `"dispatch"`

The agent that called `sleep` is the same agent that should resume — we never `"spawn"`
a fresh process from a sleep call. If a future tool needs spawn semantics (e.g. periodic
"start a new triage agent" cron), it gets its own tool with its own name; we don't add
a `mode` parameter to `sleep`.

### Bounded sleep duration

Without a ceiling, an agent can hide indefinitely (or set a `Number.MAX_SAFE_INTEGER`
delay that overflows the scheduler's poll horizon). `maxSleepMs` defaults to 24 hours —
long enough for an overnight "wake me at 9 AM" but short enough that runaway delays are
visible. Callers wanting more can raise it, but we refuse to default to "forever".

## Dependencies

```json
{
  "@koi/core": "workspace:*",
  "@koi/tools-core": "workspace:*"
}
```

`@koi/scheduler` lives at L2 — the proactive package never imports it. Its
`SchedulerComponent` is injected through `ProactiveToolsConfig.scheduler`. The host
(an L3 meta-package such as `@koi/runtime`) is responsible for constructing the
scheduler and handing its agent-facing component into `createProactiveTools`.

Direct external runtime deps: none. `zod` arrives transitively via `@koi/tools-core`
where input-schema validation lives.

## Testing

Tests use a stub `SchedulerComponent` whose `submit`, `schedule`, `unschedule`, and
`querySchedules` methods record their inputs. We assert:

| Behavior | Why |
|----------|-----|
| `sleep` rejects non-positive and out-of-range `duration_ms` | input validation must fire before any scheduler call |
| `sleep` returns the scheduler's `TaskId` and computed `wake_at_ms = now + duration` | callers reason about absolute time |
| `sleep` uses `defaultWakeMessage` when `wake_message` is omitted | invariant the doc promises |
| `schedule_cron` forwards `expression`/`timezone` and surfaces parser errors as Result-style failures | failures must not throw |
| `cancel_schedule` returns `{ removed: false }` for unknown IDs without throwing | matches scheduler's boolean return |

Per project convention, tests are colocated (`*.test.ts` next to `*.ts`).
Coverage target: 80 % lines/functions/statements (project default).

## Future Phases (out of scope here)

Phase 3a tracker (this issue): sleep / wake / cron tools.

| Phase | Issue | What |
|-------|-------|------|
| 3a (now) | #1195 | This package — sleep + cron |
| 3a | #1297 | `SystemSignal` L0 contract |
| 3a | #1298 | System signal adapters |
| 3a | #1299 | `CompositionTrigger` + `CompositionPlanner` |
| 3a | #1300 | `CompositionExecutor` + governance gate |
| 3-4 | #1301 | Proactive delivery + temporal durability |

`brief` / `notify` / `monitor` tools are blocked on channel + webhook restoration and
are deliberately not included here.
