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

### Pure helpers (exported)

| Function | Purpose |
|----------|---------|
| `extractKeywords(objectives)` | Extract 4+ char keywords for matching |
| `renderGoalBlock(items, header)` | Render markdown todo block |
| `detectCompletions(text, items)` | Heuristic completion detection |
| `isDrifting(messages, keywords)` | Check keyword presence in last 3 messages |
| `computeNextInterval(current, drifting, base, max)` | Adaptive interval logic |

## Layer Compliance

- Depends on: `@koi/core` (L0), `@koi/errors` (L0u)
- No L1 or peer L2 imports
- All interface properties `readonly`
- `bun run check:layers` passes
