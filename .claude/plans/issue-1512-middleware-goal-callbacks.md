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
  items: readonly GoalItem[],
  ctx: TurnContext,
) => readonly GoalItem[] | Promise<readonly GoalItem[]>;
```

**GoalMiddlewareConfig additions**:

```ts
interface GoalMiddlewareConfig {
  // ...existing...
  readonly isDrifting?: IsDriftingFn;
  readonly detectCompletions?: DetectCompletionsFn;
}
```

**Rationale**:
- Matches v1's `isDrifting` shape (ctx-first).
- Both support sync + async per Koi's async-by-default rule for I/O interfaces.
- Passing `ctx` gives callbacks access to session/run metadata for caching,
  telemetry, correlation.

**GoalItem export**: the existing internal `GoalItem` interface is promoted to a
public export so users can type their `detectCompletions` return value.

## Implementation changes

| File | Change |
|------|--------|
| `config.ts` | Add 2 type aliases, 2 optional config fields, validate them as functions in `validateGoalConfig`. |
| `goal.ts` | Export `GoalItem` type. Wrap heuristic calls at 2 sites (`isDrifting` in `onAfterTurn`, `detectCompletions` in `updateCompletions`) with "callback if provided, else heuristic" logic. Make `updateCompletions` async and await it at call sites. |
| `index.ts` | Re-export `GoalItem`, `IsDriftingFn`, `DetectCompletionsFn`. |
| `goal.test.ts` | New test cases for callback invocation, async support, error fallback, and default-behavior preservation. |
| `docs/L2/middleware-goal.md` | Add "Custom Callbacks" section with LLM-judge example. |
| `docs/L3/runtime.md` | Minor touch for doc-wiring CI gate. |

## Error handling

Callback throws → swallow and fall back to heuristic for that call. Matches the
existing `onComplete` pattern ("observability callbacks must not fail model
calls"). No new `onCallbackError` hook unless explicitly requested.

## Backward compatibility

- Defaults unchanged: when callbacks are absent, behavior is identical to today.
- Callback signatures are additive (optional fields).
- No renames or removed exports.

## Call sites affected

- `goal.ts:344` — `isDrifting(ctx.messages, allKeywords)` in `onAfterTurn`
- `goal.ts:264` — `detectCompletions(text, current.items)` in `updateCompletions`
- `goal.ts:375` + `goal.ts:416` — callers of `updateCompletions` need `await`

## Test plan

New test cases in `goal.test.ts`:

1. Custom `isDrifting` called with ctx, sync return respected.
2. Custom `isDrifting` async (Promise) return respected.
3. Custom `detectCompletions` called with text + items + ctx, return applied.
4. Callback throws → falls back to heuristic, model call succeeds.
5. No callbacks provided → default heuristic behavior unchanged (regression).
6. Example: mocked LLM-based drift judge demonstrating the usage pattern.

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
