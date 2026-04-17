# @koi/middleware-planning

Structured planning middleware that injects a `write_plan` tool so the model
can track multi-step work across turns (Layer 2).

## Why

Complex tasks span many turns. Without a structured plan, the model loses
track of what's done, in-progress, and pending — producing either premature
completions or repeated scratchwork.

This is the v2 port of the v1 `createPlanMiddleware` — restored as its own
package (issue #1836) so that goal-tracking, task-anchoring, and plan
persistence remain separately composable middlewares.

**CC parity:** mirrors Claude Code's `TodoWrite` tool — one structured-plan
call per turn, atomic replacement, plan state re-injected on the next model
call.

## Architecture

Resolve-phase middleware (priority 450 — after tool-selector, before soul).

```
onSessionStart   → allocate per-session plan state
onBeforeTurn     → reset writePlanCallsThisTurn counter
wrapModelCall    → inject system prompt + write_plan tool + plan-state message
wrapModelStream  → inject tools into streaming requests
wrapToolCall     → intercept write_plan, validate, replace plan atomically
onSessionEnd     → drop plan state
describeCapabilities → report active plan item counts
```

**Session-scoped state.** `Map<SessionId, PlanSessionState>` keeps each
session's plan isolated. Destroyed on `onSessionEnd`.

**Once-per-turn enforcement.** `writePlanCallsThisTurn` counter increments on
every `write_plan` tool call; the second call in a turn returns an error
instead of replacing the plan. `onBeforeTurn` resets the counter so the next
turn starts fresh.

**Atomic replacement.** The tool replaces the entire plan on every call — no
partial updates. The model can reorder, add, remove, or change statuses by
writing a new full plan.

## API

```typescript
import { createPlanMiddleware } from "@koi/middleware-planning";

const mw = createPlanMiddleware({
  priority: 450, // optional, default 450
  onPlanUpdate: (plan) => persistPlan(plan), // optional observability
});
```

### PlanConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `priority` | `number` | `450` | Middleware priority. Lower runs earlier. |
| `onPlanUpdate` | `(plan) => void` | — | Fires after every successful plan replacement. |

### PlanItem

```typescript
interface PlanItem {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
}
```

## Tool surface

The middleware injects a single tool into every model call:

- **Name:** `write_plan`
- **Input:** `{ plan: PlanItem[] }`
- **Output:** summary string (`"Plan updated: 3 items (1 pending, 1 in progress, 1 completed)"`)
- **Rule:** at most one call per response (second call returns an error)

The middleware also injects a system prompt (`PLAN_SYSTEM_PROMPT`) and, when
a plan is active, a second `Current plan state:` message rendering the plan
before each model call.

## Validation

`write_plan` tool input is validated before storage:

- `plan` must be an array
- Each item must be an object with `content` (non-empty string) and `status`
  (one of `pending`, `in_progress`, `completed`)

Invalid input returns `{ error: "…" }` with `metadata.planError: true` so
observer middleware can distinguish bad-input errors from genuine tool failures.

## Session isolation

Each session has its own plan and counter. A write in session A has no effect
on session B's plan or once-per-turn budget.

## Observability

- `describeCapabilities` reports `"Plan active: N items (X pending, Y in progress, Z completed)"`
- Every successful plan replacement fires `onPlanUpdate` (if configured)
- Successful `write_plan` responses include `metadata.currentPlan`
- Failed responses include `metadata.planError: true`
- Every `wrapModelCall` response includes `metadata.currentPlan`

## Related

- `@koi/middleware-goal` — user-declared objective tracking (separate concern)
- `@koi/task-tools` + `@koi/tasks` — richer task-board state (vs. lightweight plan)
- Issue #1843 — Goal / Plan / Task ecosystem umbrella
- Issue #1837 — task-anchor middleware (injects task-board reminders on idle turns)
- Issue #1842 — file-backed plan persistence
