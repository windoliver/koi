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
| `config.ts` | Add 2 type aliases, 2 optional config fields, validate them as functions in `validateGoalConfig`. |
| `goal.ts` | Export `GoalItem` type. Wrap heuristic calls at 2 sites (`isDrifting` in `onAfterTurn`, `detectCompletions` in `updateCompletions`) with "callback if provided, else heuristic" logic. Make `updateCompletions` async and await it at call sites. |
| `index.ts` | Re-export `GoalItem`, `IsDriftingFn`, `DetectCompletionsFn`. |
| `goal.test.ts` | New test cases for callback invocation, async support, error fallback, and default-behavior preservation. |
| `docs/L2/middleware-goal.md` | Add "Custom Callbacks" section with LLM-judge example. |
| `docs/L3/runtime.md` | Minor touch for doc-wiring CI gate. |

## Error handling & timeout contract

**Timeout**: every callback invocation is wrapped in `Promise.race` with
`callbackTimeoutMs` (default 5000ms). On timeout the callback is treated as a
failure case. This bounds the new async dependency the middleware introduces
on the model-response path (`wrapModelCall` + `wrapModelStream` finally block).

**Split failure policy by callback type**:

- `isDrifting` error/timeout → **treat as `drifting = true`** (fail-safe:
  shortens reminder interval to `baseInterval` so the user notices the judge
  outage instead of having reminders silently suppressed). Matches v1
  `archive/v1/packages/middleware/middleware-goal/src/reminder/goal-reminder.ts`
  behavior.
- `detectCompletions` error/timeout → **fall back to heuristic** for that call.
  Completions are monotonic, so the safer failure is a missed completion
  (detected next turn) rather than a false one.

Both failures are swallowed (no thrown error reaches the model path). For
observability, we keep the existing silent-swallow pattern — no new
`onCallbackError` hook in this PR, but `onComplete` will still fire for any
heuristic-detected completion during fallback.

## Backward compatibility

- Defaults unchanged: when callbacks are absent, behavior is identical to today.
- Callback signatures are additive (optional fields).
- **No breaking changes to public API**: `GoalItem` is unchanged. New
  `GoalItemWithId` is additive. Internal session state moves from `GoalItem`
  to `GoalItemWithId`. `updateCompletions` merge switches from positional map
  to ID lookup.
- No renames or removed exports of public API.

## Call sites affected

- `goal.ts:344` — `isDrifting(ctx.messages, allKeywords)` in `onAfterTurn`
- `goal.ts:264` — `detectCompletions(text, current.items)` in `updateCompletions`
- `goal.ts:375` + `goal.ts:416` — callers of `updateCompletions` need `await`

## Test plan

New test cases in `goal.test.ts`:

1. Custom `isDrifting` called with ctx, sync return respected.
2. Custom `isDrifting` async (Promise) return respected.
3. Custom `detectCompletions` called with text + items + ctx; returned IDs
   merge correctly by lookup (reorder/dedup in callback return cannot misapply
   completion state — positional-hazard regression guard).
4. Custom `detectCompletions` with unknown IDs → no state change (ignored).
5. `isDrifting` throws → treated as `drifting = true`, interval resets to base.
6. `isDrifting` exceeds `callbackTimeoutMs` → same fail-safe behavior.
7. `detectCompletions` throws → falls back to heuristic, model call succeeds.
8. `detectCompletions` exceeds `callbackTimeoutMs` → same fallback.
9. No callbacks provided → default heuristic behavior unchanged (regression).
10. Example: mocked LLM-based drift judge demonstrating the usage pattern.
11. GoalItem IDs stable across turns within a session.

## Estimated footprint

~80-100 LOC code, ~80 LOC tests, ~30 LOC docs. Well under the 300-line PR budget.

## Open design questions

1. **Export keyword helpers for composition?** Users can already import
   `isDrifting`/`detectCompletions` pure functions to combine with their own
   logic. No additional export needed.
2. **`onCallbackError` hook?** Not in initial scope. Match existing silent
   swallow pattern. Add if observability requirement emerges.
3. **Ship an actual LLM judge implementation?** No — the middleware stays
   dependency-free. Tests include a mocked async callback.
