# @koi/middleware-goal — Goal-Directed Middleware Trio

Three complementary middlewares for keeping autonomous agents focused on their objectives, merged into a single L2 package. Replaces the former `@koi/middleware-goal-anchor`, `@koi/middleware-goal-reminder`, and `@koi/middleware-planning`.

---

## What This Feature Enables

Long-running agent sessions suffer from **goal drift** — as the context window fills with tool results and intermediate outputs, the model's attention to the original objectives decays. This package solves that with three complementary strategies:

1. **Constant reinforcement** (goal-anchor) — injects a live todo list on every model call, keeping objectives at position 0 in the context window where attention weight is highest
2. **Adaptive periodic refresh** (goal-reminder) — injects context reminders on an adaptive schedule that tightens when drift is detected and relaxes when on-track, saving 80%+ tokens vs. constant injection
3. **Structured planning** (planning) — gives the model a `write_plan` tool to decompose complex tasks into tracked steps with status transitions

Used together (via `@koi/goal-stack` L3 bundle), they form a complete goal management system:

```
Injection frequency:

goal-reminder: ▓ · · · ▓ · · · · · · · · · ▓   (adaptive — few injections)
goal-anchor:   ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓   (every call — constant)
planning:      writes structured plan when model decides to

▓ = inject    · = passthrough
```

Without this package, agents wander off-task in long sessions, forget constraints, and lack structured task decomposition.

---

## Architecture

### Layer position

```
L0  @koi/core           ─ KoiMiddleware, TurnContext, SessionContext, etc. (types only)
L0u @koi/errors          ─ KoiRuntimeError
L0u @koi/resolve         ─ BrickDescriptor
L2  @koi/middleware-goal ─ this package (no L1 dependency)
```

Imports only from L0 and L0u. Never touches `@koi/engine` (L1), making it fully swappable and independently testable.

### Internal module map

```
src/
├── index.ts              ← unified public re-exports
│
├── anchor/               ← Priority 340 — every-call todo injection
│   ├── types.ts          ← TodoItemStatus, TodoItem, TodoState
│   ├── config.ts         ← GoalAnchorConfig + validateGoalAnchorConfig()
│   ├── todo.ts           ← pure: createTodoState, renderTodoBlock, detectCompletions
│   └── goal-anchor.ts    ← createGoalAnchorMiddleware() factory
│
├── reminder/             ← Priority 330 — adaptive periodic injection
│   ├── types.ts          ← ReminderSource (discriminated union), ReminderSessionState
│   ├── config.ts         ← GoalReminderConfig + validateGoalReminderConfig()
│   ├── interval.ts       ← computeNextInterval (pure), defaultIsDrifting (pure)
│   ├── sources.ts        ← resolveAllSources (async, parallel, fail-safe)
│   ├── goal-extractor.ts ← createGoalExtractorSource (LLM-based goal extraction with caching)
│   └── goal-reminder.ts  ← createGoalReminderMiddleware() factory
│
└── planning/             ← Priority 450 — write_plan tool
    ├── types.ts          ← PlanStatus, PlanItem, PlanConfig
    ├── config.ts         ← validatePlanConfig()
    ├── plan-tool.ts      ← WRITE_PLAN_DESCRIPTOR, PLAN_SYSTEM_PROMPT
    ├── descriptor.ts     ← BrickDescriptor for manifest auto-resolution
    └── plan-middleware.ts ← createPlanMiddleware() factory
```

### Dependencies

```
┌──────────────────────────────────────────────────────────┐
│  @koi/middleware-goal  (L2)                              │
│                                                          │
│  anchor/   — goal-anchor middleware (todo injection)     │
│  reminder/ — goal-reminder middleware (adaptive periodic)│
│  planning/ — planning middleware (write_plan tool)       │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  Dependencies                                            │
│                                                          │
│  @koi/core    (L0)   KoiMiddleware, ModelRequest/Response│
│                       TurnContext, SessionContext, etc.   │
│  @koi/errors  (L0u)  KoiRuntimeError                    │
│  @koi/resolve (L0u)  BrickDescriptor                    │
└──────────────────────────────────────────────────────────┘
```

