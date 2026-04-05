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

### Off-path execution (no response-tail latency)

Callback evaluation moves **off the `wrapModelCall`/`wrapModelStream`
critical path** entirely:

- `wrapModelCall`/`wrapModelStream` push the response text onto a
  **per-turn list of per-call entries** in session state (sync, fast). The
  list preserves model-call boundaries so completion evaluation runs on each
  response individually, not on concatenated turn text. This prevents false
  completions where keywords from two different model responses in the same
  `model → tool → model` turn add up to a majority match.
- `onBeforeTurn` clears the per-turn response-text list at turn start.
- `onAfterTurn` (already async, runs between turns) iterates the list and
  invokes `detectCompletions` **once per entry** (merging results
  monotonically by ID), then invokes `isDrifting` + interval update.

### Stop-gate veto handling

`TurnContext` carries `stopBlocked?: true` when the turn was rejected by
stop-gate. `onAfterTurn` runs for blocked turns before the retry turn
starts. The plan handles this explicitly:

- When `ctx.stopBlocked === true`, `onAfterTurn` **early-returns** — no
  callback invocation, no completion state mutation, no drift interval
  update, no `onComplete` firing.
- The per-turn response-text list is cleared at `onBeforeTurn` regardless,
  so the retry turn starts with a fresh buffer.

This prevents vetoed response text from corrupting goal state or firing
callbacks on a model answer the engine explicitly rejected.

### Result

Removes user-visible latency from slow LLM judges. Completion state still
settles before the next turn (non-blocked), so `onComplete` semantics are
preserved. Minor behavior change: `onComplete` fires in `onAfterTurn`
instead of during `wrapModelCall` (still once per completion, no
functional difference for downstream consumers).

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

- `goal.ts:264` (`updateCompletions` inner call to `detectCompletions`) and
  `goal.ts:344` (`isDrifting` call) both **relocate** to `onAfterTurn`. Both
  wrapped in the callback-if-provided + timeout + composed-signal harness.
  `onAfterTurn` early-returns when `ctx.stopBlocked === true`.
- `goal.ts:375` + `goal.ts:416` — callers inside `wrapModelCall` and
  `wrapModelStream` finally: no longer call `updateCompletions` with detect
  logic; instead they **push the response text as a new entry** onto the
  session's per-turn response-text list (a fast synchronous state write).
  The heavy work happens in `onAfterTurn`, per entry.
- `onBeforeTurn` — adds per-turn response-text list reset at turn start.
- `onSessionStart` (`goal.ts:317`) — assigns `id: goal-${index}` at
  initialization so every session item has a stable ID from turn 0.
  Initializes the per-turn response-text list to `[]`.

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
18. **Stop-gate veto**: when `ctx.stopBlocked === true`, `onAfterTurn` does
    not call `detectCompletions`, does not call `isDrifting`, does not
    mutate completion state, does not fire `onComplete`.
19. **Buffer reset on retry**: response-text list cleared at `onBeforeTurn`
    so retry turn after stop-gate veto starts with fresh buffer.

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
