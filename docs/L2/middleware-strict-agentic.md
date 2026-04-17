# @koi/middleware-strict-agentic

Blocks premature model completion on filler/plan-only turns so agentic workflows keep acting until a real blocker is reached.

## When to install

Install for agents in autonomous/agentic workflows that tend to produce "I will now do X" planning turns and stop without acting. Do **not** install for conversational agents — leave it out of the manifest.

## Configuration

```typescript
import { createStrictAgenticMiddleware } from "@koi/middleware-strict-agentic";

const { middleware } = createStrictAgenticMiddleware({
  enabled: true,
  maxFillerRetries: 3,
});
```

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `enabled` | `boolean` | `true` | Master switch. When `false`, middleware is a no-op. |
| `maxFillerRetries` | `number` | `3` | Consecutive filler blocks per session before circuit-breaker releases. |
| `feedbackMessage` | `string?` | see below | Override text injected when blocking. |
| `isUserQuestion` | `(output: string) => boolean` | trimmed output ends with `?` | Exempt turns that ask the user a direct question. |
| `isExplicitDone` | `(output: string) => boolean` | terminal `done`/`completed`/`finished`/`no further action` in the last 80 chars AND no negation (`not`, `n't`, `yet`, etc.) in that window | Exempt turns that explicitly declare completion. |

Default feedback:

> You produced a plan or status update without executing it. The session is in strict-agentic mode — continue by taking the next concrete action (call a tool or make a change). Do not describe what you will do; do it. If you are blocked on external input, end your reply with a direct question to the user.

## Classifier rules

On each turn, the middleware evaluates in order:

1. One or more tool calls in the response → **action** (continue).
2. Output passes `isUserQuestion` → **user-question** (continue).
3. Output passes `isExplicitDone` → **explicit-done** (continue).
4. Otherwise → **filler** (block unless circuit breaker is tripped).

## Circuit breaker

- Increments on every filler block.
- Resets on any non-filler turn.
- Releases (returns `continue`) once `consecutiveBlocks > maxFillerRetries`.

When it releases, calls `ctx.reportDecision({ event: "strict-agentic:circuit-broken", sessionId, consecutiveBlocks, maxFillerRetries })` so operators can distinguish breaker-release from a legitimate non-filler completion in traces.

## Troubleshooting

**False positive on summary turns.** If your model legitimately summarizes completed work without tool calls, supply a stricter `isExplicitDone` predicate.

**Non-English question marks.** The default `isUserQuestion` checks only ASCII `?`. Provide a locale-aware predicate if needed (e.g. also match `？`).

## Open questions

- The L0 `KoiMiddleware` surface exposes `onSessionEnd` and `onAfterTurn` for state cleanup — used to drop turn-scoped and session-scoped state respectively.