---

## The Three Middlewares

### 1. Goal Anchor (priority 340)

**Problem:** In long context windows, original objectives scroll past the attention midpoint and the model forgets them.

**Solution:** Prepend a `system:goal-anchor` message with a live todo checklist to every model call.

**Hooks:**

| Hook | What runs |
|---|---|
| `onSessionStart` | Initialize `TodoState` with all objectives as `"pending"` |
| `wrapModelCall` | Prepend todo block → call model → detect completions |
| `wrapModelStream` | Same but buffers streamed text for completion detection |
| `onSessionEnd` | Cleanup session state |

**Completion detection:** After each response, scans for patterns (`completed`, `done`, `finished`, `✅`, `[x]`) near objective keywords (words > 3 chars). Matched objectives flip to `[x]`.

```typescript
import { createGoalAnchorMiddleware } from "@koi/middleware-goal";

const anchor = createGoalAnchorMiddleware({
  objectives: ["Search for TypeScript best practices", "Write a summary report"],
  header: "## Current Objectives",
  onComplete: (item) => console.log(`Completed: ${item.text}`),
});
```

### 2. Goal Reminder (priority 330)

**Problem:** Constant injection wastes tokens. A 30-turn session with 500-token reminders costs 15,000 extra tokens when most injections are unnecessary.

**Solution:** Adaptive interval that doubles when on-track and resets to base when drift is detected.

**Adaptive interval logic:**

```
Turn 5:  trigger → inject, on-track → interval doubles to 10
Turn 15: trigger → inject, on-track → interval doubles to 20
Turn 17: trigger → inject, DRIFTING → interval resets to 5
```

**Four source kinds** (resolved in parallel, fail-safe):

| Kind | Content | XML tag |
|---|---|---|
| `manifest` | Objective strings from agent manifest | `<goals>` |
| `static` | Fixed text (constraints, style guidelines) | `<context>` |
| `dynamic` | Lazily-fetched text (LLM summarization, config store) | `<context>` |
| `tasks` | Active task list from a todo tracker | `<tasks>` |

```typescript
import { createGoalReminderMiddleware } from "@koi/middleware-goal";

const reminder = createGoalReminderMiddleware({
  sources: [
    { kind: "manifest", objectives: ["Build the feature", "Write tests"] },
    { kind: "static", text: "Follow TypeScript strict mode" },
  ],
  baseInterval: 5,
  maxInterval: 20,
  isDrifting: (ctx) => customDriftCheck(ctx),
});
```

### 3. Planning (priority 450)

**Problem:** Complex tasks need structured decomposition, but the model has no tool for it.

**Solution:** Inject a `write_plan` tool that the model can call to create/update a structured plan with status tracking.

**Hooks:**

| Hook | What runs |
|---|---|
| `onBeforeTurn` | Reset per-turn `write_plan` call counter |
| `wrapModelCall` | Prepend `system:plan` message + inject `write_plan` tool descriptor |
| `wrapModelStream` | Same tool injection for streaming |
| `wrapToolCall` | Intercept `write_plan` calls: validate, enforce at-most-once per turn, update plan state |

**Constraints:** `write_plan` can only be called once per response (prevents parallel plan mutations). Plan is atomically replaced on each call.

```typescript
import { createPlanMiddleware } from "@koi/middleware-goal";

const planning = createPlanMiddleware({
  onPlanUpdate: (plan) => {
    for (const item of plan) {
      console.log(`[${item.status}] ${item.content}`);
    }
  },
  priority: 450,
});
```

---

## Middleware Properties

| Property | goal-anchor | goal-reminder | planning |
|---|---|---|---|
| `name` | `"goal-anchor"` | `"goal-reminder"` | `"plan"` |
| `priority` | 340 | 330 | 450 |
| Injection frequency | Every model call | Adaptive (every N turns) | Every model call |
| `senderId` | `system:goal-anchor` | `system:goal-reminder` | `system:plan` |
| State scope | Per-session `Map` | Per-session `Map` | Singleton closure |

