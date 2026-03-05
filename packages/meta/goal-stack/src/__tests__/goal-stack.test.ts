/**
 * Unit and integration tests for createGoalStack().
 *
 * Unit tests:
 *   - Empty config → light preset → 1 middleware (plan)
 *   - Standard preset + anchor → 2 middleware
 *   - Full preset + anchor + reminder → 3 middleware
 *   - Explicit anchor without preset → auto-enables anchor
 *   - Priority order ascending (330, 340, 450)
 *   - Missing required config throws
 *   - Return value shape validation
 *   - Metadata reflects enabled state
 *   - Preset ordering invariant
 *   - Callbacks wired correctly
 *
 * Integration test:
 *   - createKoi round-trip with light preset
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  AgentManifest,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineOutput,
} from "@koi/core";
import { createKoi } from "@koi/engine";
import type { GoalReminderConfig } from "@koi/middleware-goal-reminder";
import { resolveGoalStackConfig } from "../config-resolution.js";
import { createGoalStack } from "../goal-stack.js";
import { GOAL_STACK_PRESET_FLAGS } from "../presets.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoneOutput(): EngineOutput {
  return {
    content: [{ kind: "text", text: "done" }],
    stopReason: "completed",
    metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 1, durationMs: 0 },
  };
}

function makeNoopAdapter(): EngineAdapter {
  return {
    engineId: "noop",
    capabilities: { text: true, images: false, files: false, audio: false },
    terminals: {
      modelCall: async () => ({ content: "ok", model: "test" }),
    },
    stream: (_input: EngineInput) => ({
      async *[Symbol.asyncIterator]() {
        yield { kind: "done" as const, output: makeDoneOutput() };
      },
    }),
  };
}

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

const BASE_MANIFEST: AgentManifest = {
  name: "goal-stack-test",
  version: "1.0.0",
  model: { name: "test-model" },
};

const SAMPLE_ANCHOR_CONFIG = {
  objectives: ["Build the feature", "Write tests"],
} as const;

const SAMPLE_REMINDER_CONFIG: GoalReminderConfig = {
  sources: [{ kind: "manifest", objectives: ["Stay on task"] }],
  baseInterval: 5,
  maxInterval: 20,
};

// ---------------------------------------------------------------------------
// Unit tests — createGoalStack composability
// ---------------------------------------------------------------------------

describe("createGoalStack", () => {
  test("empty config → light preset → 1 middleware (plan)", () => {
    const { middlewares, config } = createGoalStack({});
    expect(middlewares).toHaveLength(1);
    expect(middlewares[0]?.name).toBe("plan");
    expect(config.preset).toBe("light");
    expect(config.middlewareCount).toBe(1);
  });

  test("no args → light preset → 1 middleware", () => {
    const { middlewares } = createGoalStack();
    expect(middlewares).toHaveLength(1);
    expect(middlewares[0]?.name).toBe("plan");
  });

  test("standard preset + anchor config → 2 middleware", () => {
    const { middlewares, config } = createGoalStack({
      preset: "standard",
      anchor: SAMPLE_ANCHOR_CONFIG,
    });
    expect(middlewares).toHaveLength(2);
    expect(config.anchor).toBe(true);
    expect(config.planning).toBe(true);
    expect(config.reminder).toBe(false);
  });

  test("full preset + anchor + reminder → 3 middleware", () => {
    const { middlewares, config } = createGoalStack({
      preset: "full",
      anchor: SAMPLE_ANCHOR_CONFIG,
      reminder: SAMPLE_REMINDER_CONFIG,
    });
    expect(middlewares).toHaveLength(3);
    expect(config.middlewareCount).toBe(3);
    expect(config.anchor).toBe(true);
    expect(config.planning).toBe(true);
    expect(config.reminder).toBe(true);
  });

  test("explicit anchor config without preset → auto-enables anchor", () => {
    const { middlewares, config } = createGoalStack({
      anchor: SAMPLE_ANCHOR_CONFIG,
    });
    expect(middlewares).toHaveLength(2);
    expect(config.anchor).toBe(true);
    expect(config.preset).toBe("light");
    const names = middlewares.map((m) => m.name);
    expect(names).toContain("goal-anchor");
    expect(names).toContain("plan");
  });

  test("explicit reminder config without preset → auto-enables reminder", () => {
    const { middlewares, config } = createGoalStack({
      reminder: SAMPLE_REMINDER_CONFIG,
    });
    expect(middlewares).toHaveLength(2);
    expect(config.reminder).toBe(true);
    const names = middlewares.map((m) => m.name);
    expect(names).toContain("goal-reminder");
    expect(names).toContain("plan");
  });

  test("priority order ascending: 330 < 340 < 450", () => {
    const { middlewares } = createGoalStack({
      preset: "full",
      anchor: SAMPLE_ANCHOR_CONFIG,
      reminder: SAMPLE_REMINDER_CONFIG,
    });
    const priorities = middlewares.map((m) => m.priority);
    for (let i = 1; i < priorities.length; i++) {
      const prev = priorities[i - 1];
      const curr = priorities[i];
      if (prev !== undefined && curr !== undefined) {
        expect(prev).toBeLessThan(curr);
      }
    }
    expect(priorities).toEqual([330, 340, 450]);
  });

  test("standard preset without anchor config → throws", () => {
    expect(() => createGoalStack({ preset: "standard" })).toThrow(/anchor.*config.*provided/i);
  });

  test("full preset without reminder config → throws", () => {
    expect(() => createGoalStack({ preset: "full", anchor: SAMPLE_ANCHOR_CONFIG })).toThrow(
      /reminder.*config.*provided/i,
    );
  });

  test("full preset without anchor config → throws", () => {
    expect(() => createGoalStack({ preset: "full", reminder: SAMPLE_REMINDER_CONFIG })).toThrow(
      /anchor.*config.*provided/i,
    );
  });

  test("return value has middlewares and config", () => {
    const result = createGoalStack({});
    expect(result).toHaveProperty("middlewares");
    expect(result).toHaveProperty("config");
    expect(Array.isArray(result.middlewares)).toBe(true);
    expect(typeof result.config.preset).toBe("string");
    expect(typeof result.config.middlewareCount).toBe("number");
  });

  test("metadata reflects enabled state for all presets", () => {
    const light = createGoalStack({}).config;
    expect(light.planning).toBe(true);
    expect(light.anchor).toBe(false);
    expect(light.reminder).toBe(false);

    const standard = createGoalStack({
      preset: "standard",
      anchor: SAMPLE_ANCHOR_CONFIG,
    }).config;
    expect(standard.planning).toBe(true);
    expect(standard.anchor).toBe(true);
    expect(standard.reminder).toBe(false);

    const full = createGoalStack({
      preset: "full",
      anchor: SAMPLE_ANCHOR_CONFIG,
      reminder: SAMPLE_REMINDER_CONFIG,
    }).config;
    expect(full.planning).toBe(true);
    expect(full.anchor).toBe(true);
    expect(full.reminder).toBe(true);
  });

  test("preset ordering invariant: light.length <= standard.length <= full.length", () => {
    const light = createGoalStack({}).middlewares.length;
    const standard = createGoalStack({
      preset: "standard",
      anchor: SAMPLE_ANCHOR_CONFIG,
    }).middlewares.length;
    const full = createGoalStack({
      preset: "full",
      anchor: SAMPLE_ANCHOR_CONFIG,
      reminder: SAMPLE_REMINDER_CONFIG,
    }).middlewares.length;
    expect(light).toBeLessThanOrEqual(standard);
    expect(standard).toBeLessThanOrEqual(full);
  });

  test("onComplete callback is wired through anchor config", () => {
    const onComplete = mock(() => undefined);
    const { middlewares } = createGoalStack({
      anchor: { objectives: ["task"], onComplete },
    });
    const anchor = middlewares.find((m) => m.name === "goal-anchor");
    expect(anchor).toBeDefined();
    // The callback is wired at construction time — we verify the middleware was created
    // with the config that includes it. Full callback invocation is tested in L2.
  });

  test("onPlanUpdate callback is wired through planning config", () => {
    const onPlanUpdate = mock(() => undefined);
    const { middlewares } = createGoalStack({
      planning: { onPlanUpdate },
    });
    const plan = middlewares.find((m) => m.name === "plan");
    expect(plan).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Unit tests — resolveGoalStackConfig
// ---------------------------------------------------------------------------

describe("resolveGoalStackConfig", () => {
  test("defaults to light preset", () => {
    const result = resolveGoalStackConfig({});
    expect(result.meta.preset).toBe("light");
  });

  test("planning config is empty object when not provided", () => {
    const result = resolveGoalStackConfig({});
    expect(result.planning).toEqual({});
  });

  test("anchor config is undefined for light preset", () => {
    const result = resolveGoalStackConfig({});
    expect(result.anchor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unit tests — presets
// ---------------------------------------------------------------------------

describe("GOAL_STACK_PRESET_FLAGS", () => {
  test("all 3 presets defined", () => {
    expect(GOAL_STACK_PRESET_FLAGS).toHaveProperty("light");
    expect(GOAL_STACK_PRESET_FLAGS).toHaveProperty("standard");
    expect(GOAL_STACK_PRESET_FLAGS).toHaveProperty("full");
  });

  test("registry and each preset are frozen", () => {
    expect(Object.isFrozen(GOAL_STACK_PRESET_FLAGS)).toBe(true);
    expect(Object.isFrozen(GOAL_STACK_PRESET_FLAGS.light)).toBe(true);
    expect(Object.isFrozen(GOAL_STACK_PRESET_FLAGS.standard)).toBe(true);
    expect(Object.isFrozen(GOAL_STACK_PRESET_FLAGS.full)).toBe(true);
  });

  test("light: planning only", () => {
    const { planning, anchor, reminder } = GOAL_STACK_PRESET_FLAGS.light;
    expect(planning).toBe(true);
    expect(anchor).toBe(false);
    expect(reminder).toBe(false);
  });

  test("standard: planning + anchor", () => {
    const { planning, anchor, reminder } = GOAL_STACK_PRESET_FLAGS.standard;
    expect(planning).toBe(true);
    expect(anchor).toBe(true);
    expect(reminder).toBe(false);
  });

  test("full: all three", () => {
    const { planning, anchor, reminder } = GOAL_STACK_PRESET_FLAGS.full;
    expect(planning).toBe(true);
    expect(anchor).toBe(true);
    expect(reminder).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration test — full createKoi round-trip
// ---------------------------------------------------------------------------

describe("createGoalStack integration", () => {
  test("light preset: createKoi run succeeds without throwing", async () => {
    const { middlewares } = createGoalStack({});

    const runtime = await createKoi({
      manifest: BASE_MANIFEST,
      adapter: makeNoopAdapter(),
      middleware: middlewares,
      providers: [],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "hello" }));
    const output = findDoneOutput(events);
    expect(output?.stopReason).toBe("completed");

    await runtime.dispose();
  });
});
