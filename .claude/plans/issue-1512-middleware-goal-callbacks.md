# Plan: @koi/middleware-goal callback externalization (#1512)

## Goal

Add optional `isDrifting` / `detectCompletions` callbacks to `GoalMiddlewareConfig`.
Keep existing keyword heuristic as the default when callbacks are absent. Users
who need semantic matching plug in their own LLM judge or stemmer.

**Out of scope**: goal-update tool (Option B from the issue — possible follow-up
package `@koi/goal-tool`). This plan implements Option A (callbacks) only.

## Reference designs

### v1 koi `middleware-goal` (archive/v1/packages/middleware/middleware-goal)

- `isDrifting?: (ctx: TurnContext) => boolean | Promise<boolean>` on config
  (reminder/config.ts:18)
- Dynamic goal extractor with user-supplied `summarize` (LLM) + per-session cache
  (reminder/goal-extractor.ts)
- Keyword matching exists as default; user callbacks override

### Claude Code `TodoWriteTool`

- Zero heuristic machinery. LLM marks its own progress via explicit tool calls.
- No drift detection in the tool itself.

Our Option A matches v1's pattern (callback-based override). Option B (tool) is
tracked as a follow-up in the redesign issue.

## API design

**New type exports** (config.ts):

```ts
export interface DriftJudgeInput {
  readonly userMessages: readonly InboundMessage[]; // last-N from onBeforeTurn, retry-filtered
  readonly responseTexts: readonly string[]; // recent assistant responses
  readonly items: readonly GoalItemWithId[];
}

export type IsDriftingFn = (
  input: DriftJudgeInput,
  ctx: TurnContext,
) => boolean | Promise<boolean>;

export type DetectCompletionsFn = (
  responseTexts: readonly string[], // per-model-call responses in this turn
  items: readonly GoalItemWithId[],
  ctx: TurnContext,
) => readonly string[] | Promise<readonly string[]>; // newly-completed item IDs
```

**Why messages passed explicitly (not via `ctx.messages`)**: the Koi engine
constructs `onAfterTurn` contexts with `messages: []`
(`packages/kernel/engine/src/koi.ts:756`). The middleware captures a
**rolling window** of inputs from two sources:

- Last-N user-facing messages from `onBeforeTurn`'s `ctx.messages`, filtered
  to exclude synthetic stop-gate retry system messages. These represent the
  originally-intended user intent for the turn and survive stop-gate retries.
  A per-turn snapshot is captured into `PerTurnState.userMessagesSnapshot`
  at onBeforeTurn so a later turn appending to the shared rolling buffer
  cannot change what this turn's drift callback observes.
- Per-model-call response text already buffered during
  `wrapModelCall`/`wrapModelStream` (reuse of the completion buffer).

Callback receives `{ userMessages, responseTexts }` slices of recent activity.
Not the mutated `request.messages` (priority 340 wrapModelCall fires BEFORE
inner middleware mutations like priority-400 hooks, so `request.messages` at
our layer is pre-transform and doesn't reflect the prompt the model actually
saw).

This approximation is documented as "recent user intent + recent assistant
responses." Callers needing the fully-mutated outbound prompt must build
their own innermost-priority wrapper.

**Why responseTexts is an array**: preserves per-model-call boundaries to
prevent cross-call keyword aggregation (`model → tool → model` turn).
Single callback invocation means **one timeout bounds the whole turn**
(not N × timeout). The callback contract documents: "evaluate each text
independently; return union of newly-completed IDs."

**GoalMiddlewareConfig additions**:

```ts
interface GoalMiddlewareConfig {
  // ...existing...
  readonly isDrifting?: IsDriftingFn;
  readonly detectCompletions?: DetectCompletionsFn;
  /** Max ms any single callback may run before it is aborted. Default: 5000. */
  readonly callbackTimeoutMs?: number;
}
```

**Stable item IDs (split types to preserve backward compat)**:

