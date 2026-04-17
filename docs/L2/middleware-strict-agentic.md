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
| `maxFillerRetries` | `number` (>= 1) | `2` | Consecutive filler blocks per run before circuit-breaker releases. A value of N means "block N times, release on attempt N+1." The default of 2 aligns with the engine's `DEFAULT_MAX_STOP_RETRIES=3` so the release signal fires within budget. `0` is rejected by validation — use `enabled: false` to disable. |
| `feedbackMessage` | `string?` | see below | Override text injected when blocking. |
| `isUserQuestion` | `(output: string) => boolean` | final sentence ends with `?` AND either starts with a user-directed marker (`Should I`, `Can you`, `Do you`, …) or contains `you` as a pronoun | Exempt turns that ask the user a direct question. Rhetorical/self-directed questions (`Run the migration now?`) do NOT satisfy the default. |
| `isExplicitDone` | `(output: string) => boolean` | terminal `done`/`completed`/`finished`/`no further action` in the last 80 chars AND no negation (`not`, `n't`, `yet`, etc.) in that window | Exempt turns that explicitly declare completion. |
| `isFillerOutput` | `(output: string) => boolean` | matches first-person-future constructions (`i will`, `i'll`, `i'm going to`, `here is my plan`, `the plan is`, `let me <verb>` excluding `let me know …`, etc.) | Positive match for planning language — the ONLY text-based path that blocks. |

Default feedback:

> You produced a plan or status update without executing it. The session is in strict-agentic mode — continue by taking the next concrete action (call a tool or make a change). Do not describe what you will do; do it. If you are blocked on external input, end your reply with a direct question to the user.

## Classifier rules

On each turn, the middleware evaluates in order:

1. One or more tool calls in the response → **action** (continue).
2. Output passes `isUserQuestion` → **user-question** (continue).
3. Output passes `isExplicitDone` → **explicit-done** (continue).
4. Output passes `isFillerOutput` → **filler** (block unless circuit breaker is tripped).
5. Otherwise → **action** (continue).

Blocking requires a positive filler match. Plain substantive answers like `"10"` or `"Updated 3 files"` — concise final completions after prior tool use — fall through to `action` and are allowed to complete. The gate never re-prompts based on absence of evidence alone.

## Circuit breaker

- Increments on every filler block.
- Resets on any non-filler turn.
- **Resets at the start of every outer turn** (`onBeforeTurn`) so one exhausted request does not poison the next one in a long-lived session.
- Releases (returns `continue`) once `consecutiveBlocks > maxFillerRetries` — i.e., on the (N+1)th attempt when `maxFillerRetries = N`.

The default `maxFillerRetries: 2` is chosen to match the engine's `DEFAULT_MAX_STOP_RETRIES=3`: two blocks happen within budget, the third stop-gate call releases with the breaker signal.

When it releases, calls `ctx.reportDecision({ event: "strict-agentic:circuit-broken", sessionId, consecutiveBlocks, maxFillerRetries })` so operators can distinguish breaker-release from a legitimate non-filler completion in traces.

## Troubleshooting

**False positive on summary turns.** If your model legitimately summarizes completed work without tool calls, supply a stricter `isExplicitDone` predicate.

**Non-English question marks.** The default `isUserQuestion` checks only ASCII `?`. Provide a locale-aware predicate if needed (e.g. also match `？`).

## Open questions

- The L0 `KoiMiddleware` surface exposes `onSessionEnd` and `onAfterTurn` for state cleanup — used to drop turn-scoped and session-scoped state respectively.
