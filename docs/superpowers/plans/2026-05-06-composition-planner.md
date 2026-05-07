# Composition Planner Implementation Plan

> **STATUS: HISTORICAL / OBSOLETE.** This plan was the pre-implementation design for issue #1299. The shipped implementation diverges from this document in several ways — most notably the public contract in `packages/kernel/core/src/composition-planner.ts` (`AgentDefinition[]` not `RegistryEntry[]`; `mode`/`taskOptions` on `submit_task`/`create_schedule`), capability gating on `spawn_agent` steps, `cancelled`-as-no-op semantics in the rule planner, and full step-kind validation (`tool_call`, `spawn_agent`, `submit_task`, `create_schedule`, `forge_skill`, `notify_user`) in the LLM planner. **Do not use this file as an implementation source of truth.** Read the code in `@koi/core` and `@koi/proactive`, and the spec at `docs/superpowers/specs/2026-05-06-composition-planner-design.md`, instead.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the L0 composition-planning contracts plus proactive signal normalization, deterministic planning, and optional LLM-backed planning for issue `#1299`.

**Architecture:** Define the shared planning vocabulary in `@koi/core`, then implement a thin `@koi/proactive` layer that maps `SystemSignal` into `CompositionTrigger` and produces `CompositionPlan` values using either deterministic rules or a validated LLM adapter. Execution stays out of scope; this work stops at plan generation and approval classification.

**Tech Stack:** TypeScript 6, Bun test runner, tsup type exports, `@koi/core`, `@koi/proactive`

---

## File Structure

### `@koi/core`

- Create: `packages/kernel/core/src/composition-planner.ts`
- Modify: `packages/kernel/core/src/index.ts`
- Modify: `packages/kernel/core/src/system-signal.test.ts`
- Verify: `packages/kernel/core/src/__tests__/api-surface.test.ts`

### `@koi/proactive`

- Create: `packages/lib/proactive/src/composition-trigger.ts`
- Create: `packages/lib/proactive/src/composition-trigger.test.ts`
- Create: `packages/lib/proactive/src/composition-approval.ts`
- Create: `packages/lib/proactive/src/composition-approval.test.ts`
- Create: `packages/lib/proactive/src/rule-based-composition-planner.ts`
- Create: `packages/lib/proactive/src/rule-based-composition-planner.test.ts`
- Create: `packages/lib/proactive/src/llm-composition-planner.ts`
- Create: `packages/lib/proactive/src/llm-composition-planner.test.ts`
- Modify: `packages/lib/proactive/src/index.ts`
- Optionally modify: `packages/lib/proactive/src/test-helpers.ts` if shared trigger/planner fixtures reduce duplication without bloating tests

### Docs

- Reference only: `docs/superpowers/specs/2026-05-06-composition-planner-design.md`

---

### Task 1: Add L0 Composition Planning Contracts

**Files:**
- Create: `packages/kernel/core/src/composition-planner.ts`
- Modify: `packages/kernel/core/src/index.ts`
- Modify: `packages/kernel/core/src/system-signal.test.ts`
- Test: `packages/kernel/core/src/system-signal.test.ts`
- Verify: `packages/kernel/core/src/__tests__/api-surface.test.ts`

- [ ] **Step 1: Write the failing type-level test coverage for the new contract**

Add assertions to `packages/kernel/core/src/system-signal.test.ts` that prove the new types are wired correctly before the file exists:

```ts
import type {
  CompositionCapabilities,
  CompositionMoment,
  CompositionPlan,
  CompositionPlanner,
  CompositionStep,
  CompositionTrigger,
} from "./composition-planner.js";

type _MomentKindCheck = CompositionMoment["kind"];
const _momentKindCheck: _MomentKindCheck = "capability_gap";
void _momentKindCheck;

const _triggerConformance: CompositionTrigger = {
  id: "trigger-1",
  source: "governance",
  confidence: 0.8,
  moment: { kind: "capability_gap", missing: "diagnostic-agent" },
  suggestedCapabilities: ["spawn_agent"],
  context: {},
  emittedAt: 1,
};
void _triggerConformance;

const _plannerConformance: CompositionPlanner = {
  async plan(
    trigger: CompositionTrigger,
    _capabilities: CompositionCapabilities,
  ): Promise<CompositionPlan> {
    const step: CompositionStep = {
      kind: "notify_user",
      channel: "inbox",
      message: trigger.id,
      priority: "normal",
    };
    return {
      triggerId: trigger.id,
      steps: [step],
      estimatedCost: 0,
      requiresApproval: false,
    };
  },
};
void _plannerConformance;
```