- Existing `GoalItem` (used as parameter type by the exported pure helpers
  `detectCompletions` and `renderGoalBlock`) stays `{ text, completed }`. No
  breaking change for external callers of those helpers.
- New exported `GoalItemWithId extends GoalItem { readonly id: string }` is
  used only for the `DetectCompletionsFn` input. IDs are auto-assigned at
  session start as `goal-${index}` from the objective order, stable for the
  session lifetime.
- Middleware session state uses `GoalItemWithId`. `updateCompletions` merges
  by ID lookup.

This solves the positional-merge hazard: callbacks return IDs of
newly-completed items and the middleware merges by ID lookup — reordering,
dedup, or filtering in the callback's return cannot corrupt completion state.

**Rationale**:
- `DetectCompletionsFn` returns `readonly string[]` (IDs) rather than full
  `GoalItem[]`. This shape is LLM-judge-friendly (`["goal-0", "goal-2"]` JSON)
  and structurally prevents wrong-objective completion bugs.
- `IsDriftingFn` matches v1's ctx-first shape.
- Both support sync + async per Koi's async-by-default rule for I/O interfaces.
- Passing `ctx` gives callbacks access to session/run metadata for caching,
  telemetry, correlation.

**Public exports**: `GoalItem` (unchanged), `GoalItemWithId` (new),
`IsDriftingFn`, `DetectCompletionsFn` all re-exported from `index.ts`.

## Implementation changes

| File | Change |
|------|--------|
| `config.ts` | Add type aliases (`IsDriftingFn`, `DetectCompletionsFn`, `OnCallbackErrorFn`), `GoalItemWithId` interface, 3 optional config fields (`isDrifting`, `detectCompletions`, `callbackTimeoutMs`, `onCallbackError`), validate callbacks as functions + `callbackTimeoutMs` as finite positive integer with a sane upper bound (e.g. 60000ms) in `validateGoalConfig`. |
| `goal.ts` | Export `GoalItem`, `GoalItemWithId` types. Buffer response text into session state during `wrapModelCall`/`wrapModelStream` (sync). Move callback evaluation (`detectCompletions` + `isDrifting`) into `onAfterTurn`. Add `composeTimeoutSignal(ctx.signal, timeoutMs)` helper. Invoke callbacks with composed-signal ctx wrapped in Promise.race + timeout. Apply split failure policy. Merge completions by ID lookup. |
| `index.ts` | Re-export `GoalItem`, `IsDriftingFn`, `DetectCompletionsFn`. |
| `goal.test.ts` | New test cases for callback invocation, async support, error fallback, and default-behavior preservation. |
| `docs/L2/middleware-goal.md` | Add "Custom Callbacks" section with LLM-judge example. |
| `docs/L3/runtime.md` | Minor touch for doc-wiring CI gate. |

## Cancellation, latency & error handling

### Per-callback opt-in (decoupled)

Each callback is an **independent opt-in** that only affects its own path.
No coupling between `isDrifting` and `detectCompletions` mode changes.

**`isDrifting` opt-in** (only drift path changes):
- Heuristic `isDrifting` call in `onAfterTurn` is replaced by the
  user callback (wrapped with timeout + composed-signal).
- Middleware buffers the turn's inbound messages during `onBeforeTurn`
  and passes them to the callback in `onAfterTurn`.
- Completion detection path is **unchanged** — still per-call
  synchronous inside `wrapModelCall`/`wrapModelStream`.
- No buffering of response texts needed.

**`detectCompletions` opt-in** (only completion path changes):
- Per-model-call immediate heuristic detection in
  `wrapModelCall`/`wrapModelStream` is **replaced** by deferred
  buffered evaluation.
- `wrapModelCall`/`wrapModelStream` push response text onto a
  per-turn list (sync, fast).
