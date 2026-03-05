/**
 * Unit tests for the createQualityGate factory.
 */

import { describe, expect, test } from "bun:test";
import { nonEmpty } from "@koi/middleware-output-verifier";
import { createQualityGate } from "./quality-gate.js";

describe("createQualityGate", () => {
  test("light preset: only verifier, no feedbackLoop, no budget", () => {
    const bundle = createQualityGate({ preset: "light" });
    expect(bundle.config.verifierEnabled).toBe(true);
    expect(bundle.config.feedbackLoopEnabled).toBe(false);
    expect(bundle.config.budgetEnabled).toBe(false);
    expect(bundle.middleware).toHaveLength(1);
  });

  test("standard preset: verifier + feedbackLoop + budget", () => {
    const bundle = createQualityGate({ preset: "standard" });
    expect(bundle.config.verifierEnabled).toBe(true);
    expect(bundle.config.feedbackLoopEnabled).toBe(true);
    expect(bundle.config.budgetEnabled).toBe(true);
    expect(bundle.middleware).toHaveLength(3);
  });

  test("exposes verifier handle with getStats and reset", () => {
    const bundle = createQualityGate({
      verifier: { deterministic: [nonEmpty("block")] },
    });
    expect(bundle.verifier).toBeDefined();
    expect(bundle.verifier?.getStats().totalChecks).toBe(0);
    expect(typeof bundle.verifier?.reset).toBe("function");
  });

  test("exposes feedbackLoop handle when configured", () => {
    const bundle = createQualityGate({
      feedbackLoop: {},
    });
    expect(bundle.feedbackLoop).toBeDefined();
    expect(typeof bundle.feedbackLoop?.isQuarantined).toBe("function");
  });

  test("reset() cascades to verifier", () => {
    const bundle = createQualityGate({ preset: "standard" });
    // Just verifying reset doesn't throw
    bundle.reset();
    expect(bundle.verifier?.getStats().totalChecks).toBe(0);
  });
});
