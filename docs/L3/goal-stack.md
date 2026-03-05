# @koi/goal-stack — Goal Management Bundle

Convenience package that composes `@koi/middleware-planning` + `@koi/middleware-goal-anchor` + `@koi/middleware-goal-reminder` into a single `createGoalStack()` call with preset-driven composition.

---

## Why It Exists

Koi's goal management is spread across three independent L2 middleware, each handling a different aspect:

| Package | Priority | Role |
|---------|----------|------|
| `middleware-goal-reminder` | 330 | Adaptive periodic reminders with drift detection |
| `middleware-goal-anchor` | 340 | Constant todo checklist on every model call |
| `middleware-planning` | 450 | `write_plan` tool for structured task tracking |

Without this package:

- **No unified composition point** — `goal-anchor` lived in `@koi/starter`, `planning` in `@koi/cli`, and `goal-reminder` in no L3 bundle at all
- **Manual wiring** — users must import three packages, configure each independently, and manually pass all middleware to `createKoi`
- **No coordination** — no presets to express "I want light planning" vs "I want full goal tracking"

This L3 bundle provides:

- **One-call setup** — `createGoalStack()` creates and connects all middleware
- **Preset-driven composition** — `"light"` / `"standard"` / `"full"` selects which middleware are enabled
- **Auto-enable on config** — providing a middleware's config enables it regardless of preset
- **Correct priority ordering** — middleware are always created with their canonical priorities (330, 340, 450)

---

## What This Enables

```
BEFORE: Manual wiring (3 packages, separate configs)
═════════════════════════════════════════════════════

import { createGoalReminderMiddleware } from "@koi/middleware-goal-reminder";
import { createGoalAnchorMiddleware } from "@koi/middleware-goal-anchor";
import { createPlanMiddleware } from "@koi/middleware-planning";

const reminder = createGoalReminderMiddleware({
  sources: [{ kind: "manifest", objectives: ["Build feature X"] }],
  baseInterval: 5,
  maxInterval: 20,
});

const anchor = createGoalAnchorMiddleware({
  objectives: ["Build feature X", "Write tests"],
  onComplete: (item) => console.log("Done:", item.text),
});

const plan = createPlanMiddleware({
  onPlanUpdate: (items) => dashboard.update(items),
});

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: [reminder, anchor, plan, ...otherMiddleware],
});


AFTER: Goal stack (1 import, 1 function call)
═════════════════════════════════════════════

import { createGoalStack } from "@koi/goal-stack";

const { middlewares } = createGoalStack({
  preset: "full",
  anchor: {
    objectives: ["Build feature X", "Write tests"],
    onComplete: (item) => console.log("Done:", item.text),
  },
  reminder: {
    sources: [{ kind: "manifest", objectives: ["Build feature X"] }],
    baseInterval: 5,
    maxInterval: 20,
  },
  planning: {
    onPlanUpdate: (items) => dashboard.update(items),
  },
});

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: [...middlewares, ...otherMiddleware],
});
```

**Use cases by preset:**

| Preset | Middleware | Best for |
|--------|-----------|----------|
| `light` | planning only | Simple agents that need task tracking |
| `standard` | planning + anchor | Agents with declared objectives that need constant visibility |
| `full` | planning + anchor + reminder | Long-running agents where drift detection is critical |

---

## Architecture

`@koi/goal-stack` is an **L3 meta-package** — it composes L2 packages with zero new logic.

```
┌──────────────────────────────────────────────────────┐
│  @koi/goal-stack  (L3)                               │
│                                                      │
│  types.ts              ← config, bundle, preset types│
│  presets.ts            ← GOAL_STACK_PRESET_FLAGS      │
│  config-resolution.ts  ← resolveGoalStackConfig()    │
│  goal-stack.ts         ← createGoalStack() factory   │
│  index.ts              ← public API surface          │
│                                                      │
├──────────────────────────────────────────────────────┤
│  Dependencies                                        │
│                                                      │
│  @koi/middleware-goal-reminder (L2)  drift detection  │
│  @koi/middleware-goal-anchor   (L2)  todo checklist   │
│  @koi/middleware-planning      (L2)  write_plan tool  │
│  @koi/core                     (L0)  KoiMiddleware    │
└──────────────────────────────────────────────────────┘
```

---

## Quick Start