- [ ] **Step 2: Run the core contract test to verify it fails**

Run:

```bash
bun test packages/kernel/core/src/system-signal.test.ts
```

Expected: FAIL with a module resolution or missing export error for `./composition-planner.js`.

- [ ] **Step 3: Implement the L0 contract file**

Create `packages/kernel/core/src/composition-planner.ts` with the shared types only:

```ts
import type { DeliveryPolicy } from "./delivery.js";
import type { AgentId, ToolDescriptor } from "./ecs.js";
import type { EngineInput } from "./engine.js";
import type { ForgeStore } from "./brick-store.js";
import type { ForgeDemandSignal } from "./forge-demand.js";
import type { RegistryEntry } from "./lifecycle.js";
import type { CronSchedule, TaskId } from "./scheduler.js";

export interface CompositionTrigger {
  readonly id: string;
  readonly source: string;
  readonly confidence: number;
  readonly moment: CompositionMoment;
  readonly suggestedCapabilities: readonly string[];
  readonly context: Readonly<Record<string, unknown>>;
  readonly emittedAt: number;
}

export type CompositionMoment =
  | { readonly kind: "capability_gap"; readonly missing: string }
  | {
      readonly kind: "threshold_crossed";
      readonly sensor: string;
      readonly value: number;
      readonly limit: number;
      readonly direction: "above" | "below";
    }
  | { readonly kind: "pattern_matched"; readonly patternId: string; readonly description: string }
  | {
      readonly kind: "task_terminal";
      readonly taskId: TaskId;
      readonly outcome: "completed" | "failed" | "dead_letter" | "cancelled";
    }
  | { readonly kind: "external_event"; readonly source: string; readonly eventType: string }
  | { readonly kind: "frontier_changed"; readonly metric: string; readonly improvement: number };

export interface CompositionCapabilities {
  readonly tools: readonly ToolDescriptor[];
  readonly agents: readonly RegistryEntry[];
  readonly schedules: readonly CronSchedule[];
  readonly forgeStore?: ForgeStore | undefined;
}

export interface CompositionPlan {
  readonly triggerId: string;
  readonly steps: readonly CompositionStep[];
  readonly estimatedCost: number;
  readonly requiresApproval: boolean;
}

export type CompositionStep =
  | { readonly kind: "tool_call"; readonly toolName: string; readonly input: unknown }
  | {
      readonly kind: "spawn_agent";
      readonly agentType: string;
      readonly input: EngineInput;
      readonly delivery: DeliveryPolicy;
    }
  | {
      readonly kind: "submit_task";
      readonly agentId: AgentId;
      readonly input: EngineInput;
      readonly delayMs: number;
    }
  | {
      readonly kind: "create_schedule";
      readonly expression: string;
      readonly agentId: AgentId;
      readonly input: EngineInput;
      readonly timezone?: string | undefined;
    }
  | { readonly kind: "forge_skill"; readonly demand: ForgeDemandSignal }
  | {
      readonly kind: "notify_user";
      readonly channel: string;
      readonly message: string;
      readonly priority: "low" | "normal" | "high";
    };

export interface CompositionPlanner {
  readonly plan: (
    trigger: CompositionTrigger,
    capabilities: CompositionCapabilities,
  ) => Promise<CompositionPlan>;
}

export interface CompositionApprovalPolicy {
  readonly confidenceThreshold: number;
  readonly maxEstimatedCost: number;
  readonly requireApprovalOnNovelty: boolean;
}

export interface CompositionApprovalContext {
  readonly isNovel: boolean;
}
```

- [ ] **Step 4: Export the new core contract**

Update `packages/kernel/core/src/index.ts` near the forge/scheduler/system-signal exports:

```ts
// composition planner — trigger and planning contracts
export type {
  CompositionApprovalContext,
  CompositionApprovalPolicy,
  CompositionCapabilities,
  CompositionMoment,
  CompositionPlan,
  CompositionPlanner,
  CompositionStep,
  CompositionTrigger,
} from "./composition-planner.js";
```

- [ ] **Step 5: Run the focused core tests to verify they pass**

Run:

```bash
bun test packages/kernel/core/src/system-signal.test.ts
```

Expected: PASS

- [ ] **Step 6: Build `@koi/core` and run API-surface verification**

Run:

```bash
bun run --cwd packages/kernel/core build
bun test packages/kernel/core/src/__tests__/api-surface.test.ts
```

Expected: PASS with snapshot updates only if the new root export changes the generated `.d.ts`.

- [ ] **Step 7: Commit the L0 contract work**

```bash
git add packages/kernel/core/src/composition-planner.ts \
  packages/kernel/core/src/index.ts \
  packages/kernel/core/src/system-signal.test.ts
git commit -m "feat(core): add composition planning contracts"
```

---

### Task 2: Add SystemSignal to CompositionTrigger Mapping

**Files:**
- Create: `packages/lib/proactive/src/composition-trigger.ts`
- Create: `packages/lib/proactive/src/composition-trigger.test.ts`
- Modify: `packages/lib/proactive/src/index.ts`

- [ ] **Step 1: Write failing mapper tests**

Create `packages/lib/proactive/src/composition-trigger.test.ts` with focused normalization cases:

```ts
import { describe, expect, test } from "bun:test";
import { mapSystemSignalToCompositionTrigger } from "./composition-trigger.js";

describe("mapSystemSignalToCompositionTrigger", () => {
  test("maps governance threshold crossings", () => {
    const trigger = mapSystemSignalToCompositionTrigger({
      kind: "governance",
      sensor: "error_rate",
      value: 0.4,
      limit: 0.2,
      direction: "above",
      emittedAt: 123,
    });

    expect(trigger).toEqual({
      id: "governance:error_rate:123",
      source: "governance",
      confidence: 1,
      moment: {
        kind: "threshold_crossed",
        sensor: "error_rate",
        value: 0.4,
        limit: 0.2,
        direction: "above",
      },
      suggestedCapabilities: ["spawn_agent", "notify_user"],
      context: {},
      emittedAt: 123,
    });
  });

  test("maps forge demand to capability_gap", () => {
    const trigger = mapSystemSignalToCompositionTrigger({
      id: "fd-1",
      kind: "forge_demand",
      confidence: 0.7,
      suggestedBrickKind: "skill",
      trigger: { kind: "capability_gap", requiredCapability: "diagnostics" },
      context: { failureCount: 2, failedToolCalls: [] },
      emittedAt: 50,
    });

    expect(trigger?.moment).toEqual({ kind: "capability_gap", missing: "diagnostics" });
    expect(trigger?.context).toMatchObject({ forgeDemand: { id: "fd-1" } });
  });

  test("maps schedule terminal failure to task_terminal", () => {
    const trigger = mapSystemSignalToCompositionTrigger({
      kind: "schedule",
      event: { kind: "task:failed", taskId: "task-1" as never, error: { message: "boom" } as never },
      emittedAt: 77,
    });

    expect(trigger?.moment).toEqual({
      kind: "task_terminal",
      taskId: "task-1",
      outcome: "failed",
    });
  });

  test("ignores agent lifecycle in the first pass", () => {
    const trigger = mapSystemSignalToCompositionTrigger({
      kind: "agent_lifecycle",
      agentId: "a-1" as never,
      from: "created",
      to: "running",
      reason: "started" as never,
      generation: 1,
      emittedAt: 10,
    });

    expect(trigger).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the mapper test to verify it fails**

Run:

```bash
bun test packages/lib/proactive/src/composition-trigger.test.ts
```

Expected: FAIL with missing module/export errors for `./composition-trigger.js`.

- [ ] **Step 3: Implement the mapper**

Create `packages/lib/proactive/src/composition-trigger.ts`:

```ts
import type { CompositionTrigger, ForgeTrigger, SystemSignal } from "@koi/core";

function capabilityFromForgeTrigger(trigger: ForgeTrigger): string | undefined {
  switch (trigger.kind) {
    case "capability_gap":
    case "composition_gap":
      return trigger.requiredCapability;
    case "agent_capability_gap":
      return trigger.agentType;
    case "data_source_gap":
      return trigger.missingCapability;
    case "no_matching_tool":
      return trigger.query;
    default:
      return undefined;
  }
}

