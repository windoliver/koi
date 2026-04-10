import { describe, expect, it } from "bun:test";
import { rehydrateConfig } from "./rehydrate-config.js";
import { INITIAL_STATE } from "./types.js";

describe("rehydrateConfig", () => {
  it("updates resolvedPolicy to new model's window", () => {
    const state = {
      ...INITIAL_STATE,
      resolvedPolicy: {
        ...INITIAL_STATE.resolvedPolicy,
        contextWindow: 200_000,
      },
    };

    const result = rehydrateConfig(state, undefined, "claude-opus-4-6");

    expect(result.resolvedPolicy.contextWindow).toBe(1_000_000);
  });

  it("preserves epoch and currentTurn across model switch", () => {
    const state = {
      ...INITIAL_STATE,
      epoch: 7,
      currentTurn: 42,
    };

    const result = rehydrateConfig(state, undefined, "gpt-4o");

    expect(result.epoch).toBe(7);
    expect(result.currentTurn).toBe(42);
  });

  it("resets backoff state", () => {
    const state = {
      ...INITIAL_STATE,
      consecutiveFailures: 4,
      skipUntilTurn: 12,
    };

    const result = rehydrateConfig(state, undefined, "gpt-4o");

    expect(result.consecutiveFailures).toBe(0);
    expect(result.skipUntilTurn).toBe(0);
  });

  it("applies per-model policy overrides immediately", () => {
    const result = rehydrateConfig(
      INITIAL_STATE,
      {
        perModelPolicy: {
          "gpt-4o": {
            softTriggerFraction: 0.4,
          },
        },
      },
      "gpt-4o",
    );

    expect(result.resolvedPolicy.softTriggerFraction).toBe(0.4);
  });
});
