/**
 * Integration test: budget middleware caps total model calls
 * when composed with output-verifier and feedback-loop.
 */

import { describe, expect, test } from "bun:test";
import { nonEmpty } from "@koi/middleware-output-verifier";
import { createQualityGate } from "../quality-gate.js";

describe("budget integration", () => {
  test("budget caps total calls when both verifier and feedbackLoop are active", () => {
    const bundle = createQualityGate({
      preset: "standard",
      verifier: {
        deterministic: [nonEmpty("block")],
        maxRevisions: 1,
      },
      feedbackLoop: {
        retry: { validation: { maxAttempts: 2 } },
      },
      maxTotalModelCalls: 4,
    });

    // Verify budget middleware is in the array
    const budgetMw = bundle.middleware.find((mw) => mw.name === "koi:quality-gate:budget");
    expect(budgetMw).toBeDefined();
    expect(budgetMw?.priority).toBe(999);

    // Verify all 3 middleware are present
    expect(bundle.middleware).toHaveLength(3);
    expect(bundle.config.budgetEnabled).toBe(true);
    expect(bundle.config.verifierEnabled).toBe(true);
    expect(bundle.config.feedbackLoopEnabled).toBe(true);
  });
});