export function mapSystemSignalToCompositionTrigger(
  signal: SystemSignal,
): CompositionTrigger | undefined {
  switch (signal.kind) {
    case "governance":
      return {
        id: `governance:${signal.sensor}:${String(signal.emittedAt)}`,
        source: "governance",
        confidence: 1,
        moment: {
          kind: "threshold_crossed",
          sensor: signal.sensor,
          value: signal.value,
          limit: signal.limit,
          direction: signal.direction,
        },
        suggestedCapabilities:
          signal.sensor === "error_rate" ? ["spawn_agent", "notify_user"] : [],
        context: {},
        emittedAt: signal.emittedAt,
      };
    case "forge_demand": {
      const missing = capabilityFromForgeTrigger(signal.trigger) ?? "unknown-capability";
      return {
        id: signal.id,
        source: "forge_demand",
        confidence: signal.confidence,
        moment: { kind: "capability_gap", missing },
        suggestedCapabilities: ["forge_skill"],
        context: { forgeDemand: signal },
        emittedAt: signal.emittedAt,
      };
    }
    case "schedule":
      return {
        id: `schedule:${String(signal.event.taskId)}:${String(signal.emittedAt)}`,
        source: "schedule",
        confidence: 1,
        moment: {
          kind: "task_terminal",
          taskId: signal.event.taskId,
          outcome: signal.event.kind === "task:completed"
            ? "completed"
            : signal.event.kind === "task:failed"
              ? "failed"
              : signal.event.kind === "task:dead_letter"
                ? "dead_letter"
                : "cancelled",
        },
        suggestedCapabilities:
          signal.event.kind === "task:completed" ? [] : ["spawn_agent", "notify_user"],
        context: { schedulerEvent: signal.event },
        emittedAt: signal.emittedAt,
      };
    case "vfs":
    case "agent_lifecycle":
    case "compaction":
      return undefined;
    case "anomaly":
      return undefined;
  }
}
```

- [ ] **Step 4: Export the mapper from proactive**

Update `packages/lib/proactive/src/index.ts`:

```ts
export { mapSystemSignalToCompositionTrigger } from "./composition-trigger.js";
```

- [ ] **Step 5: Run the mapper test and package smoke tests**

Run:

```bash
bun test packages/lib/proactive/src/composition-trigger.test.ts \
  packages/lib/proactive/src/create-proactive-tools.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit the mapper work**

```bash
git add packages/lib/proactive/src/composition-trigger.ts \
  packages/lib/proactive/src/composition-trigger.test.ts \
  packages/lib/proactive/src/index.ts
git commit -m "feat(proactive): map system signals to composition triggers"
```

---

### Task 3: Add Approval Helper and Rule-Based Planner

**Files:**
- Create: `packages/lib/proactive/src/composition-approval.ts`
- Create: `packages/lib/proactive/src/composition-approval.test.ts`
- Create: `packages/lib/proactive/src/rule-based-composition-planner.ts`
- Create: `packages/lib/proactive/src/rule-based-composition-planner.test.ts`
- Modify: `packages/lib/proactive/src/index.ts`

- [ ] **Step 1: Write failing approval helper tests**

Create `packages/lib/proactive/src/composition-approval.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { computeCompositionApproval } from "./composition-approval.js";

const trigger = {
  id: "t-1",
  source: "governance",
  confidence: 0.9,
  moment: { kind: "capability_gap", missing: "diagnostics" },
  suggestedCapabilities: [],
  context: {},
  emittedAt: 1,
} as const;

describe("computeCompositionApproval", () => {
  test("requires approval below confidence threshold", () => {
    expect(
      computeCompositionApproval({ ...trigger, confidence: 0.2 }, 1, {
        confidenceThreshold: 0.5,
        maxEstimatedCost: 10,
        requireApprovalOnNovelty: false,
      }, { isNovel: false }),
    ).toBe(true);
  });

  test("requires approval above cost budget", () => {
    expect(
      computeCompositionApproval(trigger, 100, {
        confidenceThreshold: 0.5,
        maxEstimatedCost: 10,
        requireApprovalOnNovelty: false,
      }, { isNovel: false }),
    ).toBe(true);
  });

  test("requires approval on novelty when configured", () => {
    expect(
      computeCompositionApproval(trigger, 1, {
        confidenceThreshold: 0.5,
        maxEstimatedCost: 10,
        requireApprovalOnNovelty: true,
      }, { isNovel: true }),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Write failing rule-planner tests**

Create `packages/lib/proactive/src/rule-based-composition-planner.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_DELIVERY_POLICY } from "@koi/core";
import { createRuleBasedCompositionPlanner } from "./rule-based-composition-planner.js";

