import { describe, expect, test } from "bun:test";
import type { CostEntry } from "@koi/core/cost-tracker";
import { exportCostJson } from "./export-json.js";
import { createCostAggregator } from "./tracker.js";

function makeEntry(overrides?: Partial<CostEntry>): CostEntry {
  return {
    inputTokens: 100,
    outputTokens: 50,
    model: "gpt-4o",
    costUsd: 0.001,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("exportCostJson", () => {
  test("exports empty state for unknown session", () => {
    const agg = createCostAggregator();
    const payload = exportCostJson(agg, "unknown");

    expect(payload.sessionId).toBe("unknown");
    expect(payload.breakdown.totalCostUsd).toBe(0);
    expect(payload.entries).toEqual([]);
    expect(payload.formattedTotal).toBe("$0.0000");
    expect(payload.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("exports breakdown and entries for active session", () => {
    const agg = createCostAggregator();
    agg.record("s1", makeEntry({ model: "gpt-4o", costUsd: 0.01 }));
    agg.record("s1", makeEntry({ model: "claude-opus-4-6", costUsd: 0.05 }));

    const payload = exportCostJson(agg, "s1");

    expect(payload.breakdown.totalCostUsd).toBeCloseTo(0.06, 10);
    expect(payload.breakdown.byModel).toHaveLength(2);
    expect(payload.entries).toHaveLength(2);
    expect(payload.formattedTotal).toBe("$0.06");
  });

  test("includes token rate when provided", () => {
    const agg = createCostAggregator();
    agg.record("s1", makeEntry({ costUsd: 0.01 }));

    const mockRate = {
      record: () => {},
      inputPerSecond: () => 42.5,
      outputPerSecond: () => 21.3,
      clear: () => {},
    };

    const payload = exportCostJson(agg, "s1", mockRate);
    expect(payload.tokenRate).toBeDefined();
    expect(payload.tokenRate?.inputPerSecond).toBe(42.5);
    expect(payload.tokenRate?.outputPerSecond).toBe(21.3);
  });

  test("omits token rate when not provided", () => {
    const agg = createCostAggregator();
    const payload = exportCostJson(agg, "s1");
    expect(payload.tokenRate).toBeUndefined();
  });

  test("payload is JSON-serializable", () => {
    const agg = createCostAggregator();
    agg.record("s1", makeEntry({ costUsd: 0.01, provider: "openai", agentId: "a1" }));

    const payload = exportCostJson(agg, "s1");
    const json = JSON.stringify(payload);
    const parsed = JSON.parse(json);

    expect(parsed.breakdown.totalCostUsd).toBeCloseTo(0.01, 10);
    expect(parsed.entries).toHaveLength(1);
  });
});
