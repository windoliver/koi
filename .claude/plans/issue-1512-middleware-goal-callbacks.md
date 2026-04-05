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
export type IsDriftingFn = (ctx: TurnContext) => boolean | Promise<boolean>;
export type DetectCompletionsFn = (
  responseText: string,
  items: readonly GoalItemWithId[],
  ctx: TurnContext,
) => readonly string[] | Promise<readonly string[]>; // newly-completed item IDs
```

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

### Two execution modes (based on config)

**Heuristic mode** (no callbacks provided — default, unchanged behavior):
- Keep today's per-call immediate evaluation inside
  `wrapModelCall`/`wrapModelStream`. Heuristic `detectCompletions` runs
  immediately after each successful model response; completion state is
  merged and `onComplete` fires synchronously per model call.
- `isDrifting` heuristic still runs in `onAfterTurn`.
- **No new latency or volatility risk.** Users who don't opt into
  callbacks see zero behavior change.

**Callback mode** (either `isDrifting` or `detectCompletions` provided):
- Providing a callback is an **explicit opt-in to deferred semantic
  judging**. Completion evaluation moves off the response path to
  `onAfterTurn`, bounded by `callbackTimeoutMs`. `onComplete` fires at
  turn boundary instead of mid-turn.
- `wrapModelCall`/`wrapModelStream` push response text onto a per-turn
  list of per-call entries (preserves model-call boundaries so keywords
  from two model calls in a `model → tool → model` turn cannot add up
  to a false majority match).
- `onBeforeTurn` clears the per-turn list at turn start.
- `onAfterTurn` iterates the per-call list and invokes the callback
  (or heuristic fallback on error) once per entry, merging results
  monotonically by ID.

### Stop-gate veto handling (callback mode)

Stop-gate veto marks the **final** assistant response in a turn — earlier
successful model calls in a `model → tool → model` turn are already
accepted by the engine. Dropping the entire turn buffer would lose
legitimate completions from accepted intermediate responses.

Policy: when `ctx.stopBlocked === true`, `onAfterTurn` processes all
buffered entries **except the last** (the blocked final response).
`isDrifting` + interval update also skip for the blocked turn (drift
signal on a vetoed answer is not meaningful).

The per-turn buffer is cleared at `onBeforeTurn` regardless, so the
retry turn starts fresh.

### Volatility tradeoff (callback mode)

Callback mode defers completion merge to `onAfterTurn`. If the process
crashes or is cancelled between model response and turn end, completion
state from that turn is lost — including `onComplete` side effects.

Session state is in-memory today, so any crash loses all state anyway;
the new window is only "response already returned to user but onComplete
not yet fired." This is documented as an explicit tradeoff of opting
into callback mode, not a bug. Users who need synchronous
`onComplete` durability keep heuristic mode.

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

- `goal.ts:317` (`onSessionStart`) — assigns `id: goal-${index}` at
  initialization so every session item has a stable ID. Initializes an
  empty per-turn response buffer (used only in callback mode).
- Determine mode at middleware construction: `hasCallbacks = isDrifting
  !== undefined || detectCompletions !== undefined`.
- `goal.ts:375` + `goal.ts:416` — `wrapModelCall` + `wrapModelStream`
  finally:
  - **Heuristic mode**: unchanged (call `updateCompletions` with
    heuristic `detectCompletions` per current implementation).
  - **Callback mode**: push the response text as a new entry onto the
    session's per-turn buffer (fast sync write). Do not evaluate here.
- `onBeforeTurn` — callback mode: clear per-turn response buffer.
- `goal.ts:344` (`isDrifting` call in `onAfterTurn`) — wrap with
  callback-if-provided + timeout + composed-signal harness. Apply
  fail-safe policy on error/timeout. Skip entirely when
  `ctx.stopBlocked === true`.
- `onAfterTurn` — callback mode: iterate per-turn buffer excluding the
  last entry when `ctx.stopBlocked === true`, invoke `detectCompletions`
  callback (or heuristic fallback) once per entry, merge results
  monotonically by ID. Fire `onComplete` for newly-completed items.

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
20. **Heuristic mode unchanged** (no callbacks): `detectCompletions` fires
    per model call synchronously, `onComplete` fires mid-turn, no buffer,
    no deferred state.

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