describe("createRuleBasedCompositionPlanner", () => {
  test("plans forge for capability gaps", async () => {
    const planner = createRuleBasedCompositionPlanner();
    const plan = await planner.plan(
      {
        id: "gap-1",
        source: "forge_demand",
        confidence: 0.9,
        moment: { kind: "capability_gap", missing: "diagnostics" },
        suggestedCapabilities: ["forge_skill"],
        context: {
          forgeDemand: {
            id: "fd-1",
            kind: "forge_demand",
            confidence: 0.9,
            suggestedBrickKind: "skill",
            trigger: { kind: "capability_gap", requiredCapability: "diagnostics" },
            context: { failureCount: 1, failedToolCalls: [] },
            emittedAt: 1,
          },
        },
        emittedAt: 1,
      },
      { tools: [], agents: [], schedules: [] },
    );

    expect(plan.steps[0]).toMatchObject({ kind: "forge_skill" });
    expect(plan.requiresApproval).toBe(false);
  });

  test("plans diagnostic spawn for error-rate thresholds", async () => {
    const planner = createRuleBasedCompositionPlanner();
    const plan = await planner.plan(
      {
        id: "gov-1",
        source: "governance",
        confidence: 1,
        moment: {
          kind: "threshold_crossed",
          sensor: "error_rate",
          value: 0.6,
          limit: 0.2,
          direction: "above",
        },
        suggestedCapabilities: ["spawn_agent", "notify_user"],
        context: {},
        emittedAt: 1,
      },
      { tools: [], agents: [], schedules: [] },
    );

    expect(plan.steps).toContainEqual({
      kind: "spawn_agent",
      agentType: "diagnostic",
      input: { kind: "text", text: "Investigate elevated error_rate and summarize root causes." },
      delivery: DEFAULT_DELIVERY_POLICY,
    });
  });
});
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run:

```bash
bun test packages/lib/proactive/src/composition-approval.test.ts \
  packages/lib/proactive/src/rule-based-composition-planner.test.ts
```

Expected: FAIL with missing module/export errors.

- [ ] **Step 4: Implement the shared approval helper**

Create `packages/lib/proactive/src/composition-approval.ts`:

```ts
import type {
  CompositionApprovalContext,
  CompositionApprovalPolicy,
  CompositionTrigger,
} from "@koi/core";

export const DEFAULT_COMPOSITION_APPROVAL_POLICY: CompositionApprovalPolicy = {
  confidenceThreshold: 0.5,
  maxEstimatedCost: 10,
  requireApprovalOnNovelty: true,
} as const;

export function computeCompositionApproval(
  trigger: CompositionTrigger,
  estimatedCost: number,
  policy: CompositionApprovalPolicy,
  context: CompositionApprovalContext,
): boolean {
  if (trigger.confidence < policy.confidenceThreshold) return true;
  if (estimatedCost > policy.maxEstimatedCost) return true;
  if (policy.requireApprovalOnNovelty && context.isNovel) return true;
  return false;
}
```

- [ ] **Step 5: Implement the rule-based planner**

Create `packages/lib/proactive/src/rule-based-composition-planner.ts`:

