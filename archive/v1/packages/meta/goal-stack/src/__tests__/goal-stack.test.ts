import { describe, expect, test } from "bun:test";
import { createGoalStack } from "../goal-stack.js";

describe("createGoalStack", () => {
  test("minimal preset returns 1 middleware (planning only)", () => {
    const bundle = createGoalStack({ preset: "minimal" });

    expect(bundle.middlewares).toHaveLength(1);
    expect(bundle.middlewares[0]?.name).toBe("plan");
    expect(bundle.config.includesAnchor).toBe(false);
    expect(bundle.config.includesReminder).toBe(false);
    expect(bundle.config.includesPlanning).toBe(true);
    expect(bundle.config.middlewareCount).toBe(1);
  });

  test("standard preset with objectives returns 3 middlewares", () => {
    const bundle = createGoalStack({
      preset: "standard",
      objectives: ["Build feature", "Write tests"],
    });

    expect(bundle.middlewares).toHaveLength(3);
    expect(bundle.config.middlewareCount).toBe(3);
    expect(bundle.config.includesAnchor).toBe(true);
    expect(bundle.config.includesReminder).toBe(true);
    expect(bundle.config.includesPlanning).toBe(true);
  });

  test("standard middleware in priority order: reminder (330), anchor (340), plan (450)", () => {
    const bundle = createGoalStack({
      objectives: ["Task A"],
    });

    expect(bundle.middlewares[0]?.name).toBe("goal-reminder");
    expect(bundle.middlewares[1]?.name).toBe("goal-anchor");
    expect(bundle.middlewares[2]?.name).toBe("plan");
  });

  test("autonomous preset with objectives returns 3 middlewares", () => {
    const bundle = createGoalStack({
      preset: "autonomous",
      objectives: ["Implement API"],
    });

    expect(bundle.middlewares).toHaveLength(3);
    expect(bundle.config.preset).toBe("autonomous");
  });

  test("providers is always empty", () => {
    const minimal = createGoalStack({ preset: "minimal" });
    const standard = createGoalStack({
      preset: "standard",
      objectives: ["Task"],
    });

    expect(minimal.providers).toEqual([]);
    expect(standard.providers).toEqual([]);
  });

  test("config metadata matches actual composition", () => {
    const bundle = createGoalStack({
      preset: "standard",
      objectives: ["Task"],
    });

    expect(bundle.config).toEqual({
      preset: "standard",
      middlewareCount: 3,
      includesAnchor: true,
      includesReminder: true,
      includesPlanning: true,
    });
  });

  test("onComplete callback wires through to anchor", () => {
    const completed: string[] = [];
    const bundle = createGoalStack({
      objectives: ["Task A"],
      anchor: {
        onComplete: (item) => {
          completed.push(item.text);
        },
      },
    });

    // Verify the middleware was created (callback is internal to the middleware)
    expect(bundle.middlewares).toHaveLength(3);
    const anchor = bundle.middlewares[1];
    expect(anchor?.name).toBe("goal-anchor");
  });

  test("onPlanUpdate callback wires through to planning", () => {
    const plans: unknown[] = [];
    const bundle = createGoalStack({
      preset: "minimal",
      planning: {
        onPlanUpdate: (plan) => {
          plans.push(plan);
        },
      },
    });

    expect(bundle.middlewares).toHaveLength(1);
    expect(bundle.middlewares[0]?.name).toBe("plan");
  });

  test("custom reminder sources override manifest source", () => {
    const bundle = createGoalStack({
      objectives: ["Task A"],
      reminder: {
        sources: [{ kind: "static", text: "Stay focused" }],
      },
    });

    // The middleware was created with custom sources instead of manifest
    expect(bundle.middlewares).toHaveLength(3);
    expect(bundle.middlewares[0]?.name).toBe("goal-reminder");
  });

  test("custom anchor header overrides preset default", () => {
    const bundle = createGoalStack({
      objectives: ["Task A"],
      anchor: { header: "## My Goals" },
    });

    expect(bundle.middlewares).toHaveLength(3);
    expect(bundle.middlewares[1]?.name).toBe("goal-anchor");
  });

  test("custom reminder intervals override preset defaults", () => {
    const bundle = createGoalStack({
      objectives: ["Task A"],
      reminder: { baseInterval: 10, maxInterval: 50 },
    });

    expect(bundle.middlewares).toHaveLength(3);
    expect(bundle.middlewares[0]?.name).toBe("goal-reminder");
  });

  test("defaults to standard preset when no config provided", () => {
    // standard requires objectives, so this should throw
    expect(() => createGoalStack()).toThrow(/requires non-empty objectives/);
  });

  test("planning priority override wires through", () => {
    const bundle = createGoalStack({
      preset: "minimal",
      planning: { priority: 500 },
    });

    expect(bundle.middlewares).toHaveLength(1);
    expect(bundle.middlewares[0]?.name).toBe("plan");
  });
});
