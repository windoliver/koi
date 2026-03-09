/**
 * Integration tests for retry-stack middleware composition.
 */

import { describe, expect, test } from "bun:test";
import type { BacktrackReason, SessionContext } from "@koi/core";
import { createRetryStack } from "../retry-stack.js";

function makeReason(message: string): BacktrackReason {
  return { kind: "manual", message, timestamp: Date.now() };
}

const STUB_SESSION: SessionContext = {
  sessionId: "test-session-1",
  agentId: "test-agent",
} as SessionContext;

describe("retry-stack composition", () => {
  test("full stack composes without error", () => {
    const bundle = createRetryStack({ preset: "aggressive" });
    expect(bundle.middleware.length).toBeGreaterThanOrEqual(2);
    expect(bundle.semanticRetry).toBeDefined();
    expect(bundle.guidedRetry).toBeDefined();
  });

  test("middleware names are correct in array", () => {
    const bundle = createRetryStack({});
    const names = bundle.middleware.map((mw) => mw.name);

    expect(names).toContain("semantic-retry");
    expect(names).toContain("guided-retry");
  });

  test("reset and re-use cycle works", async () => {
    const bundle = createRetryStack({});

    // Initialize session so per-session state exists
    for (const mw of bundle.middleware) {
      if (mw.onSessionStart) await mw.onSessionStart(STUB_SESSION);
    }

    // Set some state
    bundle.guidedRetry.setConstraint({
      reason: makeReason("test"),
      maxInjections: 1,
    });
    expect(bundle.guidedRetry.hasConstraint()).toBe(true);

    // Reset
    bundle.reset();
    expect(bundle.guidedRetry.hasConstraint()).toBe(false);

    // Re-use: set state again
    bundle.guidedRetry.setConstraint({
      reason: makeReason("test-2"),
      maxInjections: 2,
    });
    expect(bundle.guidedRetry.hasConstraint()).toBe(true);
  });
});
