# @koi/goal-stack — Goal-Directed Middleware Bundle

Layer 3 meta-package that composes up to 3 goal-tracking middleware into a
single `createGoalStack()` call with preset-driven defaults.

## What This Enables

**Intra-session goal persistence for AI agents.** Without goal-stack, agents
lose track of their objectives as conversations grow — the model's attention
drifts from the original task, especially in long autonomous runs. Goal-stack
solves this with three complementary strategies:

- **Goal Anchor** (priority 340) — injects a live todo list on _every_ model
  call, keeping objectives in the model's most recent attention span
  (Manus-style attention management)
- **Goal Reminder** (priority 330) — injects periodic reminders with _adaptive
  intervals_: doubles the gap when the agent is on-track, resets to base on
  drift detection
- **Planning** (priority 450) — provides a `write_plan` tool so agents can
  create and maintain structured multi-step plans across turns

Together they prevent goal drift, improve task completion rates, and give
observability into what the agent thinks it's doing.

### Key use cases

| Scenario | Preset | Why |
|----------|--------|-----|
| Interactive chat with structured planning | `minimal` | Planning tool only — no injection overhead |
| Multi-step task execution | `standard` | All three middleware, moderate reminder frequency |
| Autonomous long-running agents | `autonomous` | All three middleware, aggressive reminder intervals |

### Autonomous agent integration

`@koi/autonomous` accepts an optional `goalStackMiddleware` field, letting
autonomous agents opt into goal tracking without any L3-to-L3 import:

```typescript
import { createGoalStack } from "@koi/goal-stack";
import { createAutonomousAgent } from "@koi/autonomous";

const goals = createGoalStack({
  preset: "autonomous",
  objectives: ["Implement auth flow", "Write tests", "Deploy to staging"],
});

const agent = createAutonomousAgent({
  harness,
  scheduler,
  goalStackMiddleware: goals.middlewares, // readonly KoiMiddleware[]
});
```

## Quick Start

```typescript
import { createGoalStack } from "@koi/goal-stack";
import { createKoi } from "@koi/engine";

// Minimal — planning tool only, no objectives needed
const { middlewares } = createGoalStack({ preset: "minimal" });

// Standard — all three middleware, moderate intervals
const stack = createGoalStack({
  objectives: ["Build the auth module", "Add unit tests"],
});

// Autonomous — tighter intervals for long-running agents
const autonomous = createGoalStack({
  preset: "autonomous",
  objectives: ["Implement feature X", "Write integration tests"],
  anchor: { onComplete: (item) => console.log(`Done: ${item.text}`) },
  planning: { onPlanUpdate: (plan) => console.log("Plan updated:", plan) },
});

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: stack.middlewares,
  providers: stack.providers,
});
```

## Middleware Priority Order

| Priority | Middleware | Description |
|----------|-----------|-------------|
| 330 | goal-reminder | Adaptive periodic goal injection with drift detection |
| 340 | goal-anchor | Live todo list injected on every model call |
| 450 | plan | `write_plan` tool for structured task tracking |

## Presets

### `minimal`

- Planning tool only
- No anchor or reminder injection
- No objectives required
- Zero runtime overhead on model calls

### `standard` (default)

- All three middleware active
- Reminder: base interval 5 turns, max 20 turns
- Objectives required (throws if missing)
- Default anchor header: `## Current Objectives`

### `autonomous`

- All three middleware active
- Reminder: base interval 3 turns, max 10 turns (tighter than standard)
- Objectives required (throws if missing)
- Designed for long-running agents where drift risk is highest

## Config Resolution

1. **Preset selection**: defaults to `"standard"` if unspecified
2. **Objectives validation**: anchor/reminder presets require non-empty
   `objectives` array (error message suggests `"minimal"` preset)
3. **User overrides**: anchor, reminder, and planning sub-configs override
   preset defaults

### Override Examples

```typescript
// Custom reminder sources (replace default manifest source)
createGoalStack({
  objectives: ["Task A"],
  reminder: {
    sources: [{ kind: "static", text: "Stay focused on the auth module" }],
    baseInterval: 10,
    maxInterval: 30,
  },
});

// Custom anchor header
createGoalStack({
  objectives: ["Task A"],
  anchor: { header: "## Active Goals" },
});

// Custom planning priority
createGoalStack({
  preset: "minimal",
  planning: { priority: 500 },
});
```

## Return Shape

```typescript
interface GoalStackBundle {
  readonly middlewares: readonly KoiMiddleware[];
  readonly providers: readonly ComponentProvider[];  // always [] — future-proof
  readonly config: ResolvedGoalStackMeta;
}

interface ResolvedGoalStackMeta {
  readonly preset: GoalStackPreset;
  readonly middlewareCount: number;
  readonly includesAnchor: boolean;
  readonly includesReminder: boolean;
  readonly includesPlanning: boolean;
}
```

## Architecture

```
@koi/goal-stack (L3)
  ├── types.ts              — GoalStackConfig, presets, bundle types
  ├── presets.ts             — GOAL_STACK_PRESET_SPECS (frozen)
  ├── config-resolution.ts   — preset defaults + objectives validation
  ├── goal-stack.ts           — createGoalStack() factory
  └── index.ts               — public API surface + sub-package re-exports
```

Dependencies:
- L0: `@koi/core` (types)
- L0u: `@koi/errors`, `@koi/resolve`
- L2: `@koi/middleware-goal-anchor`, `@koi/middleware-goal-reminder`, `@koi/middleware-planning`

## Re-exported Types

For convenience, `@koi/goal-stack` re-exports key types from its constituent
packages so consumers don't need direct dependencies:

- `TodoItem`, `TodoItemStatus`, `TodoState` — from `@koi/middleware-goal-anchor`
- `ReminderSource`, `ReminderSessionState` — from `@koi/middleware-goal-reminder`
- `PlanItem`, `PlanStatus` — from `@koi/middleware-planning`
- `planningDescriptor` — brick descriptor for registry consumers
