# @koi/proactive

Proactive / autonomous tool surfaces — thin LLM-callable wrappers over `@koi/scheduler`
that let an agent put itself to sleep, wake itself up, register recurring (cron)
self-dispatches, and manage lightweight process-local monitors.

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
- cancel its own cron schedules
- create, list, update, and cancel recurring monitors backed by cron schedules

All proactive tools are thin facades over `SchedulerComponent` (the agent-facing subset of
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
// Core factory — returns the eight proactive tools as a frozen array
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

interface ProactiveToolsProviderConfig {
  /** Default text dispatched on wake when the caller does not supply one. */
  readonly defaultWakeMessage?: string;
  /** Maximum sleep duration accepted by the `sleep` tool. Defaults to 24 h. */
  readonly maxSleepMs?: number;
  /** Optional clock for deterministic testing. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Assembly priority. Defaults to COMPONENT_PRIORITY.BUNDLED. */
  readonly priority?: number;
}
```

## Tools

| Tool | Inputs | Returns |
|------|--------|---------|
| `sleep` | `duration_ms` (1..maxSleepMs), `wake_message?`, `idempotency_key?` | `{ ok: true, task_id, wake_at_ms, deduped? }` |
| `cancel_sleep` | `task_id` | `{ ok: true, removed }` |
| `schedule_cron` | `expression`, `wake_message?`, `timezone?`, `idempotency_key?` | `{ ok: true, schedule_id, deduped? }` |
| `cancel_schedule` | `schedule_id` | `{ ok: true, removed }` |
| `create_monitor` | `name`, `goal`, `check_prompt`, `expression`, `timezone?`, `context_hint?`, `idempotency_key?` | `{ ok: true, monitor_id, schedule_id, deduped? }` |
| `list_monitors` | none | `{ ok: true, monitors: MonitorSummary[] }` |
| `update_monitor` | `monitor_id`, patch fields from `create_monitor` except `idempotency_key` | `{ ok: true, monitor_id, schedule_id }` |
| `cancel_monitor` | `monitor_id` | `{ ok: true, removed }` |

Listing existing schedules is intentionally **not** exposed: the L0
`SchedulerComponent` does not currently surface a per-agent
`querySchedules`. Widening L0 to support listing belongs in its own focused
PR, not buried in a thin tool wrapper.

### `sleep`

Schedules a deferred wake of the calling agent after `duration_ms`. Returns the
`TaskId` of the queued task and the absolute `wake_at_ms` so the model can
reason about the gap. The scheduler delivers an `EngineInput` of kind `"text"`
carrying `wake_message` (or `defaultWakeMessage`) when the delay elapses.

**Mode is `"spawn"`, not `"dispatch"`.** The durable Temporal scheduler rejects
`dispatch` + `delayMs` because dispatch targets a *running* workflow (signal
delivery) and cannot defer. Spawn + delayMs is supported on both the in-memory
scheduler and Temporal: at wake time the scheduler creates a fresh agent run.
Hosts that need same-process state continuity across the wake should persist
that state through the agent's normal channels (memory, scratchpad, etc.).

Bounds: `1 <= duration_ms <= maxSleepMs`. Out-of-bounds inputs return
`{ ok: false, error: "..." }` without ever touching the scheduler.

### `schedule_cron`

Registers a cron expression with the scheduler. The expression is parsed synchronously
by the scheduler (`croner`); invalid expressions surface as `{ ok: false, error: "..." }`.
Each fire delivers a fresh `EngineInput` of kind `"text"` containing `wake_message`.

### `cancel_sleep`

Calls `SchedulerComponent.cancel(taskId)` to withdraw a pending wake-up before it
fires. Lets a later turn invalidate a sleep that has been superseded (the work the
agent was waiting on completed early, was retried via another path, etc.). Returns
`{ removed: false }` if the task already fired or never existed (idempotent).

### `cancel_schedule`

Calls `SchedulerComponent.unschedule(scheduleId)`. Returns the scheduler's boolean
removal flag inside `{ ok: true, removed }`. Unknown IDs return `removed: false`
(idempotent — safe to retry).

### Monitor tools

`create_monitor`, `list_monitors`, `update_monitor`, and `cancel_monitor` layer a
small in-memory monitor registry on top of recurring scheduler entries. A monitor stores
human-meaningful fields (`name`, `goal`, `check_prompt`, `expression`, optional
`timezone`, optional `context_hint`) and schedules a recurring `"dispatch"` wake whose
text is derived from those fields.

`list_monitors` returns summary data only: `monitor_id`, `schedule_id`, `name`, `goal`,
`expression`, and optional `context_hint`. It intentionally does **not** expose
`check_prompt`, notification delivery state, or execution history. This package slice
does not record monitor runs, acknowledgements, or any other durable audit trail.

`update_monitor` uses patch semantics: omitted fields keep their prior values. Under the
hood it creates a replacement schedule, swaps the stored monitor record to the new
`schedule_id`, and then retires the previous schedule. `cancel_monitor` removes the
monitor record and unschedules the backing cron entry.

**State limits:** monitor state is process-local and attach-local. The registry lives in
plain in-memory maps owned by the current tool set, so a fresh process start, restart,
or provider reattach begins with an empty monitor list unless the caller recreates those
monitors. There is no durable monitor registry in `@koi/proactive`.

**`idempotency_key` scope:** `create_monitor` supports best-effort dedupe only within the
same process state. Replaying the same key with identical monitor fields returns the
original `monitor_id` and `schedule_id` with `deduped: true`; reusing the key with
different fields fails closed. Failed creations clear the reservation so a retry can
start fresh. This guarantee does not survive restart or reattach.

### Idempotency (`idempotency_key`)

Both `sleep` and `schedule_cron` accept an optional caller-supplied
`idempotency_key`. The package keeps an in-memory map keyed by that string. Each
entry first lives as an *in-flight* `Promise` (atomic reservation against
concurrent same-key calls) and is replaced by a settled record once the
scheduler returns. Settled records carry a fingerprint of the original request:

| Tool | Fingerprint fields |
|------|--------------------|
| `sleep` | `duration_ms`, resolved `wake_message` |
| `schedule_cron` | `expression`, resolved `wake_message`, `timezone` |

Replay rules (apply per tool):

- **Settled match** — replay returns the original `task_id` / `schedule_id`
  plus `deduped: true`. The scheduler is **not** called.
- **In-flight** — concurrent callers await the same submission and inherit
  its result. Exactly one scheduler call per key.
- **Settled mismatch** — replay returns `{ ok: false, error: "...already registered..." }`.
  The original task/schedule is preserved; the second request fails closed.
- **Failed submission** — the rejected pending entry is removed so a retry
  with the same key starts fresh.

Entries persist until the matching `cancel_sleep` / `cancel_schedule` clears
them. We deliberately **do not** expire on wall-clock time: a backlogged or
paused scheduler may still deliver the original task after `wake_at_ms` has
passed, and silently dropping the entry would risk duplicate wake-ups.

**Scope: same-process retry guard only.** The map is in-memory. After a
process restart or agent reassembly it is empty, and a retry with the same key
registers a second wake-up / second recurring schedule. The tool descriptions
the model sees state this explicitly — `idempotency_key` is documented as
"NOT durable across process restart" so callers do not mistake it for a
cross-restart correctness guarantee.

The caller-supplied key is forwarded as `TaskOptions.idempotencyKey` so any
future scheduler implementation that honours the field durably can dedupe at
the boundary without further changes here. Until that lands, hosts that need
cross-restart safety should additionally ensure the agent that issued the
original `sleep` / `schedule_cron` is not re-driven from the same caller after
restart, or wait for the L0 widening (tracked separately) before routing
externally-triggered retries through these tools.

## Key Design Decisions

### No new L0 types

This package introduces zero new contracts. Every public concept (`SchedulerComponent`,
`TaskId`, `ScheduleId`, `EngineInput`) already lives in `@koi/core`. If a tool can't be
expressed via the existing scheduler surface, the right move is to widen the scheduler
contract — not to bury bespoke state inside `@koi/proactive`.

### Per-agent scheduler resolution

`createProactiveToolsProvider` does **not** capture a `SchedulerComponent` at
construction. Instead its `attach(agent)` looks up `agent.component(SCHEDULER)`
and builds a fresh tool set for that agent. This means a single provider can
be safely shared across many agents: each gets a closure pinned to its own
scheduler. If the agent has no `SCHEDULER` component, attach returns a `skipped`
entry rather than installing tools that would fail at call time.

The lower-level `createProactiveTools(config)` factory still requires an explicit
`SchedulerComponent` — it's the embedding point for tests and for hosts that
prefer to do their own wiring.

### Tools are mostly stateless

`sleep`, `cancel_sleep`, and `cancel_schedule` capture only the injected
`SchedulerComponent` and config. `schedule_cron` / `cancel_schedule` share a
same-process idempotency map, and the monitor tools share process-local monitor state
for create/list/update/cancel. None of this state is durable across restart or
reattach.

### Wake message is text, not a structured envelope

A wake-up that says "the timer you set 30 minutes ago just fired" is sufficient context
for the model — we deliberately avoid inventing a "wake reason" envelope until a real
caller needs it. If/when that materializes, it goes into `EngineInput` (or a new kind),
not into proactive.

### Sleep uses `"spawn"`; recurring tools use `"dispatch"`

`sleep` always uses `"spawn"` for its delayed wake-up. The deferred wake creates a fresh
agent run when the timer elapses, which is the only mode supported durably across the
in-memory scheduler and Temporal for delayed delivery.

Recurring proactive tools (`schedule_cron` and monitor-backed cron schedules) use
`"dispatch"` because each fire is a scheduler-driven self-dispatch rather than a delayed
one-shot spawn. If a future tool needs different semantics, it should get its own
explicit tool surface rather than a caller-controlled `mode` parameter.

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

## Composition planner (issue #1299)

The package additionally exposes a planning layer that turns observed
`SystemSignal`s into `CompositionPlan` values. Execution stays out of scope
— this layer ends at plan generation + approval classification. The
composition tools (`sleep` / `schedule_cron` / etc.) and the planner are
independent surfaces that share `@koi/proactive` only because both are
"proactive" autonomy primitives.

### Public API

```typescript
mapSystemSignalToCompositionTrigger(signal: SystemSignal): CompositionTrigger | undefined

createRuleBasedCompositionPlanner(config?: RuleBasedCompositionPlannerConfig): CompositionPlanner
createLlmCompositionPlanner(config: LlmCompositionPlannerConfig): CompositionPlanner

computeCompositionApproval(
  trigger: CompositionTrigger,
  estimatedCost: number,
  policy: CompositionApprovalPolicy,
  context: CompositionApprovalContext,
): boolean
```

All `Composition*` types live in `@koi/core` (L0). This package contributes
only behavior — there are no new L0 types here.

### Signal → trigger mapping

`mapSystemSignalToCompositionTrigger` is exhaustive over `SystemSignal.kind`:

| Signal kind | Resulting `CompositionMoment` | Notes |
|---|---|---|
| `governance` | `threshold_crossed` | `error_rate` adds `spawn_agent` + `notify_user` capability hints. Trigger ID format: `governance:<sensor>:<direction>:<limit>:<emittedAt>` — includes `direction` and `limit` so distinct thresholds on the same sensor (e.g. warning `> 0.3` and critical `> 0.9`) produce distinct trigger IDs and do not deduplicate against each other. |
| `forge_demand` | `capability_gap` | `missing` derived from inner `ForgeTrigger`; signal preserved in `context.forgeDemand` |
| `schedule` | `task_terminal` | outcome ∈ `completed`/`failed`/`dead_letter`/`cancelled`; only `failed`/`dead_letter` carry follow-up capability hints |
| `anomaly` (metric-shift kinds) | `frontier_changed` | `error_spike`, `model_latency_anomaly`, `token_spike`, positive `goal_drift`, `tool_rate_exceeded` |
| `anomaly` (other), `vfs`, `agent_lifecycle`, `compaction` | `undefined` | not yet mapped — kept silent rather than emitting noisy triggers |

### Rule-based planner

Deterministic planner driven by `trigger.moment.kind`. Capability gating
is mandatory — the planner reads `CompositionCapabilities.agents` and
**never emits a `spawn_agent` step for an agent type that is not
present**. The fallback when an agent type is missing is either a
non-spawn step (`notify_user` for `error_rate`) or an empty plan
(`requiresApproval = true` because zero-step plans always require
human review).

| Moment | Step(s) emitted (when capable) | Behavior when capability missing |
|---|---|---|
| `capability_gap` w/ `forge_demand{ suggestedBrickKind: "skill" }` | `forge_skill` | empty plan → approval required |
| `threshold_crossed` (`error_rate`, `direction: "above"`) | `spawn_agent("diagnostic")` + `notify_user` (high) | `notify_user` only |
| `task_terminal` (`failed` / `dead_letter`) | `spawn_agent("recovery")` | empty plan → approval required |
| `task_terminal` (`completed` / `cancelled`) | none | `cancelled` is an explicit no-op — queue cancellation never began work |
| `frontier_changed` | `spawn_agent("researcher", deferred)` | empty plan → approval required |
| `pattern_matched`, `external_event` | none | requires explicit human-driven plan |

`forge_skill` only fires for `suggestedBrickKind === "skill"`. Other forge
demand kinds (tool / agent / middleware / channel / composite) yield an
empty plan rather than a misleading `forge_skill` step.

### LLM planner

Wraps a `CompositionPlannerAdapter` (anything that maps
`{ trigger, capabilities }` → JSON string). The output is parsed against a
strict Zod schema covering every `CompositionStep` variant — `tool_call`,
`spawn_agent`, `submit_task`, `create_schedule`, `forge_skill`,
`notify_user`. Schema mismatch, malformed JSON, trigger-id mismatch, and
non-finite / negative `estimatedCost` all raise `AdapterPlanParseError`.

If `fallbackToRulePlanner` is configured, parse errors fall through to
the rule planner and the resulting plan is then **reclassified** under
the LLM planner's own `approvalPolicy` (so a rule-planner fallback
inherits the LLM-side novelty / confidence gates). Local errors raised
inside `classifyNovelty` are not silenced — they surface to the caller.

### Approval policy

`computeCompositionApproval` returns `true` (approval required) when **any**
of these hold:

- `trigger.confidence < policy.confidenceThreshold` — strict less-than:
  equal-to-threshold does **not** require approval.
- `estimatedCost > policy.maxEstimatedCost` — strict greater-than:
  equal-to-budget does **not** require approval.
- `policy.requireApprovalOnNovelty && context.isNovel`.

Novelty buckets are computed by `defaultPatternKey`. For
`threshold_crossed` triggers the key is
`<agentId>|<source>|threshold_crossed|<sensor>|<direction>|<limit>` —
**including `limit`** so that warning and critical bands on the same
sensor (e.g. `error_rate > 0.3` vs `error_rate > 0.9`) do not share
novelty credit; repeated success on a low-severity warning cannot
auto-approve a materially different critical-threshold plan.

Default policy: `{ confidenceThreshold: 0.5, maxEstimatedCost: 10,
requireApprovalOnNovelty: true }`. The rule planner additionally
short-circuits to `requiresApproval: true` whenever it produces a
zero-step plan, so the runtime never executes an empty plan silently.

## Composition executor (issue #1300, MVP)

`@koi/proactive` now also exposes an execution layer that consumes
`CompositionPlan` values after planning. The executor is intentionally thin:
it enforces the plan approval gate, executes steps sequentially, and
delegates work into injected runtime seams rather than owning new
infrastructure.

### Public API

```typescript
createCompositionExecutor(
  context: CompositionExecutionContext,
): CompositionExecutor

interface CompositionExecutionContext {
  readonly agentId: AgentId;
  readonly scheduler: SchedulerComponent;
  readonly notify: (notification: CompositionNotification) => Promise<unknown>;
  readonly spawn?: ((request: CompositionSpawnRequest) => Promise<unknown>) | undefined;
  readonly forge?: ((request: CompositionForgeRequest) => Promise<unknown>) | undefined;
}
```

The `agentId` anchor is part of the approved execution contract. Step-level
`submit_task` and `create_schedule` requests are validated against the
attached context `agentId` before they are dispatched.

Supported MVP step kinds:

- `submit_task`
- `create_schedule`
- `notify_user`

Unsupported in the MVP:

- `spawn_agent`
- `forge_skill`
- `tool_call`

Execution stops on the first unsupported or failed step. No rollback is
attempted in this version; the result reports any successfully executed
prefix.

## System Signal Sources (issue #1298)

Three `SystemSignalSource` adapters expose external operational events to a
`CompositionPlanner` consumer. All three share a close-aware async emitter
that defends against post-unsubscribe deliveries and catches handler
exceptions, routing them to `onError` when supplied:

| Factory | Signal | Upstream |
|---------|--------|----------|
| `createGovernanceSignalSource(controller, thresholds, config?)` | `{ kind: "governance" }` | Polls `GovernanceController.snapshot()` on a serialized `inFlight` / `pollRequested` drain loop, emitting on strict-`>` (or strict-`<`) threshold crossing with optional `cooldownMs`. `replay: true` emits a synthetic on-subscribe signal if a sensor is already alerting. |
| `createGroveSignalSource(config)` | `{ kind: "frontier" }` | SSE subscription to a Grove `frontier_changed` event stream; filters by `metrics` allowlist and `minImprovement` floor (rejects `NaN`/`Infinity`). Falls back to `config.now()` (default `Date.now`) when upstream omits `emittedAt`. |
| `createNexusSignalSource(config)` | `{ kind: "vfs" }` / `{ kind: "agent_lifecycle" }` | EventBus subscription mapping VFS `write`/`delete`/`rename` (with optional `pathFilters` glob suffix) and agent transition events validated against the L0 `ProcessState`, `VALID_TRANSITIONS`, and `TransitionReason` contracts. Self-loops and unknown reasons are dropped. |

Adapters fail open: malformed payloads route to `options.onError` (when
provided) and never break the source loop. Subscriptions are idempotent —
`unsubscribe()` may be called multiple times safely. The shared emitter
honors the L0 `SystemSignalSourceOptions` contract (`sampleRateMs`,
`replay`, `onError`, `onDisconnect`).

## Composition checkpoints (#1301 Part 2 foundation)

`createInMemoryCheckpointStore` is the foundation contract for durable
composition execution. It models **per-plan progress** — distinct from
`CompositionExecutionLog` which models per-side-effect dedupe. The two
coexist: the execution log keeps step-level idempotency; the checkpoint
store enables coarse-grained plan resume.

```typescript
import { createInMemoryCheckpointStore, type CheckpointSnapshot } from "@koi/proactive";

const store = createInMemoryCheckpointStore();

// After step k completes, before moving to k+1:
await store.save({
  executionId: "comp-42",
  planHash: hashPlan(plan),
  nextStepIndex: k + 1,
  stepResults: [...resultsSoFar, latestResult],
  phase: "in_progress",
  savedAt: now(),
});

// On restart, before the step loop:
const snap = await store.load("comp-42");
const start = snap !== undefined && snap.planHash === hashPlan(plan) ? snap.nextStepIndex : 0;
```

`save` validates invariants synchronously and throws on caller bugs:
empty `executionId`/`planHash`, negative or non-integer
`nextStepIndex`, or `stepResults.length !== nextStepIndex`.

The interface returns `void | Promise<void>` and `CheckpointSnapshot
| undefined | Promise<...>` so durable backends (Temporal, SQLite,
Redis) implement the same contract. Executor wiring and a Temporal-backed
implementation are tracked as separate slices of #1301 Part 2.

## Future Phases (out of scope here)

Phase 3a tracker (this issue): sleep / wake / cron tools.

| Phase | Issue | What |
|-------|-------|------|
| 3a (now) | #1195 | This package — sleep + cron |
| 3a (now) | #1297 | `SystemSignal` L0 contract (extended with `frontier` variant in #1298) |
| 3a (now) | #1298 | System signal adapters — landed in this package |
| 3a (now) | #1299 | `CompositionTrigger` + `CompositionPlanner` (rule + LLM) — landed in this package |
| 3a (now) | #1300 | `CompositionExecutor` MVP + governance gate |
| 3-4 | #1301 | Proactive delivery + temporal durability |

`brief` / `notify` / `monitor` tools are blocked on channel + webhook restoration and
are deliberately not included here.

## Proactive delivery — `createProactiveDelivery`

Routes a `ProactiveNotification` to one or more attached `ChannelAdapter`s
based on priority. Phase 3 surface; quiet hours, multi-channel fallback,
and inbox routing for `low` priority are deferred to Phase 4.

```typescript
import { createProactiveDelivery } from "@koi/proactive";

const delivery = createProactiveDelivery({
  channels: new Map([
    ["slack", slackAdapter],
    ["email", emailAdapter],
  ]),
  preferences: {
    preferredChannel: "slack",
    maxNotificationsPerHour: 30,
  },
});

const result = await delivery.send({
  priority: "high",
  content: [{ kind: "text", text: "Composition completed: dispatched diagnostic agent." }],
});
```

Routing rules:

| Priority | Routes to | Rate-limited | Quiet-hours gated |
|---|---|---|---|
| `urgent` | every channel in parallel; success if at least one delivered | no — bypasses cap and does not consume window capacity | no |
| `high` | preferred channel first; on failure, walks remaining channels in Map insertion order; first success wins | yes — exactly 1 slot per send call regardless of attempts | no |
| `normal` | `preferredChannel` if configured, else first channel by Map insertion order; single attempt (no fallback) | yes | yes — see Quiet hours below |
| `low` | `inbox.enqueue` if `inbox` configured (delivered=`["inbox"]`); else `preferredChannel` or first by insertion order, single attempt | only when falling through to channel; inbox writes do NOT consume the cap | no |

Failures are wrapped: an adapter `send` rejection becomes `{ ok: false,
reason: "all_failed", failures: [{ channel, error }] }`. Adapter
exceptions never propagate. Failed deliveries refund their rate-limit
slot. Concurrent sends at cap-1 cannot both pass — the gate reserves
its slot synchronously before any `await`.

### Quiet hours (Phase 4)

Set `quietHoursStart`, `quietHoursEnd`, and optional `timezone` (IANA,
default `"UTC"`) on `DeliveryPreferences` to suppress `normal`-priority
sends within the window. `high` and `urgent` always pass; `low` is
unaffected (inbox routing is a separate Phase 4 follow-up).

```typescript
const delivery = createProactiveDelivery({
  channels,
  preferences: {
    quietHoursStart: 22,        // suppress from 22:00
    quietHoursEnd: 6,           // through 05:59
    timezone: "America/New_York",
    preferredChannel: "slack",
  },
});
```

Window is `[start, end)` in the configured timezone; cross-midnight
windows are supported (e.g. 22→6). Suppressed sends return
`{ ok: false, reason: "quiet_hours" }` and **do not** consume the rate
limit window. Validation runs at factory construction — partial config
(only one bound set), out-of-range hours, or invalid IANA timezones
throw immediately.

### High fallback (Phase 4)

`high` priority survives a single-channel failure. Delivery walks
channels sequentially — preferred first if configured, then remaining
channels in Map insertion order. The first adapter that resolves
without throwing wins; later channels are not attempted. If every
channel throws, the result is `{ ok: false, reason: "all_failed",
failures: [...] }` with failures listed in attempt order.

Rate limit: exactly one slot is consumed per `send()` call regardless
of how many adapters the fallback walks. The slot is refunded if every
attempt fails (Phase 3 invariant).

`normal` and `low` retain single-attempt routing — there is no
fallback for those priorities.

### Inbox routing (Phase 4)

Set `inbox: InboxSink` on `ProactiveDeliveryConfig` to redirect
`low`-priority sends to a host-supplied sink (memory queue, persistent
store, scratchpad, etc.) instead of waking a channel. The sink is
called with an `InboxEnvelope` carrying the original `content`,
`threadId`, `metadata`, plus `enqueuedAt` (from the injected `now()`).

```typescript
import type { InboxSink } from "@koi/proactive";

const inbox: InboxSink = {
  enqueue: (envelope) => {
    queue.push(envelope);
  },
};

const delivery = createProactiveDelivery({ channels, inbox });
```

Successful inbox writes return `{ ok: true, delivered: ["inbox"] }`.
A sync throw or async rejection wraps into
`{ ok: false, reason: "all_failed", failures: [{ channel: "inbox", error }] }`
— there is no automatic fallback to channels because the caller
explicitly chose inbox routing.

Inbox writes do **not** consume the rate-limit window: an inbox write
is not a user-facing dispatch until the agent reads it. With no inbox
configured, `low` retains Phase-3 single-channel routing including the
rate-limit slot.

If `channels` is empty but `inbox` is set, `low` still succeeds via
the inbox — the `no_channels` early-return only applies when the
priority requires a channel.

### Per-send timeout (Phase 4)

`createProactiveDelivery({ sendTimeoutMs })` bounds every adapter
`send()` call for **`normal`, `low`, and `urgent` priorities only**.
Defaults to `undefined` (no timeout — Phase-3 behavior). When set,
an adapter that does not resolve within `sendTimeoutMs` is treated
as a failed attempt for that channel; the underlying promise is
abandoned, not awaited.

**`high` priority is NOT covered by `sendTimeoutMs`.** Because
adapters have no abort signal, a timed-out send may still complete
in the background. If timeouts applied to `high`, a stuck preferred
channel would short-circuit the fallback walk — falling through to a
different transport risks double-delivery, and `idempotencyKey` is
metadata-only (no cross-transport dedupe ledger). To preserve
high-priority redundancy, `sendTimeoutMs` is therefore scoped to
non-`high` priorities by default.

**`highSendTimeoutMs` (opt-in):** Hosts that explicitly want
timeout-bounded behavior for `high` set this separately. When set,
the first timed-out attempt becomes terminal — `reason: "timed_out"`
is returned with the in-flight rate-limit slot still consumed.
Choose this only when (a) you accept that a stuck preferred channel
will short-circuit fallback, or (b) the underlying adapter rejects
(rather than hangs) within the budget. A future `ChannelAdapter`
revision with `AbortSignal` support will make timeout-after-fallback
safe; until then, leave `highSendTimeoutMs` unset.

**New `DeliveryResult` failure reason — `"timed_out"`:**

```ts
| { ok: false; reason: "timed_out"; failures: readonly { channel: string; error: Error }[] }
```

Emitted when **every** attempt (including any `high`-fallback walk)
exceeded `sendTimeoutMs`. Mixed outcomes — some channels timed out,
at least one succeeded — return `ok: true` with the new
`partialFailures` field carrying the timed-out channels (see below).

Downstream callers performing an exhaustive switch on
`DeliveryResult.reason` MUST add a `"timed_out"` arm or the upgrade
becomes a `noImplicitReturns`/`switch`-exhaustiveness break. Callers
that only inspect `ok` continue to work but lose visibility into
timeout-only failures.

### Partial-success surface (Phase 4)

`urgent` (parallel-fan-out) and `high` (sequential-fallback) sends can
now succeed *and* report per-channel failures in the same result:

```ts
| { ok: true; delivered: readonly string[]; partialFailures?: readonly { channel: string; error: Error }[] }
```

`partialFailures` is **omitted** (not `[]`) when every attempted
channel succeeded — existing `ok: true` consumers that ignore the new
field keep working unchanged. Hosts that want to alert on
partial-degradation should check `partialFailures !== undefined`.

### Idempotency key (Phase 4)

`ProactiveNotification.idempotencyKey?: string` is forwarded into the
outbound message metadata (`OutboundMessage.metadata.idempotencyKey`)
and onto the `InboxEnvelope.metadata` for inbox routing. This is a
**metadata pass-through only** — the current `ChannelAdapter` contract
has no idempotency field, so an adapter receives the key only if it
chooses to inspect `metadata` and honor it independently.

The delivery layer does NOT dedupe on the caller's behalf. Treat the
key as observability/integration-grade plumbing for adapters that
already have transport-side dedupe (e.g. Slack `client_msg_id`), not
as a contract guarantee for retry safety. Until `ChannelAdapter`
grows an explicit idempotency field, retrying after a `timed_out`
delivery is **not** dedupe-safe even if you pass an `idempotencyKey`.

### Migration notes

| Change | Type | Action for consumers |
|---|---|---|
| `DeliveryResult.reason` adds `"timed_out"` | additive enum widening | extend exhaustive switches |
| `DeliveryResult.partialFailures` (ok-arm) | optional field, omitted when empty | no action unless you want timeout/failure observability on partial success |
| `ProactiveNotification.idempotencyKey` | optional input | no action; pass through if your adapter supports it |
| `ProactiveDeliveryConfig.sendTimeoutMs` | optional input, default unset, applies to normal/low/urgent only | no action; opt in per host |
| `ProactiveDeliveryConfig.highSendTimeoutMs` | optional input, default unset, high-priority only | leave unset to preserve high fallback under hung preferred channel |
