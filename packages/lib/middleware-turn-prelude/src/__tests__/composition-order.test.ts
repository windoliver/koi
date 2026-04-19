import { describe, expect, test } from "bun:test";
import { createPendingMatchStore } from "@koi/watch-patterns";
import { createTurnPreludeMiddleware } from "../middleware.js";

describe("composition-order invariant", () => {
  test("turn-prelude declares phase='resolve' and a priority that sorts outside semantic-retry (420) and task-anchor (345)", () => {
    const mw = createTurnPreludeMiddleware({
      getStore: () => createPendingMatchStore(),
      getTaskStatus: () => undefined,
    });

    // phase must be 'resolve' — same phase as other prepend-style middleware
    expect(mw.phase).toBe("resolve");

    // priority must run BEFORE task-anchor (345) and semantic-retry (420)
    // Lower number = earlier / outermost in the resolve phase.
    const priority = mw.priority ?? Number.POSITIVE_INFINITY;
    expect(priority).toBeLessThan(345); // task-anchor
    expect(priority).toBeLessThan(420); // semantic-retry
  });
});
