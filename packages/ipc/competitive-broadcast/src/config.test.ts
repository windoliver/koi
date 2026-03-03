import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CYCLE_CONFIG, validateCycleConfig } from "./config.js";
import {
  createSpyBroadcastSink,
  createSpySelectionStrategy,
  resetMockCounter,
} from "./test-helpers.js";

beforeEach(() => {
  resetMockCounter();
});

describe("DEFAULT_CYCLE_CONFIG", () => {
  test("has expected defaults", () => {
    expect(DEFAULT_CYCLE_CONFIG.minProposals).toBe(1);
    expect(DEFAULT_CYCLE_CONFIG.maxOutputPerProposal).toBe(10_000);
  });

  test("is frozen", () => {
    expect(Object.isFrozen(DEFAULT_CYCLE_CONFIG)).toBe(true);
  });
});

describe("validateCycleConfig", () => {
  const validConfig = {
    strategy: createSpySelectionStrategy(),
    sink: createSpyBroadcastSink().sink,
  };

  test("accepts valid config with required fields only", () => {
    const result = validateCycleConfig(validConfig);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.strategy).toBe(validConfig.strategy);
      expect(result.value.sink).toBe(validConfig.sink);
      expect(result.value.minProposals).toBe(DEFAULT_CYCLE_CONFIG.minProposals);
      expect(result.value.maxOutputPerProposal).toBe(DEFAULT_CYCLE_CONFIG.maxOutputPerProposal);
    }
  });

  test("accepts valid config with all optional fields", () => {
    const controller = new AbortController();
    const onEvent = () => {};
    const full = {
      ...validConfig,
      minProposals: 3,
      maxOutputPerProposal: 5_000,
      signal: controller.signal,
      onEvent,
    };
    const result = validateCycleConfig(full);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.minProposals).toBe(3);
      expect(result.value.maxOutputPerProposal).toBe(5_000);
      expect(result.value.signal).toBe(controller.signal);
      expect(result.value.onEvent).toBe(onEvent);
    }
  });

  test("rejects null", () => {
    const result = validateCycleConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects undefined", () => {
    const result = validateCycleConfig(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects non-object", () => {
    const result = validateCycleConfig("string");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects config without strategy", () => {
    const result = validateCycleConfig({ sink: validConfig.sink });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("strategy");
  });

  test("rejects config without sink", () => {
    const result = validateCycleConfig({ strategy: validConfig.strategy });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("sink");
  });

  test("rejects strategy without select method", () => {
    const result = validateCycleConfig({
      strategy: { name: "bad" },
      sink: validConfig.sink,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("strategy.select");
  });

  test("rejects sink without broadcast method", () => {
    const result = validateCycleConfig({
      strategy: validConfig.strategy,
      sink: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("sink.broadcast");
  });

  test("rejects minProposals < 1", () => {
    const result = validateCycleConfig({ ...validConfig, minProposals: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("minProposals");
  });

  test("rejects negative maxOutputPerProposal", () => {
    const result = validateCycleConfig({ ...validConfig, maxOutputPerProposal: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("maxOutputPerProposal");
  });

  test("rejects non-integer minProposals", () => {
    const result = validateCycleConfig({ ...validConfig, minProposals: 1.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("minProposals");
  });
});