```ts
import type {
  CompositionApprovalPolicy,
  CompositionPlan,
  CompositionPlanner,
  CompositionStep,
  CompositionTrigger,
} from "@koi/core";
import { DEFAULT_DELIVERY_POLICY } from "@koi/core";
import {
  computeCompositionApproval,
  DEFAULT_COMPOSITION_APPROVAL_POLICY,
} from "./composition-approval.js";

export interface RuleBasedCompositionPlannerConfig {
  readonly approvalPolicy?: CompositionApprovalPolicy | undefined;
  readonly classifyNovelty?: ((trigger: CompositionTrigger) => boolean) | undefined;
}

function estimateCost(steps: readonly CompositionStep[]): number {
  return steps.reduce((total, step) => {
    switch (step.kind) {
      case "notify_user":
        return total + 1;
      case "tool_call":
        return total + 2;
      case "forge_skill":
        return total + 4;
      case "submit_task":
      case "create_schedule":
        return total + 3;
      case "spawn_agent":
        return total + 5;
    }
  }, 0);
}

export function createRuleBasedCompositionPlanner(
  config: RuleBasedCompositionPlannerConfig = {},
): CompositionPlanner {
  const approvalPolicy = config.approvalPolicy ?? DEFAULT_COMPOSITION_APPROVAL_POLICY;
  const classifyNovelty = config.classifyNovelty ?? (() => false);

  return {
    async plan(trigger, _capabilities): Promise<CompositionPlan> {
      const steps: CompositionStep[] = [];

      switch (trigger.moment.kind) {
        case "capability_gap":
          if ("forgeDemand" in trigger.context) {
            steps.push({ kind: "forge_skill", demand: trigger.context.forgeDemand as never });
          }
          break;
        case "threshold_crossed":
          if (trigger.moment.sensor === "error_rate" && trigger.moment.direction === "above") {
            steps.push({
              kind: "spawn_agent",
              agentType: "diagnostic",
              input: {
                kind: "text",
                text: "Investigate elevated error_rate and summarize root causes.",
              },
              delivery: DEFAULT_DELIVERY_POLICY,
            });
            steps.push({
              kind: "notify_user",
              channel: "inbox",
              message: "Error rate crossed its configured threshold.",
              priority: "high",
            });
          }
          break;
        case "task_terminal":
          if (trigger.moment.outcome !== "completed") {
            steps.push({
              kind: "spawn_agent",
              agentType: "recovery",
              input: {
                kind: "text",
                text: `Analyze failed scheduled task ${String(trigger.moment.taskId)} and propose recovery.`,
              },
              delivery: DEFAULT_DELIVERY_POLICY,
            });
          }
          break;
        case "frontier_changed":
          steps.push({
            kind: "spawn_agent",
            agentType: "researcher",
            input: {
              kind: "text",
              text: `Investigate frontier change in ${trigger.moment.metric}.`,
            },
            delivery: { kind: "deferred" },
          });
          break;
        case "pattern_matched":
        case "external_event":
          break;
      }

      const estimatedCost = estimateCost(steps);
      return {
        triggerId: trigger.id,
        steps,
        estimatedCost,
        requiresApproval:
          steps.length === 0 ||
          computeCompositionApproval(trigger, estimatedCost, approvalPolicy, {
            isNovel: classifyNovelty(trigger),
          }),
      };
    },
  };
}
```

- [ ] **Step 6: Export the helper and planner**

Update `packages/lib/proactive/src/index.ts`:

```ts
export {
  computeCompositionApproval,
  DEFAULT_COMPOSITION_APPROVAL_POLICY,
} from "./composition-approval.js";
export {
  createRuleBasedCompositionPlanner,
  type RuleBasedCompositionPlannerConfig,
} from "./rule-based-composition-planner.js";
```

- [ ] **Step 7: Run the focused proactive tests**

Run:

```bash
bun test packages/lib/proactive/src/composition-approval.test.ts \
  packages/lib/proactive/src/rule-based-composition-planner.test.ts
```

Expected: PASS

- [ ] **Step 8: Commit the deterministic planning work**

```bash
git add packages/lib/proactive/src/composition-approval.ts \
  packages/lib/proactive/src/composition-approval.test.ts \
  packages/lib/proactive/src/rule-based-composition-planner.ts \
  packages/lib/proactive/src/rule-based-composition-planner.test.ts \
  packages/lib/proactive/src/index.ts
git commit -m "feat(proactive): add rule-based composition planner"
```

---

### Task 4: Add the LLM-Backed Planner With Validation and Fallback

**Files:**
- Create: `packages/lib/proactive/src/llm-composition-planner.ts`
- Create: `packages/lib/proactive/src/llm-composition-planner.test.ts`
- Modify: `packages/lib/proactive/src/index.ts`

- [ ] **Step 1: Write failing LLM planner tests**

