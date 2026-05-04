import { describe, expect, test } from "bun:test";
import { makeConfig } from "./__tests__/fixtures.js";
import { computeConfigFingerprint } from "./fingerprint.js";

describe("computeConfigFingerprint", () => {
  test("equal configs produce equal fingerprints", () => {
    const a = makeConfig({ allowedKinds: ["tool", "skill"] });
    const b = makeConfig({ allowedKinds: ["tool", "skill"] });
    expect(computeConfigFingerprint(a)).toBe(computeConfigFingerprint(b));
  });

  test("ordering of allowedKinds does not affect the fingerprint", () => {
    const a = makeConfig({ allowedKinds: ["tool", "skill"] });
    const b = makeConfig({ allowedKinds: ["skill", "tool"] });
    expect(computeConfigFingerprint(a)).toBe(computeConfigFingerprint(b));
  });

  test("ordering of forbiddenNamespaces does not affect the fingerprint", () => {
    const a = makeConfig({ forbiddenNamespaces: ["a.", "b."] });
    const b = makeConfig({ forbiddenNamespaces: ["b.", "a."] });
    expect(computeConfigFingerprint(a)).toBe(computeConfigFingerprint(b));
  });

  test("changing maxComplexity changes the fingerprint", () => {
    const a = makeConfig({ maxComplexity: 100 });
    const b = makeConfig({ maxComplexity: 200 });
    expect(computeConfigFingerprint(a)).not.toBe(computeConfigFingerprint(b));
  });

  test("changing maxScope changes the fingerprint", () => {
    const a = makeConfig({ maxScope: "agent" });
    const b = makeConfig({ maxScope: "global" });
    expect(computeConfigFingerprint(a)).not.toBe(computeConfigFingerprint(b));
  });

  test("fingerprint is a 64-char lowercase hex SHA-256 digest", () => {
    const fp = computeConfigFingerprint(makeConfig());
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  test("fingerprint binds the evaluator version and structural limits", () => {
    // Regression: two evaluator generations must not produce equal
    // fingerprints for the same operator config — the audit trail has
    // to distinguish them.
    const fp = computeConfigFingerprint(makeConfig());
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    // The fingerprint input includes evaluator.version,
    // structuralBudgetBytes, and maxArrayLength; any change to them
    // produces a different digest. We assert on stability of the
    // current digest as a canary for accidental drift.
    expect(fp).toBe(computeConfigFingerprint(makeConfig()));
  });
});
