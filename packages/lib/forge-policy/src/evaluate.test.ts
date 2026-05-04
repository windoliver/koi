import { describe, expect, test } from "bun:test";
import { makeCandidate, makeConfig } from "./__tests__/fixtures.js";
import { evaluatePolicy } from "./evaluate.js";

describe("evaluatePolicy — required gating cases (issue #1349)", () => {
  test("rejects over-complex artifact via maxComplexity ceiling", () => {
    const cfg = makeConfig({ maxComplexity: 10 });
    const candidate = makeCandidate();
    const huge = { body: "x".repeat(500) };

    const verdict = evaluatePolicy(candidate, cfg, {
      spec: huge,
    });

    expect(verdict.decision).toBe("deny");
    if (verdict.decision === "deny") {
      expect(verdict.reason).toMatch(/complex/i);
    }
  });

  test("allows when complexity is within ceiling", () => {
    const cfg = makeConfig({ maxComplexity: 10_000 });
    const verdict = evaluatePolicy(makeCandidate(), cfg, { spec: { x: 1 } });
    expect(verdict.decision).toBe("allow");
  });

  test("allowed capabilities — denies kinds outside allowedKinds", () => {
    const cfg = makeConfig({ allowedKinds: ["tool"] });
    const candidate = makeCandidate({ kind: "channel" });

    const verdict = evaluatePolicy(candidate, cfg);

    expect(verdict.decision).toBe("deny");
    if (verdict.decision === "deny") {
      expect(verdict.reason).toMatch(/channel|allowed/i);
    }
  });

  test("namespace restrictions block forbidden name prefixes", () => {
    const cfg = makeConfig({ forbiddenNamespaces: ["system.", "koi."] });
    const candidate = makeCandidate({ name: "system.exec" });

    const verdict = evaluatePolicy(candidate, cfg);

    expect(verdict.decision).toBe("deny");
    if (verdict.decision === "deny") {
      expect(verdict.reason).toMatch(/system\./);
    }
  });

  test("namespace check is case-sensitive prefix match", () => {
    const cfg = makeConfig({ forbiddenNamespaces: ["System."] });
    const ok = evaluatePolicy(makeCandidate({ name: "system.exec" }), cfg);
    expect(ok.decision).toBe("allow");
    const bad = evaluatePolicy(makeCandidate({ name: "System.exec" }), cfg);
    expect(bad.decision).toBe("deny");
  });

  test("policy override requires explicit granted flag — without it, deny stands", () => {
    const cfg = makeConfig({ allowedKinds: ["tool"] });
    const candidate = makeCandidate({ kind: "channel" });

    const denyNoOverride = evaluatePolicy(candidate, cfg);
    expect(denyNoOverride.decision).toBe("deny");

    const denyWithUngrantedOverride = evaluatePolicy(candidate, cfg, {
      override: { granted: false, reason: "n/a", grantedBy: "op-1" },
    });
    expect(denyWithUngrantedOverride.decision).toBe("deny");

    const allowWithGrantedOverride = evaluatePolicy(candidate, cfg, {
      override: { granted: true, reason: "ops emergency #42", grantedBy: "op-1" },
    });
    expect(allowWithGrantedOverride.decision).toBe("allow");
  });

  test("override cannot tighten an already-allow verdict", () => {
    const cfg = makeConfig();
    const candidate = makeCandidate();
    const verdict = evaluatePolicy(candidate, cfg, {
      override: { granted: true, reason: "noop", grantedBy: "op-1" },
    });
    expect(verdict.decision).toBe("allow");
  });
});

describe("evaluatePolicy — scope and approval", () => {
  test("denies candidates above maxScope", () => {
    const cfg = makeConfig({ maxScope: "agent" });
    const verdict = evaluatePolicy(makeCandidate({ proposedScope: "global" }), cfg);
    expect(verdict.decision).toBe("deny");
    if (verdict.decision === "deny") {
      expect(verdict.reason).toMatch(/scope/i);
    }
  });

  test("requires approval at or above the approval threshold", () => {
    const cfg = makeConfig({
      maxScope: "global",
      requireApprovalAtOrAbove: "zone",
    });
    const verdict = evaluatePolicy(makeCandidate({ proposedScope: "zone" }), cfg);
    expect(verdict.decision).toBe("require-approval");
  });
});

describe("evaluatePolicy — determinism and purity", () => {
  test("same inputs always produce the same verdict", () => {
    const cfg = makeConfig({ maxComplexity: 5 });
    const candidate = makeCandidate();
    const spec = { a: 1, b: 2 };
    const v1 = evaluatePolicy(candidate, cfg, { spec });
    const v2 = evaluatePolicy(candidate, cfg, { spec });
    expect(v1).toEqual(v2);
  });

  test("complexity score is order-independent for spec keys", () => {
    const cfg = makeConfig({ maxComplexity: 30 });
    const a = evaluatePolicy(makeCandidate(), cfg, { spec: { a: 1, b: 2 } });
    const b = evaluatePolicy(makeCandidate(), cfg, { spec: { b: 2, a: 1 } });
    expect(a.decision).toBe(b.decision);
  });

  test("custom complexityOf replaces default heuristic", () => {
    const cfg = makeConfig({ maxComplexity: 10 });
    const verdict = evaluatePolicy(makeCandidate(), cfg, {
      spec: { huge: "x".repeat(1000) },
      complexityOf: () => 1,
    });
    expect(verdict.decision).toBe("allow");
  });

  test("non-finite complexityOf result is treated as zero", () => {
    const cfg = makeConfig({ maxComplexity: 1 });
    const verdict = evaluatePolicy(makeCandidate(), cfg, {
      spec: { x: 1 },
      complexityOf: () => Number.NaN,
    });
    expect(verdict.decision).toBe("allow");
  });
});