Create `packages/lib/proactive/src/llm-composition-planner.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createLlmCompositionPlanner } from "./llm-composition-planner.js";
import { createRuleBasedCompositionPlanner } from "./rule-based-composition-planner.js";

describe("createLlmCompositionPlanner", () => {
  test("returns a validated plan from adapter JSON", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "gov-1",
            steps: [
              {
                kind: "notify_user",
                channel: "inbox",
                message: "Threshold crossed",
                priority: "high",
              },
            ],
            estimatedCost: 2,
            requiresApproval: false,
          });
        },
      },
    });

    const plan = await planner.plan(
      {
        id: "gov-1",
        source: "governance",
        confidence: 1,
        moment: {
          kind: "threshold_crossed",
          sensor: "error_rate",
          value: 0.5,
          limit: 0.2,
          direction: "above",
        },
        suggestedCapabilities: [],
        context: {},
        emittedAt: 1,
      },
      { tools: [], agents: [], schedules: [] },
    );

    expect(plan.triggerId).toBe("gov-1");
    expect(plan.steps[0]).toMatchObject({ kind: "notify_user" });
  });

  test("falls back to the rule planner on malformed JSON", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: { async plan(): Promise<string> { return "{bad json"; } },
      fallbackToRulePlanner: createRuleBasedCompositionPlanner(),
    });

    const plan = await planner.plan(
      {
        id: "gov-1",
        source: "governance",
        confidence: 1,
        moment: {
          kind: "threshold_crossed",
          sensor: "error_rate",
          value: 0.5,
          limit: 0.2,
          direction: "above",
        },
        suggestedCapabilities: ["spawn_agent"],
        context: {},
        emittedAt: 1,
      },
      { tools: [], agents: [], schedules: [] },
    );

    expect(plan.steps.some((step) => step.kind === "spawn_agent")).toBe(true);
  });

  test("recomputes requiresApproval locally", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "low-1",
            steps: [],
            estimatedCost: 0,
            requiresApproval: false,
          });
        },
      },
    });

    const plan = await planner.plan(
      {
        id: "low-1",
        source: "governance",
        confidence: 0.1,
        moment: { kind: "capability_gap", missing: "diagnostics" },
        suggestedCapabilities: [],
        context: {},
        emittedAt: 1,
      },
      { tools: [], agents: [], schedules: [] },
    );

    expect(plan.requiresApproval).toBe(true);
  });
});
```

- [ ] **Step 2: Run the LLM planner tests to verify they fail**

Run:

```bash
bun test packages/lib/proactive/src/llm-composition-planner.test.ts
```

Expected: FAIL with missing module/export errors.

- [ ] **Step 3: Implement the validated LLM planner**

Create `packages/lib/proactive/src/llm-composition-planner.ts`:

```ts
import type {
  CompositionApprovalPolicy,
  CompositionCapabilities,
  CompositionPlan,
  CompositionPlanner,
  CompositionStep,
  CompositionTrigger,
} from "@koi/core";
import {
  computeCompositionApproval,
  DEFAULT_COMPOSITION_APPROVAL_POLICY,
} from "./composition-approval.js";

export interface CompositionPlannerAdapterInput {
  readonly trigger: CompositionTrigger;
  readonly capabilities: CompositionCapabilities;
}

export interface CompositionPlannerAdapter {
  readonly plan: (input: CompositionPlannerAdapterInput) => Promise<string>;
}

export interface LlmCompositionPlannerConfig {
  readonly adapter: CompositionPlannerAdapter;
  readonly approvalPolicy?: CompositionApprovalPolicy | undefined;
  readonly classifyNovelty?: ((trigger: CompositionTrigger) => boolean) | undefined;
  readonly fallbackToRulePlanner?: CompositionPlanner | undefined;
}

function isPriority(value: unknown): value is "low" | "normal" | "high" {
  return value === "low" || value === "normal" || value === "high";
}

function validateSteps(raw: unknown): readonly CompositionStep[] {
  if (!Array.isArray(raw)) throw new Error("steps must be an array");
  return raw.map((step) => {
    if (typeof step !== "object" || step === null) throw new Error("step must be an object");
    const value = step as Record<string, unknown>;
    if (value.kind === "notify_user") {
      if (
        typeof value.channel !== "string" ||
        typeof value.message !== "string" ||
        !isPriority(value.priority)
      ) {
        throw new Error("invalid notify_user step");
      }
      return {
        kind: "notify_user",
        channel: value.channel,
        message: value.message,
        priority: value.priority,
      };
    }
    throw new Error(`unsupported step kind: ${String(value.kind)}`);
  });
}

function parsePlan(raw: string, trigger: CompositionTrigger): Omit<CompositionPlan, "requiresApproval"> {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed.triggerId !== trigger.id) throw new Error("triggerId mismatch");
  if (typeof parsed.estimatedCost !== "number" || !Number.isFinite(parsed.estimatedCost)) {
    throw new Error("estimatedCost must be finite");
  }
  return {
    triggerId: trigger.id,
    steps: validateSteps(parsed.steps),
    estimatedCost: parsed.estimatedCost,
  };
}

export function createLlmCompositionPlanner(config: LlmCompositionPlannerConfig): CompositionPlanner {
  const approvalPolicy = config.approvalPolicy ?? DEFAULT_COMPOSITION_APPROVAL_POLICY;
  const classifyNovelty = config.classifyNovelty ?? (() => false);

  return {
    async plan(trigger, capabilities): Promise<CompositionPlan> {
      try {
        const raw = await config.adapter.plan({ trigger, capabilities });
        const parsed = parsePlan(raw, trigger);
        return {
          ...parsed,
          requiresApproval: computeCompositionApproval(
            trigger,
            parsed.estimatedCost,
            approvalPolicy,
            { isNovel: classifyNovelty(trigger) },
          ),
        };
      } catch (error) {
        if (config.fallbackToRulePlanner !== undefined) {
          return config.fallbackToRulePlanner.plan(trigger, capabilities);
        }
        throw error;
      }
    },
  };
}
```