**Priority ordering context:**

```
330  goal-reminder    ← periodic context injection
340  goal-anchor      ← constant todo injection (after reminder)
350  agent-monitor    ← goal drift detection (observer, separate package)
450  planning         ← write_plan tool (after tool-selector at 420)
500  soul             ← personality injection
```

---

## Combined Usage via @koi/goal-stack

The `@koi/goal-stack` L3 meta-package provides preset-driven composition:

```typescript
import { createGoalStack } from "@koi/goal-stack";

const { middlewares } = createGoalStack({
  preset: "standard",           // anchor + reminder + planning
  objectives: ["Build auth flow", "Write unit tests"],
});

// Pass to createKoi({ middleware: middlewares })
```

Presets: `"minimal"` (anchor only), `"standard"` (all three), `"autonomous"` (all three with tighter intervals).

---

## Manifest-Driven Setup

The planning middleware registers a `BrickDescriptor` for auto-resolution:

```yaml
# koi.yaml
middleware:
  - name: "@koi/middleware-goal"
    aliases: ["planning"]
```

---

## Safety Properties

- **Fail-safe sources:** Dynamic `fetch()` and tasks `provider()` that throw return placeholders instead of crashing the agent turn
- **Fail-safe drift detection:** If `isDrifting` throws, treated as drifting (fail-closed = inject more, not less)
- **Session isolation:** All state is keyed by `sessionId` — concurrent sessions never interfere
- **Immutable state:** All state updates return new objects — no mutation of shared state
- **At-most-once planning:** `write_plan` enforced to one call per response to prevent race conditions

---

## Testing

```bash
bun test packages/middleware/middleware-goal/
```

| Test file | Coverage |
|---|---|
| `anchor/todo.test.ts` | `createTodoState`, `renderTodoBlock`, `detectCompletions` |
| `anchor/goal-anchor.test.ts` | Lifecycle, injection, completion detection, streaming |
| `anchor/__tests__/integration.test.ts` | Cross-middleware with `@koi/agent-monitor` |
| `reminder/config.test.ts` | Exhaustive validation (all source kinds, numerics) |
| `reminder/interval.test.ts` | Table-driven: 8 interval cases + 7 drift cases |
| `reminder/sources.test.ts` | Per-variant resolution, fail-safe, ordering |
| `reminder/goal-extractor.test.ts` | Caching, re-extraction, session isolation |
| `reminder/goal-reminder.test.ts` | Lifecycle, adaptive intervals, concurrent sessions |
| `reminder/__tests__/e2e.test.ts` | 11 full-runtime tests (gated on `ANTHROPIC_API_KEY`) |
| `planning/plan-tool.test.ts` | Tool descriptor, system prompt |
| `planning/plan-middleware.test.ts` | Factory, injection, interception, at-most-once |

148 unit/integration tests, 11 E2E tests. 98%+ line coverage.

---

## Layer Compliance

- [x] Imports only from `@koi/core` (L0), `@koi/errors` (L0u), `@koi/resolve` (L0u)
- [x] No imports from `@koi/engine` (L1) or any peer L2 package
- [x] All interface properties are `readonly`
- [x] No vendor types (LangGraph, OpenAI, etc.)
- [x] `bun run check:layers` passes

---

## Migration from Individual Packages

If you previously imported from the three separate packages:

```typescript
// Before
import { createGoalAnchorMiddleware } from "@koi/middleware-goal-anchor";
import { createGoalReminderMiddleware } from "@koi/middleware-goal-reminder";
import { createPlanMiddleware } from "@koi/middleware-planning";

// After — same exports, single package
import {
  createGoalAnchorMiddleware,
  createGoalReminderMiddleware,
  createPlanMiddleware,
} from "@koi/middleware-goal";
```

All public API exports are preserved. No breaking changes to types or function signatures.
