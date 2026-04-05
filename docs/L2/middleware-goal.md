# @koi/middleware-goal

Goal-tracking middleware that keeps agents focused on objectives (Layer 2).

## Why

Long-running agents drift from their objectives as the context window fills. This
middleware injects goal reminders into model calls and detects when objectives are
completed via heuristic keyword matching.

## Architecture

Single `wrapModelCall` + `wrapToolCall` dual middleware (priority 340, phase "resolve").

```
Model call → inject goal system message → call next → detect completions → return
Tool call  → pass through (reserved for future goal-relevance tracking)
```

**Session state:** per-session todo list (objectives + status) and adaptive interval
state (turn count, current interval, last reminder turn).

**Adaptive reminders:** Goals injected every N turns. Interval doubles when on-track
(keywords from objectives appear in recent messages), resets to base when drifting.

**Completion detection:** Heuristic scan of model response text for completion
signals (keywords like "completed", "done", checkbox markers, objective text matches).

## API

```typescript
import { createGoalMiddleware } from "@koi/middleware-goal";

const mw = createGoalMiddleware({
  objectives: ["Implement auth endpoint", "Write integration tests"],
  baseInterval: 5,   // remind every 5 turns initially
  maxInterval: 20,   // cap at 20 turns between reminders
  onComplete: (obj) => console.log(`Completed: ${obj}`),
});
```

### GoalMiddlewareConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `objectives` | `readonly string[]` | (required) | Objective strings to track |
| `header` | `string` | `"## Active Goals"` | Header for injected message |
| `baseInterval` | `number` | `5` | Turns between goal reminders |
| `maxInterval` | `number` | `20` | Maximum interval cap |
| `onComplete` | `(objective: string) => void` | — | Callback on completion |
| `isDrifting` | `IsDriftingFn` | — | Custom drift judge (replaces heuristic) |
| `detectCompletions` | `DetectCompletionsFn` | — | Custom completion judge (replaces heuristic) |
| `callbackTimeoutMs` | `number` | `5000` | Per-callback timeout (1..60000) |
| `onCallbackError` | `OnCallbackErrorFn` | — | Fires on callback error/timeout |

### Custom Callbacks (opt-in per callback)

Both the drift and completion heuristics can be replaced with user-supplied
callbacks for semantic judging (LLM-backed, stemmer-backed, etc.). Each
callback is an **independent opt-in**: providing one does not affect the
other path.

```typescript
const mw = createGoalMiddleware({
  objectives: ["Ship #1234", "Add iOS support"],

  // LLM-based drift judge — replaces heuristic keyword matching
  isDrifting: async (input, ctx) => {
    const prompt = buildDriftPrompt(input.userMessages, input.responseTexts, input.items);
    const result = await callLlm(prompt, { signal: ctx.signal }); // MUST honor signal
    return result.drifting;
  },

  // LLM-based completion judge — returns IDs of newly-completed items
  detectCompletions: async (responseTexts, items, ctx) => {
    const prompt = buildCompletionPrompt(responseTexts, items);
    const result = await callLlm(prompt, { signal: ctx.signal });
    return result.completedIds;
  },

  callbackTimeoutMs: 3000,
  onCallbackError: (info) => metrics.increment("goal.callback.error", { ...info }),
});
```

**Cooperative cancellation**: callbacks receive a composed `AbortSignal` on
their `ctx` that fires when the timeout expires OR the turn is cancelled
upstream. Callbacks MUST honor it to stop in-flight work.

**Behavior differences when opting into `detectCompletions`**:
- Completion evaluation moves from per-model-call synchronous to once-per-turn
  at turn boundary (`onAfterTurn`).
- `onComplete` fires at turn boundary (not mid-turn).
- If the process crashes or the run is cancelled before turn end, completion
  state and `onComplete` side effects from that turn are lost.
- Turn teardown and stop-gate retry start wait for the callback (bounded by
  `callbackTimeoutMs`).

**Failure policy**:
- `isDrifting` error/timeout → fail-safe: treated as `drifting = true`
  (reminders fire more aggressively, matching v1 semantics).
- `detectCompletions` error/timeout → fall back to heuristic (safer to miss
  a completion than falsely complete).
- Both fire `onCallbackError` for observability.

Callers who need synchronous, durable `onComplete` semantics should NOT
provide `detectCompletions` and keep the heuristic path.

### Pure helpers (exported)

| Function | Purpose |
|----------|---------|
| `normalizeText(text)` | Lowercase + split identifier boundaries (camelCase, `_`/`-`/`/`) |
| `extractKeywords(objectives)` | Union all non-empty tokens across objectives (preserves acronyms) |
| `renderGoalBlock(items, header)` | Render markdown todo block |
| `detectCompletions(text, items)` | Heuristic completion detection with tiered keyword matching |
| `isDrifting(messages, keywords)` | Check keyword presence in last 3 messages |
| `computeNextInterval(current, drifting, base, max)` | Adaptive interval logic |

**Tiered keyword matching** (see `matchesToken` in `goal.ts`): exact token match for keywords ≤2 chars, token-prefix with bounded inflection suffix (≤3 chars) for 3-char keywords, substring within any token for ≥4-char keywords. This balances inflection tolerance (`fix` → `fixing`) against false-positive risk for short acronyms (`ci` won't match inside `specific`).

**Known heuristic limitations** (tracked in #1512): drift detection can be suppressed by single short-token matches, and version-like identifiers (`v123` inside `v1234`) can produce false completions. The redesign issue proposes externalizing `isDrifting`/`detectCompletions` as user callbacks or LLM-driven tools.

## Layer Compliance

- Depends on: `@koi/core` (L0), `@koi/errors` (L0u)
- No L1 or peer L2 imports
- All interface properties `readonly`
- `bun run check:layers` passes
