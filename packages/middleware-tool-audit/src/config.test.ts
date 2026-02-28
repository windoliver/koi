import { describe, expect, test } from "bun:test";
import { validateToolAuditConfig } from "./config.js";

describe("validateToolAuditConfig", () => {
  test("accepts empty object", () => {
    const result = validateToolAuditConfig({});
    expect(result.ok).toBe(true);
  });

  test("accepts fully populated config", () => {
    const result = validateToolAuditConfig({
      store: { load: () => ({ tools: {}, totalSessions: 0, lastUpdatedAt: 0 }), save: () => {} },
      unusedThresholdSessions: 50,
      lowAdoptionThreshold: 0.05,
      highFailureThreshold: 0.5,
      highValueSuccessThreshold: 0.9,
      highValueMinCalls: 20,
      minCallsForFailure: 5,
      minSessionsForAdoption: 10,
      onAuditResult: () => {},
      onError: () => {},
      clock: () => Date.now(),
    });
    expect(result.ok).toBe(true);
  });

  test("rejects null", () => {
    const result = validateToolAuditConfig(null);
    expect(result.ok).toBe(false);
  });

  test("rejects undefined", () => {
    const result = validateToolAuditConfig(undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects non-object", () => {
    const result = validateToolAuditConfig("string");
    expect(result.ok).toBe(false);
  });

  describe("store validation", () => {
    test("rejects null store", () => {
      const result = validateToolAuditConfig({ store: null });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("store");
    });

    test("rejects store without load", () => {
      const result = validateToolAuditConfig({ store: { save: () => {} } });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("load and save");
    });

    test("rejects store without save", () => {
      const result = validateToolAuditConfig({ store: { load: () => ({}) } });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("load and save");
    });
  });

  describe("numeric threshold validation", () => {
    const positiveFields = [
      "unusedThresholdSessions",
      "highValueMinCalls",
      "minCallsForFailure",
      "minSessionsForAdoption",
    ] as const;

    for (const field of positiveFields) {
      test(`rejects ${field} = 0`, () => {
        const result = validateToolAuditConfig({ [field]: 0 });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain(field);
      });

      test(`rejects ${field} = -1`, () => {
        const result = validateToolAuditConfig({ [field]: -1 });
        expect(result.ok).toBe(false);
      });

      test(`rejects ${field} = NaN`, () => {
        const result = validateToolAuditConfig({ [field]: Number.NaN });
        expect(result.ok).toBe(false);
      });

      test(`rejects ${field} = Infinity`, () => {
        const result = validateToolAuditConfig({ [field]: Number.POSITIVE_INFINITY });
        expect(result.ok).toBe(false);
      });

      test(`rejects ${field} = "string"`, () => {
        const result = validateToolAuditConfig({ [field]: "ten" });
        expect(result.ok).toBe(false);
      });

      test(`accepts ${field} = 1`, () => {
        const result = validateToolAuditConfig({ [field]: 1 });
        expect(result.ok).toBe(true);
      });
    }

    const ratioFields = [
      "lowAdoptionThreshold",
      "highFailureThreshold",
      "highValueSuccessThreshold",
    ] as const;

    for (const field of ratioFields) {
      test(`rejects ${field} = -0.1`, () => {
        const result = validateToolAuditConfig({ [field]: -0.1 });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain(field);
      });

      test(`rejects ${field} = 1.1`, () => {
        const result = validateToolAuditConfig({ [field]: 1.1 });
        expect(result.ok).toBe(false);
      });

      test(`rejects ${field} = "string"`, () => {
        const result = validateToolAuditConfig({ [field]: "half" });
        expect(result.ok).toBe(false);
      });

      test(`accepts ${field} = 0`, () => {
        const result = validateToolAuditConfig({ [field]: 0 });
        expect(result.ok).toBe(true);
      });

      test(`accepts ${field} = 1`, () => {
        const result = validateToolAuditConfig({ [field]: 1 });
        expect(result.ok).toBe(true);
      });

      test(`accepts ${field} = 0.5`, () => {
        const result = validateToolAuditConfig({ [field]: 0.5 });
        expect(result.ok).toBe(true);
      });
    }
  });

  describe("callback validation", () => {
    test("rejects non-function onAuditResult", () => {
      const result = validateToolAuditConfig({ onAuditResult: "callback" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("onAuditResult");
    });

    test("rejects non-function onError", () => {
      const result = validateToolAuditConfig({ onError: 42 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("onError");
    });

    test("rejects non-function clock", () => {
      const result = validateToolAuditConfig({ clock: true });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("clock");
    });
  });
});
