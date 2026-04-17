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

const plan = createPlanMiddleware({
  priority: 450, // optional, default 450
  onPlanUpdate: async (plan) => persistPlan(plan), // optional, sync or async
});

await createKoi({
  middleware: [..., plan.middleware],
  providers:  [..., ...plan.providers],
});
```

`createPlanMiddleware` returns a `MiddlewareBundle`. The `middleware` half
wires the `write_plan` interception behavior; the `providers` half
attaches the `write_plan` Tool to the agent's component graph so the
query-engine's advertised-tool snapshot recognizes the call as
declared. **Both halves must be wired** — registering only the
middleware would cause every real `write_plan` call to be rejected as
an undeclared tool and fail the turn.

### PlanConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `priority` | `number` | `450` | Middleware priority. Lower runs earlier. |
| `onPlanUpdate` | `(plan) => void \| Promise<void>` | — | Commit hook. See "commit-with-rollback" below. |

#### `onPlanUpdate` semantics (hook-then-commit)

The hook runs BEFORE any in-memory commit — overlapping turns cannot
observe a plan that has not yet been durably accepted. It may be sync
or async; the middleware awaits the returned value and only promotes
the new plan to `currentPlan` on success.

- If the hook **returns (resolves)** normally, the plan is committed
  to in-memory state and `write_plan` returns success with the plan
  summary.
- If the hook **throws (rejects)**, nothing is committed. The tool
  returns `{ error, planError: true }` so the caller can retry. No
  rollback is needed because no concurrent turn ever saw the plan.
- During the hook's await window, concurrent model calls inject the
  *last committed* plan, not the pending one. Capability descriptions
  also reflect committed state only.

#### Session teardown

`onSessionEnd` drains the per-session commit chain before deleting
session state, so an in-flight `onPlanUpdate` always completes (or
fails) before teardown releases the session entry.

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

- `plan` must be an array with at most **100 items** (`MAX_PLAN_ITEMS`)
- Each item must be an object with `content` (non-empty string, max
  **2000 characters**, `MAX_CONTENT_LENGTH`) and `status` (one of
  `pending`, `in_progress`, `completed`)

The rendered plan is replayed into every subsequent model request, so
these caps protect the session from permanent prompt inflation caused
by a single oversized write.

Invalid input returns `{ error: "…" }` with `metadata.planError: true` so
observer middleware can distinguish bad-input errors from genuine tool failures.

## Session isolation

Each session has its own plan. Writes in session A have no effect on
session B's plan.

## Turn concurrency

The once-per-response quota is keyed by `TurnId`, not session — so
overlapping turns on the same session each get their own counter and
cannot reset each other's budget. Plan commits use `turnIndex`
monotonicity: if a write from an older turn arrives after a newer turn
has already committed a plan, the older write is rejected as stale.

Each session also maintains a single-slot promise chain that
serializes the commit-plus-`onPlanUpdate` critical section. Overlapping
writes from the same session run in arrival order, so:

- **Persistence order matches arrival order**: a durable store using
  `onPlanUpdate` cannot end on an older plan than what's in memory,
  even when earlier calls take longer than later ones.
- **Rollback is safe**: when an earlier write's hook rejects, its
  rollback restores the prior-to-us snapshot captured inside the
  critical section. It cannot clobber a newer turn's successfully
  committed plan because that newer turn runs after this one finishes.

## Prompt-injection containment

Plan item `content` is authored by the model (and therefore ultimately
influenced by whatever user/tool output the model has read). To prevent
escalation into the system-role trust channel:

- The middleware's own instruction message is sent at `senderId:
  "system:plan"` — this is trusted prompt authored in-package.
- The **replayed plan state** (which contains model-authored content)
  is sent at `senderId: "user:plan-state"` so adapters that map
  `system:*` to the system role cannot promote it.
- Plan content is wrapped in a fenced block and has fence markers and
  line breaks neutralized so a single item cannot escape the fence or
  create sub-structure in the rendered list.

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