```typescript
import { createGoalStack } from "@koi/goal-stack";

// Minimal — light preset, planning middleware only
const { middlewares } = createGoalStack();

// Standard — planning + todo checklist anchored to every model call
const standard = createGoalStack({
  preset: "standard",
  anchor: { objectives: ["Implement auth", "Write tests", "Update docs"] },
});

// Full — all three middleware with drift detection
const full = createGoalStack({
  preset: "full",
  anchor: {
    objectives: ["Implement auth", "Write tests"],
    onComplete: (item) => console.log("Completed:", item.text),
  },
  reminder: {
    sources: [{ kind: "manifest", objectives: ["Implement auth"] }],
    baseInterval: 5,
    maxInterval: 20,
  },
  planning: {
    onPlanUpdate: (plan) => dashboard.refresh(plan),
  },
});
```

---

## Presets

Presets control which middleware are enabled by default. They do **not** supply domain-specific config values (unlike governance presets which provide permission rules, PII strategies, etc.).

```
light:    planning ✓  anchor ✗  reminder ✗
standard: planning ✓  anchor ✓  reminder ✗
full:     planning ✓  anchor ✓  reminder ✓
```

**Override rule:** Providing a middleware's config always enables it, regardless of preset. For example, passing `anchor` config with `preset: "light"` still enables the anchor middleware.

**Validation rule:** If a preset enables a middleware but no config is provided, `createGoalStack` throws with an actionable error message. Planning is exempt since its config is fully optional.

---

## Key Types

| Type | Purpose |
|------|---------|
| `GoalStackConfig` | Top-level config: preset + per-middleware config |
| `GoalStackBundle` | Return type — `middlewares` array + `config` metadata |
| `GoalStackPreset` | `"light" \| "standard" \| "full"` |
| `GoalStackPresetFlags` | Per-preset boolean flags for each middleware |
| `ResolvedGoalStackMeta` | Inspection metadata: preset, counts, enabled flags |
| `ResolvedGoalStackConfig` | Resolved config returned by `resolveGoalStackConfig()` |

---

## How the Three Middleware Work Together

Each middleware addresses a different time horizon of goal management:

1. **Planning (priority 450)** — Provides a `write_plan` tool that lets the agent create and maintain a structured task list. The plan persists across turns and is injected into every model call as context. Think of it as the agent's task board.

2. **Goal Anchor (priority 340)** — Injects the declared objectives as a live todo checklist on every model call. Heuristically detects when objectives are completed based on model responses. Think of it as a constant "north star" reminder.

3. **Goal Reminder (priority 330)** — Periodically injects goal reminders with an adaptive interval. Doubles the interval when the agent stays on-task; resets to base interval when drift is detected. Think of it as a guardrail against topic drift in long conversations.

```
Turn 1  [reminder] ← first reminder injected
        [anchor]   ← todo checklist: ☐ Build feature ☐ Write tests
        [plan]     ← agent creates plan via write_plan tool

Turn 2  [anchor]   ← todo checklist (always present)
        [plan]     ← plan context injected

...

Turn 5  [reminder] ← periodic reminder fires (baseInterval=5)
        [anchor]   ← todo checklist: ☑ Build feature ☐ Write tests
        [plan]     ← updated plan

Turn 10 [reminder] ← interval doubled to 10 (no drift detected)
        [anchor]   ← todo checklist
        [plan]     ← plan context
```

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Presets control flags only, not config values | Unlike governance, these middleware require domain-specific data (objectives, sources) that can't be meaningfully defaulted by a preset |
| Priority is blocked on planning config | Stack ordering (330, 340, 450) is intentional — allowing users to override planning priority could break the composition |
| No ComponentProviders returned | None of the three middleware produce providers, unlike governance which wires scope providers |
| Sync factory (not async) | All three L2 factories are synchronous — no I/O at construction time |
| Validation collects all errors | When multiple configs are missing, all errors are reported in a single throw rather than failing one at a time |

---

## Layer Compliance

- [x] `@koi/goal-stack` only imports from L0 (`@koi/core`) and L2 middleware packages
- [x] `@koi/engine` is devDependency only (used in integration tests)
- [x] No new logic beyond composition — types, presets, config resolution, and factory
- [x] All interface properties are `readonly`
- [x] Listed in `L3_PACKAGES` in `scripts/layers.ts`
