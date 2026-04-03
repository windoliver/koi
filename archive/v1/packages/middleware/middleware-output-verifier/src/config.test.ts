/**
 * Unit tests for validateVerifierConfig.
 */

import { describe, expect, test } from "bun:test";
import { validateVerifierConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Valid configs
// ---------------------------------------------------------------------------

describe("validateVerifierConfig — valid configs", () => {
  test("deterministic only", () => {
    const result = validateVerifierConfig({
      deterministic: [{ name: "non-empty", check: (c: string) => c.length > 0, action: "block" }],
    });
    expect(result.ok).toBe(true);
  });

  test("judge only", () => {
    const result = validateVerifierConfig({
      judge: {
        rubric: "Be helpful",
        modelCall: async () => "{}",
      },
    });
    expect(result.ok).toBe(true);
  });

  test("both deterministic and judge", () => {
    const result = validateVerifierConfig({
      deterministic: [{ name: "test", check: () => true, action: "warn" }],
      judge: {
        rubric: "Be helpful",
        modelCall: async () => "{}",
      },
    });
    expect(result.ok).toBe(true);
  });

  test("all optional fields present", () => {
    const result = validateVerifierConfig({
      deterministic: [{ name: "test", check: () => true, action: "revise" }],
      judge: {
        rubric: "Be helpful",
        modelCall: async () => "{}",
        vetoThreshold: 0.8,
        samplingRate: 0.5,
        action: "warn",
        maxContentLength: 1000,
        randomFn: () => 0.5,
      },
      maxRevisions: 2,
      revisionFeedbackMaxLength: 200,
      maxBufferSize: 1024,
      onVeto: () => {},
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invalid: non-object / empty
// ---------------------------------------------------------------------------

describe("validateVerifierConfig — invalid top-level", () => {
  test("null returns error", () => {
    const result = validateVerifierConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("undefined returns error", () => {
    const result = validateVerifierConfig(undefined);
    expect(result.ok).toBe(false);
  });

  test("string returns error", () => {
    const result = validateVerifierConfig("not an object");
    expect(result.ok).toBe(false);
  });

  test("number returns error", () => {
    const result = validateVerifierConfig(42);
    expect(result.ok).toBe(false);
  });

  test("array returns error", () => {
    const result = validateVerifierConfig([1, 2, 3]);
    expect(result.ok).toBe(false);
  });

  test("empty object returns error (no deterministic or judge)", () => {
    const result = validateVerifierConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("at least one");
  });
});

// ---------------------------------------------------------------------------
// Invalid deterministic checks
// ---------------------------------------------------------------------------

describe("validateVerifierConfig — invalid deterministic", () => {
  test("deterministic not array", () => {
    const result = validateVerifierConfig({ deterministic: "not-array" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("array");
  });

  test("deterministic entry not object", () => {
    const result = validateVerifierConfig({ deterministic: [42] });
    expect(result.ok).toBe(false);
  });

  test("deterministic entry missing name", () => {
    const result = validateVerifierConfig({
      deterministic: [{ check: () => true, action: "block" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("name");
  });

  test("deterministic entry empty name", () => {
    const result = validateVerifierConfig({
      deterministic: [{ name: "", check: () => true, action: "block" }],
    });
    expect(result.ok).toBe(false);
  });

  test("deterministic entry missing check", () => {
    const result = validateVerifierConfig({
      deterministic: [{ name: "test", action: "block" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("check");
  });

  test("deterministic entry invalid action", () => {
    const result = validateVerifierConfig({
      deterministic: [{ name: "test", check: () => true, action: "invalid" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("action");
  });
});

// ---------------------------------------------------------------------------
// Invalid judge config
// ---------------------------------------------------------------------------

describe("validateVerifierConfig — invalid judge", () => {
  test("judge not object", () => {
    const result = validateVerifierConfig({ judge: "string" });
    expect(result.ok).toBe(false);
  });

  test("judge missing rubric", () => {
    const result = validateVerifierConfig({
      judge: { modelCall: async () => "{}" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("rubric");
  });

  test("judge empty rubric", () => {
    const result = validateVerifierConfig({
      judge: { rubric: "", modelCall: async () => "{}" },
    });
    expect(result.ok).toBe(false);
  });

  test("judge missing modelCall", () => {
    const result = validateVerifierConfig({
      judge: { rubric: "test" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("modelCall");
  });

  test("judge vetoThreshold out of range (negative)", () => {
    const result = validateVerifierConfig({
      judge: { rubric: "test", modelCall: async () => "{}", vetoThreshold: -0.1 },
    });
    expect(result.ok).toBe(false);
  });

  test("judge vetoThreshold out of range (> 1)", () => {
    const result = validateVerifierConfig({
      judge: { rubric: "test", modelCall: async () => "{}", vetoThreshold: 1.1 },
    });
    expect(result.ok).toBe(false);
  });

  test("judge samplingRate out of range", () => {
    const result = validateVerifierConfig({
      judge: { rubric: "test", modelCall: async () => "{}", samplingRate: 2 },
    });
    expect(result.ok).toBe(false);
  });

  test("judge maxContentLength not positive integer", () => {
    const result = validateVerifierConfig({
      judge: { rubric: "test", modelCall: async () => "{}", maxContentLength: 0 },
    });
    expect(result.ok).toBe(false);
  });

  test("judge randomFn not a function", () => {
    const result = validateVerifierConfig({
      judge: { rubric: "test", modelCall: async () => "{}", randomFn: 42 },
    });
    expect(result.ok).toBe(false);
  });

  test("judge invalid action", () => {
    const result = validateVerifierConfig({
      judge: { rubric: "test", modelCall: async () => "{}", action: "invalid" },
    });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge values
// ---------------------------------------------------------------------------

describe("validateVerifierConfig — edge values", () => {
  test("maxRevisions=0 is valid", () => {
    const result = validateVerifierConfig({
      deterministic: [{ name: "test", check: () => true, action: "block" }],
      maxRevisions: 0,
    });
    expect(result.ok).toBe(true);
  });

  test("maxRevisions negative is invalid", () => {
    const result = validateVerifierConfig({
      deterministic: [{ name: "test", check: () => true, action: "block" }],
      maxRevisions: -1,
    });
    expect(result.ok).toBe(false);
  });

  test("maxRevisions float is invalid", () => {
    const result = validateVerifierConfig({
      deterministic: [{ name: "test", check: () => true, action: "block" }],
      maxRevisions: 1.5,
    });
    expect(result.ok).toBe(false);
  });

  test("vetoThreshold=0 is valid", () => {
    const result = validateVerifierConfig({
      judge: { rubric: "test", modelCall: async () => "{}", vetoThreshold: 0 },
    });
    expect(result.ok).toBe(true);
  });

  test("vetoThreshold=1 is valid", () => {
    const result = validateVerifierConfig({
      judge: { rubric: "test", modelCall: async () => "{}", vetoThreshold: 1 },
    });
    expect(result.ok).toBe(true);
  });

  test("samplingRate=0 is valid", () => {
    const result = validateVerifierConfig({
      judge: { rubric: "test", modelCall: async () => "{}", samplingRate: 0 },
    });
    expect(result.ok).toBe(true);
  });

  test("maxBufferSize=0 is invalid (must be positive)", () => {
    const result = validateVerifierConfig({
      deterministic: [{ name: "test", check: () => true, action: "block" }],
      maxBufferSize: 0,
    });
    expect(result.ok).toBe(false);
  });

  test("onVeto not a function is invalid", () => {
    const result = validateVerifierConfig({
      deterministic: [{ name: "test", check: () => true, action: "block" }],
      onVeto: "not-a-function",
    });
    expect(result.ok).toBe(false);
  });

  test("revisionFeedbackMaxLength=0 is invalid (must be positive)", () => {
    const result = validateVerifierConfig({
      deterministic: [{ name: "test", check: () => true, action: "block" }],
      revisionFeedbackMaxLength: 0,
    });
    expect(result.ok).toBe(false);
  });
});