- `onBeforeTurn` clears the list.
- `onAfterTurn` invokes the callback **once** with the full list
  of per-call response texts (array). Single timeout bounds the
  whole turn's evaluation.
- `isDrifting` heuristic is unchanged unless also opted in.

**⚠️ CONTRACT CHANGE — explicit when opting into `detectCompletions`**:
This opt-in **changes `onComplete` timing** from synchronous per-model-call
(today) to once-per-turn at turn boundary. Ordering and failure surface
change materially for downstream consumers:

- `onComplete` fires **after** all model/tool work in the turn, not
  between model calls.
- If the turn never reaches `onAfterTurn` (process crash, run
  cancellation before turn end), `onComplete` **is skipped** for
  completions detected that turn.
- In a `model → tool → model` turn, existing heuristic-mode callers
  see `onComplete` fire between calls; under `detectCompletions`
  opt-in, they fire only at turn end.

The JSDoc on `GoalMiddlewareConfig.detectCompletions` and
`GoalMiddlewareConfig.onComplete` both document this tightly so callers
see it at the point of opt-in. Users requiring synchronous
`onComplete` durability do NOT provide `detectCompletions` and keep
the heuristic path.

**Neither callback provided** (default): behavior identical to today —
no new latency, no buffering, no deferred state, no volatility window.

### Stop-gate veto handling (detectCompletions opt-in only)

Stop-gate veto marks the **final** assistant response in a turn —
earlier successful model calls in a `model → tool → model` turn are
already accepted by the engine. Dropping the entire turn buffer would
lose legitimate completions from accepted intermediate responses.

Policy when `ctx.stopBlocked === true`:
- `detectCompletions` callback receives the per-call response list
  **with the last entry excluded** (the blocked final response).
- `isDrifting` evaluation is skipped entirely for blocked turns
  (drift signal on a vetoed answer is not meaningful). Interval
  update is also skipped.

The per-turn buffer is cleared at `onBeforeTurn` regardless, so the
retry turn starts fresh.

### Volatility tradeoff (detectCompletions opt-in only) — ACCEPTED

Opting into `detectCompletions` defers completion merge to
`onAfterTurn`. Documented tradeoffs:

1. **Crash/cancel loss window**: if the process crashes or the run is
   cancelled between model response and turn end, completion state
   from that turn is lost. Session state is in-memory today so any
   crash loses all state anyway, but the new window is larger:
   "response already returned to user but `onComplete` not yet fired."
2. **Turn-end / stop-gate retry latency**: `onAfterTurn` is awaited by
   the engine before emitting `turn_end` and before starting stop-gate
   retry turns. Callback execution therefore delays turn teardown and
   retry start by up to `callbackTimeoutMs`. For a default 5000ms this
   is user-visible in retry flows.
3. **No replay/idempotency**: this middleware does not provide durable
   pending-completion state. Callers whose `onComplete` side effects
   require durable at-least-once delivery must implement that in their
   callback (e.g., write to their own storage before returning).

These are explicit tradeoffs of opting into callback-based completion.
Callers who need synchronous per-call `onComplete` durability do NOT
provide `detectCompletions` and keep the heuristic path.

### Cooperative cancellation