- [ ] **Step 4: Export the LLM planner**

Update `packages/lib/proactive/src/index.ts`:

```ts
export {
  createLlmCompositionPlanner,
  type CompositionPlannerAdapter,
  type CompositionPlannerAdapterInput,
  type LlmCompositionPlannerConfig,
} from "./llm-composition-planner.js";
```

- [ ] **Step 5: Run the LLM planner tests**

Run:

```bash
bun test packages/lib/proactive/src/llm-composition-planner.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit the LLM planner work**

```bash
git add packages/lib/proactive/src/llm-composition-planner.ts \
  packages/lib/proactive/src/llm-composition-planner.test.ts \
  packages/lib/proactive/src/index.ts
git commit -m "feat(proactive): add llm composition planner"
```

---

### Task 5: Run Package Verification and Final Cleanup

**Files:**
- Verify only: `packages/kernel/core/src/composition-planner.ts`
- Verify only: `packages/lib/proactive/src/*.ts`

- [ ] **Step 1: Run the focused test suite for all new behavior**

Run:

```bash
bun test packages/kernel/core/src/system-signal.test.ts \
  packages/lib/proactive/src/composition-trigger.test.ts \
  packages/lib/proactive/src/composition-approval.test.ts \
  packages/lib/proactive/src/rule-based-composition-planner.test.ts \
  packages/lib/proactive/src/llm-composition-planner.test.ts
```

Expected: PASS

- [ ] **Step 2: Run package typechecks**

Run:

```bash
bun run --cwd packages/kernel/core typecheck
bun run --cwd packages/lib/proactive typecheck
```

Expected: PASS

- [ ] **Step 3: Run package builds**

Run:

```bash
bun run --cwd packages/kernel/core build
bun run --cwd packages/lib/proactive build
```

Expected: PASS

- [ ] **Step 4: Run package lint checks if prior steps are green**

Run:

```bash
bun run --cwd packages/kernel/core lint
bun run --cwd packages/lib/proactive lint
```

Expected: PASS

- [ ] **Step 5: Confirm git status is limited to intended files**

Run:

```bash
git status --short
```

Expected: only the new composition-planner and proactive planning files, plus any intentional snapshot updates.

- [ ] **Step 6: Create the final feature commit**

```bash
git add packages/kernel/core/src/composition-planner.ts \
  packages/kernel/core/src/index.ts \
  packages/kernel/core/src/system-signal.test.ts \
  packages/lib/proactive/src/composition-trigger.ts \
  packages/lib/proactive/src/composition-trigger.test.ts \
  packages/lib/proactive/src/composition-approval.ts \
  packages/lib/proactive/src/composition-approval.test.ts \
  packages/lib/proactive/src/rule-based-composition-planner.ts \
  packages/lib/proactive/src/rule-based-composition-planner.test.ts \
  packages/lib/proactive/src/llm-composition-planner.ts \
  packages/lib/proactive/src/llm-composition-planner.test.ts \
  packages/lib/proactive/src/index.ts
git commit -m "feat(proactive): add composition planning"
```

---

## Self-Review

### Spec Coverage

- L0 `CompositionTrigger` contract: covered in Task 1
- `SystemSignal -> CompositionTrigger` mapper: covered in Task 2
- Rule-based planner: covered in Task 3
- LLM planner with validation/fallback: covered in Task 4
- Approval classification: covered in Task 3 and exercised again in Task 4
- Verification/build/typecheck: covered in Task 5

### Placeholder Scan

- No `TBD`, `TODO`, or “implement later” placeholders remain
- Each task includes exact files, commands, and code snippets

### Type Consistency

- `task_terminal` is used consistently across contract, mapper, and planner steps
- `submit_task` / `create_schedule` are the only scheduler-related step names in the plan
- `CompositionPlannerAdapterInput` and `LlmCompositionPlannerConfig` naming is consistent across Task 4
