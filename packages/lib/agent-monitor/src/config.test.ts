import { describe, expect, test } from "bun:test";
import { DEFAULT_THRESHOLDS, validateAgentMonitorConfig } from "./config.js";

describe("validateAgentMonitorConfig", () => {
  test("accepts empty config", () => {
    const r = validateAgentMonitorConfig({});
    expect(r.ok).toBe(true);
  });

  test("accepts full valid config", () => {
    const r = validateAgentMonitorConfig({
      thresholds: { ...DEFAULT_THRESHOLDS },
      objectives: ["search the web"],
      goalDrift: { threshold: 0.5 },
      destructiveToolIds: ["delete"],
      spawnToolIds: ["spawn"],
      agentDepth: 0,
    });
    expect(r.ok).toBe(true);
  });

  test("rejects non-object", () => {
    const r = validateAgentMonitorConfig(null);
    expect(r.ok).toBe(false);
  });

  test("rejects negative threshold", () => {
    const r = validateAgentMonitorConfig({
      thresholds: { maxToolCallsPerTurn: -1 },
    });
    expect(r.ok).toBe(false);
  });

  test("rejects latencyAnomalyFactor < 1", () => {
    const r = validateAgentMonitorConfig({
      thresholds: { latencyAnomalyFactor: 0.5 },
    });
    expect(r.ok).toBe(false);
  });

  test("rejects minLatencySamples < 1", () => {
    const r = validateAgentMonitorConfig({
      thresholds: { minLatencySamples: 0 },
    });
    expect(r.ok).toBe(false);
  });

  test("rejects goalDrift.threshold > 1", () => {
    const r = validateAgentMonitorConfig({ goalDrift: { threshold: 1.5 } });
    expect(r.ok).toBe(false);
  });

  test("rejects goalDrift.threshold < 0", () => {
    const r = validateAgentMonitorConfig({ goalDrift: { threshold: -0.1 } });
    expect(r.ok).toBe(false);
  });

  test("rejects empty objective string", () => {
    const r = validateAgentMonitorConfig({ objectives: ["valid", ""] });
    expect(r.ok).toBe(false);
  });

  test("rejects negative agentDepth", () => {
    const r = validateAgentMonitorConfig({ agentDepth: -1 });
    expect(r.ok).toBe(false);
  });

  test("rejects NaN threshold", () => {
    const r = validateAgentMonitorConfig({ thresholds: { maxToolCallsPerTurn: Number.NaN } });
    expect(r.ok).toBe(false);
  });

  test("rejects Infinity threshold", () => {
    const r = validateAgentMonitorConfig({ thresholds: { maxToolCallsPerTurn: Infinity } });
    expect(r.ok).toBe(false);
  });
});