Callbacks receive cancellation via `TurnContext.signal` (`AbortSignal`, already
present in `@koi/core`'s `TurnContext`). The middleware creates a **composed
signal** that aborts when EITHER:

- the upstream `ctx.signal` fires (turn cancelled), OR
- `callbackTimeoutMs` elapses.

Callbacks are passed a `ctx` whose `signal` is the composed signal.
Implementations **MUST** honor it to stop in-flight work (e.g. model fetches,
scorer runs) and avoid token/cost leakage after fallback.

This is documented as part of the callback contract. The middleware still
wraps the call in `Promise.race` with the timeout so it can fall back even
if the callback is uncooperative, but signal-aware callbacks also stop their
background work.

### Split failure policy by callback type

- `isDrifting` error/timeout → **treat as `drifting = true`** (fail-safe:
  shortens reminder interval to `baseInterval` so operators notice the judge
  outage instead of having reminders silently suppressed). Matches v1
  `archive/v1/packages/middleware/middleware-goal/src/reminder/goal-reminder.ts`
  behavior.
- `detectCompletions` error/timeout → **fall back to heuristic** for that call.
  Completions are monotonic, so the safer failure is a missed completion
  (detected next turn) rather than a false one.

### Failure visibility (new `onCallbackError` hook)

Silent-swallow is replaced by a structured failure surface. New optional
config:

```ts
readonly onCallbackError?: (info: {
  readonly callback: "isDrifting" | "detectCompletions";
  readonly reason: "error" | "timeout";
  readonly error?: unknown;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
}) => void;
```

Called once per failure. Errors inside `onCallbackError` itself are swallowed
(observability must not fail the turn).

## Backward compatibility

- Defaults unchanged: when callbacks are absent, behavior is identical to today.
- Callback signatures are additive (optional fields).
- **No breaking changes to public API**: `GoalItem` is unchanged. New
  `GoalItemWithId` is additive. Internal session state moves from `GoalItem`
  to `GoalItemWithId`. `updateCompletions` merge switches from positional map
  to ID lookup.
- No renames or removed exports of public API.

## Call sites affected

- `goal.ts:317` (`onSessionStart`) — assigns `id: goal-${index}`;
  initializes an empty per-turn response-text buffer and a
  turn-messages buffer.
- `onBeforeTurn` — clears per-turn response-text buffer (if
  `detectCompletions` opted in). Appends `ctx.messages` into a
  rolling user-messages buffer (bounded last-K, default 10),
  filtering synthetic stop-gate retry system messages
  (`[Completion blocked] ...`).
- `wrapModelCall` / `wrapModelStream` — response-text buffer
  already populated for completion path; also serves as
  assistant-response input for the `isDrifting` callback's
  `DriftJudgeInput.responseTexts`.
- `goal.ts:375` + `goal.ts:416` — `wrapModelCall` / `wrapModelStream`
  finally:
  - If `detectCompletions` callback is **not** configured: unchanged
    (call `updateCompletions` with heuristic per-response immediately,
    fires `onComplete` synchronously).
  - If `detectCompletions` callback **is** configured: push the
    response text onto the per-turn buffer (fast sync write). No
    evaluation here.
- `goal.ts:344` (`isDrifting` call in `onAfterTurn`):
  - If `isDrifting` callback configured: invoke callback with
    turn-messages buffer + items + ctx, wrapped in timeout +
    composed-signal harness. Apply fail-safe policy
    (error/timeout → treat as drifting).
  - Otherwise: unchanged heuristic.
  - Skip entirely when `ctx.stopBlocked === true`.
- `onAfterTurn` — when `detectCompletions` callback configured:
  gather per-turn response-text buffer (excluding last entry if
  `ctx.stopBlocked`), invoke callback **once** with the full list,
  wrapped in timeout + composed-signal. Merge newly-completed IDs
  monotonically. Fire `onComplete` for transitions. On error/timeout,
  fall back to heuristic per-entry.

## Test plan

New test cases in `goal.test.ts`:

1. Custom `isDrifting` called with ctx (sync), return respected.
2. Custom `isDrifting` async (Promise) return respected.
3. Custom `detectCompletions` IDs merge by lookup (reorder/dedup in callback
   return cannot misapply completion state — positional-hazard guard).
4. Custom `detectCompletions` with unknown IDs → no state change (ignored).
5. `isDrifting` throws → fires `onCallbackError(reason="error")`, treated
   as drifting, interval resets to base.
6. `isDrifting` exceeds `callbackTimeoutMs` → fires
   `onCallbackError(reason="timeout")`, treated as drifting.
7. `detectCompletions` throws → fires `onCallbackError`, falls back to
   heuristic, model call succeeds.
8. `detectCompletions` timeout → fires `onCallbackError`, heuristic fallback.
9. **Response-path latency**: slow callback (2000ms) does NOT delay
   `wrapModelCall` return — assert that the model response arrives before
   `onAfterTurn` resolves the callback.
10. **Cancellation**: callback receives an `AbortSignal` on its ctx that
    fires at `callbackTimeoutMs`; assert signal.aborted === true inside
    the callback when the timer elapses.
11. **Upstream abort**: when `ctx.signal` aborts before timeout, the
    composed signal fires immediately.
12. `onCallbackError` hook itself throws → swallowed, turn continues.
13. `callbackTimeoutMs` validation: rejects 0, negative, NaN, Infinity,
    non-integer, values above the documented upper bound.
14. No callbacks provided → default heuristic behavior unchanged
    (regression guard).
15. GoalItem IDs stable across turns within a session.
16. Example: mocked LLM-based drift judge demonstrating the usage pattern
    and cooperative cancellation.
17. **Per-call scoping (model→tool→model turn)**: two responses in one turn
    each containing only part of an objective's keywords — item MUST NOT be
    marked complete (callback is called twice with different per-call text,
    neither call alone satisfies the objective).
18. **Stop-gate veto preserves earlier completions**: in a 2-call turn where
    the first response legitimately completes an objective and the second
    is stop-gate vetoed — the earlier completion IS merged, the blocked
    entry IS skipped, `isDrifting` is skipped.
19. **Buffer reset on retry**: per-turn response-text list cleared at
    `onBeforeTurn` so the retry turn after stop-gate veto starts fresh.
20. **Heuristic unchanged** (no callbacks): `detectCompletions` fires
    per model call synchronously, `onComplete` fires mid-turn, no buffer,
    no deferred state.
21. **Partial opt-in (only isDrifting)**: `detectCompletions` path stays
    per-call synchronous, `onComplete` fires mid-turn, no response-text
    buffering. Only drift path uses callback.
22. **Partial opt-in (only detectCompletions)**: `isDrifting` uses
    heuristic, `detectCompletions` is buffered + deferred + single
    callback invocation.
23. **Per-turn latency budget**: single timeout bounds the entire
    callback invocation in `onAfterTurn`, not per-entry N × timeout.
24. **isDrifting receives per-turn snapshot**: messages sourced from a
    rolling last-K buffer populated in `onBeforeTurn` from
    `ctx.messages` (synthetic stop-gate retry `[Completion blocked]`
    messages filtered out). A snapshot is captured into `PerTurnState`
    at turn start so overlap cannot let turn N observe turn N+1's
    appended messages.
25. **Stop-gate retry message sanity**: synthetic
    `[Completion blocked] ...` system messages are filtered from the
    rolling buffer, so the `isDrifting` callback sees only real user
    transcript content.
26. **`onComplete` timing contract — explicit**: under
    `detectCompletions` opt-in, `onComplete` fires at turn boundary
    (not mid-turn). Turn that never reaches `onAfterTurn` (crash,
    cancel) → `onComplete` is skipped for that turn's detections.
    This is a documented CONTRACT CHANGE of opting in.

## Estimated footprint

~120-160 LOC code (including signal composition helper, onAfterTurn
refactor, error hook), ~140 LOC tests (16 cases), ~40 LOC docs. Larger
than the original estimate due to the cancellation + off-path-execution
requirements but still within the 300-line PR budget.

## Open design questions

1. **Export keyword helpers for composition?** Users can already import
   `isDrifting`/`detectCompletions` pure functions to combine with their own
   logic. No additional export needed.
2. **`onCallbackError` hook?** Not in initial scope. Match existing silent
   swallow pattern. Add if observability requirement emerges.
3. **Ship an actual LLM judge implementation?** No — the middleware stays
   dependency-free. Tests include a mocked async callback.
