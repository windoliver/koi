/**
 * Tests for configuration validation.
 */

import { describe, expect, test } from "bun:test";
import { validateGovernanceMemoryConfig } from "./config.js";

describe("validateGovernanceMemoryConfig", () => {
  test("valid minimal config → ok", () => {
    const result = validateGovernanceMemoryConfig({});
    expect(result.ok).toBe(true);
  });

  test("valid full config → ok", () => {
    const result = validateGovernanceMemoryConfig({
      rules: [
        {
          id: "r1",
          effect: "permit",
          priority: 0,
          condition: () => true,
          message: "Allow all",
        },
      ],
      complianceCapacity: 500,
      violationCapacity: 100,
      getRecentAnomalies: () => [],
      elevateOnAnomalyKinds: ["error_spike"],
      policyFingerprint: "v1",
    });
    expect(result.ok).toBe(true);
  });

  test("null config → validation error", () => {
    const result = validateGovernanceMemoryConfig(null);
    expect(result.ok).toBe(false);
  });

  test("undefined config → validation error", () => {
    const result = validateGovernanceMemoryConfig(undefined);
    expect(result.ok).toBe(false);
  });

  test("non-object config → validation error", () => {
    const result = validateGovernanceMemoryConfig("string");
    expect(result.ok).toBe(false);
  });

  test("rules not an array → validation error", () => {
    const result = validateGovernanceMemoryConfig({ rules: "not-array" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("rules");
    }
  });

  test("rule without id → validation error", () => {
    const result = validateGovernanceMemoryConfig({
      rules: [{ effect: "permit", priority: 0, condition: () => true, message: "m" }],
    });
    expect(result.ok).toBe(false);
  });

  test("rule with invalid effect → validation error", () => {
    const result = validateGovernanceMemoryConfig({
      rules: [{ id: "r1", effect: "invalid", priority: 0, condition: () => true, message: "m" }],
    });
    expect(result.ok).toBe(false);
  });

  test("rule without condition function → validation error", () => {
    const result = validateGovernanceMemoryConfig({
      rules: [{ id: "r1", effect: "permit", priority: 0, condition: "not-fn", message: "m" }],
    });
    expect(result.ok).toBe(false);
  });

  test("complianceCapacity not a positive integer → validation error", () => {
    const result = validateGovernanceMemoryConfig({ complianceCapacity: -1 });
    expect(result.ok).toBe(false);
  });

  test("complianceCapacity zero → validation error", () => {
    const result = validateGovernanceMemoryConfig({ complianceCapacity: 0 });
    expect(result.ok).toBe(false);
  });

  test("complianceCapacity non-integer → validation error", () => {
    const result = validateGovernanceMemoryConfig({ complianceCapacity: 1.5 });
    expect(result.ok).toBe(false);
  });

  test("violationCapacity not a positive integer → validation error", () => {
    const result = validateGovernanceMemoryConfig({ violationCapacity: 0 });
    expect(result.ok).toBe(false);
  });

  test("getRecentAnomalies not a function → validation error", () => {
    const result = validateGovernanceMemoryConfig({ getRecentAnomalies: "not-fn" });
    expect(result.ok).toBe(false);
  });

  test("elevateOnAnomalyKinds not an array → validation error", () => {
    const result = validateGovernanceMemoryConfig({ elevateOnAnomalyKinds: "not-array" });
    expect(result.ok).toBe(false);
  });

  test("elevateOnAnomalyKinds with non-string entry → validation error", () => {
    const result = validateGovernanceMemoryConfig({ elevateOnAnomalyKinds: [123] });
    expect(result.ok).toBe(false);
  });

  test("policyFingerprint not a string → validation error", () => {
    const result = validateGovernanceMemoryConfig({ policyFingerprint: 123 });
    expect(result.ok).toBe(false);
  });
});
