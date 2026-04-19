import { describe, expect, test } from "bun:test";
import { createInitialState, createStore } from "@koi/tui";
import { createCostBridge } from "./cost-bridge.js";

describe("createCostBridge — setModelName", () => {
  test("recordEngineDone after setModelName attributes cost to the new model", async () => {
    const store = createStore(createInitialState("anthropic/claude-sonnet-4-6"));
    const bridge = await createCostBridge({
      store,
      sessionId: "sess-1",
      modelName: "anthropic/claude-sonnet-4-6",
      provider: "openrouter",
    });

    bridge.setModelName("anthropic/claude-sonnet-4.5");
    bridge.recordEngineDone({ inputTokens: 100, outputTokens: 50, costUsd: 0.01 });

    const breakdown = bridge.aggregator.breakdown("sess-1");
    expect(breakdown.byModel).toHaveLength(1);
    expect(breakdown.byModel[0]?.model).toBe("anthropic/claude-sonnet-4.5");

    bridge.dispose();
  });

  test("setModelName preserves sessionId and provider", async () => {
    const store = createStore(createInitialState("m1"));
    const bridge = await createCostBridge({
      store,
      sessionId: "sess-A",
      modelName: "m1",
      provider: "openrouter",
    });

    bridge.setModelName("m2");
    bridge.recordEngineDone({ inputTokens: 10, outputTokens: 5, costUsd: 0.001 });

    const breakdown = bridge.aggregator.breakdown("sess-A");
    expect(breakdown.byModel[0]?.model).toBe("m2");
    expect(breakdown.byProvider?.[0]?.provider).toBe("openrouter");

    bridge.dispose();
  });
});
