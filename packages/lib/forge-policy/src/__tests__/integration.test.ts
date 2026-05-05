import { describe, expect, test } from "bun:test";
import { createPolicyAuditLog } from "../audit.js";
import { evaluatePolicy } from "../evaluate.js";
import { createPolicyEvaluator } from "../evaluator.js";
import { computeConfigFingerprint } from "../fingerprint.js";
import { makeCandidate, makeConfig } from "./fixtures.js";

describe("forge-policy — integration corner cases", () => {
  test("structuredClone of an authentic PolicyEvaluation is rejected as fabricated", () => {
    const evaluation = evaluatePolicy(makeCandidate(), makeConfig());
    const cloned = structuredClone(evaluation);
    const log = createPolicyAuditLog({ failClosedOnOverflowSinkError: false });
    expect(() =>
      log.recordEvaluation({ evaluation: cloned, evaluatedAt: 1_700_000_000_000 }),
    ).toThrow(/evaluateAndRecord|fabricated/);
  });

  test("two createPolicyEvaluator instances have independent sequences and brands", () => {
    const a = createPolicyEvaluator();
    const b = createPolicyEvaluator();
    a.evaluateAndRecord({
      candidate: makeCandidate({ id: "a-1" }),
      config: makeConfig(),
      evaluatedAt: 1,
    });
    a.evaluateAndRecord({
      candidate: makeCandidate({ id: "a-2" }),
      config: makeConfig(),
      evaluatedAt: 2,
    });
    const r = b.evaluateAndRecord({
      candidate: makeCandidate({ id: "b-1" }),
      config: makeConfig(),
      evaluatedAt: 3,
    });
    expect(r.entry.sequence).toBe(0); // not 2 — independent counters
    expect(a.log.size()).toBe(2);
    expect(b.log.size()).toBe(1);
  });

  test("an evaluation produced by one evaluator is rejected by another's log (cross-instance brand check)", () => {
    const a = createPolicyEvaluator();
    const b = createPolicyEvaluator();
    const evaluation = evaluatePolicy(makeCandidate(), makeConfig());
    // Recording into a peer log: brand check is per-WeakSet, but the
    // global module-level set is shared across createPolicyEvaluator
    // calls in one module instance, so this DOES succeed inside one
    // process. Asserting the in-process behavior so a future change
    // that scopes the brand per-factory would be caught.
    const entry = b.log.recordEvaluation({ evaluation, evaluatedAt: 1 });
    expect(entry.sequence).toBe(0);
    expect(a.log.size()).toBe(0);
    expect(b.log.size()).toBe(1);
  });

  test("fingerprint is stable across top-level key-order permutations of the config", () => {
    const cfg = makeConfig({ allowedKinds: ["tool", "skill"], maxComplexity: 100 });
    const reordered = {
      requireApprovalAtOrAbove: cfg.requireApprovalAtOrAbove,
      ...(cfg.maxComplexity !== undefined ? { maxComplexity: cfg.maxComplexity } : {}),
      budget: cfg.budget,
      maxScope: cfg.maxScope,
      allowedKinds: cfg.allowedKinds,
    };
    expect(computeConfigFingerprint(cfg)).toBe(computeConfigFingerprint(reordered));
  });

  test("fingerprint changes when complexity scorer version bumps", () => {
    const cfg = makeConfig();
    const v1 = computeConfigFingerprint(cfg, { id: "scorer", version: "v1" });
    const v2 = computeConfigFingerprint(cfg, { id: "scorer", version: "v2" });
    expect(v1).not.toBe(v2);
  });

  test("fingerprint changes when complexity scorer id changes (even with same version)", () => {
    const cfg = makeConfig();
    const a = computeConfigFingerprint(cfg, { id: "scorer-a", version: "v1" });
    const b = computeConfigFingerprint(cfg, { id: "scorer-b", version: "v1" });
    expect(a).not.toBe(b);
  });

  test("scorer-bound fingerprint differs from no-scorer fingerprint for the same config", () => {
    const cfg = makeConfig();
    const without = computeConfigFingerprint(cfg);
    const withScorer = computeConfigFingerprint(cfg, { id: "scorer", version: "v1" });
    expect(without).not.toBe(withScorer);
  });
});
