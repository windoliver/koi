import { describe, expect, test } from "bun:test";
import { makeCandidate, makeConfig } from "./__tests__/fixtures.js";
import {
  _createPolicyAuditLogForTesting,
  _validatePolicyAuditEntry,
  createPolicyAuditLog,
} from "./audit.js";
import { evaluatePolicy } from "./evaluate.js";
import { computeConfigFingerprint } from "./fingerprint.js";

const baseEntry = {
  candidateId: "cand-1",
  verdict: { decision: "allow" } as const,
  baseVerdict: { decision: "allow" } as const,
  evaluatedAt: 1_700_000_000_000,
  configFingerprint: "fp-abc",
  overrideApplied: false,
} as const;

describe("createPolicyAuditLog (storage behavior — _createPolicyAuditLogForTesting)", () => {
  test("records all decisions in insertion order", () => {
    const log = _createPolicyAuditLogForTesting();
    log.record({ ...baseEntry, candidateId: "a" });
    log.record({
      ...baseEntry,
      candidateId: "b",
      verdict: { decision: "deny", reason: "x" },
      baseVerdict: { decision: "deny", reason: "x" },
    });
    log.record({
      ...baseEntry,
      candidateId: "c",
      verdict: { decision: "require-approval", reason: "y" },
      baseVerdict: { decision: "require-approval", reason: "y" },
    });

    expect(log.size()).toBe(3);
    const entries = log.entries();
    expect(entries.map((e) => e.candidateId)).toEqual(["a", "b", "c"]);
    expect(entries[0]?.verdict.decision).toBe("allow");
    expect(entries[1]?.verdict.decision).toBe("deny");
    expect(entries[2]?.verdict.decision).toBe("require-approval");
  });

  test("recorded entries are deep-frozen", () => {
    const log = _createPolicyAuditLogForTesting();
    log.record({ ...baseEntry });
    const entries = log.entries();
    const first = entries[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.verdict)).toBe(true);
  });

  test("override is preserved on the entry when present", () => {
    const log = _createPolicyAuditLogForTesting();
    log.record({
      ...baseEntry,
      verdict: { decision: "allow" },
      baseVerdict: { decision: "deny", reason: "scope too high" },
      override: { granted: true, reason: "ops #42", grantedBy: "alice" },
      overrideApplied: true,
    });
    const first = log.entries()[0];
    expect(first?.override?.granted).toBe(true);
    expect(first?.override?.reason).toBe("ops #42");
    expect(first?.override?.grantedBy).toBe("alice");
  });

  test("baseVerdict is recorded so an override audit retains the bypassed reason", () => {
    const log = _createPolicyAuditLogForTesting();
    log.record({
      ...baseEntry,
      verdict: { decision: "allow" },
      baseVerdict: { decision: "deny", reason: "kind 'channel' is not in allowedKinds" },
      override: { granted: true, reason: "ops #42", grantedBy: "alice" },
      overrideApplied: true,
    });
    const first = log.entries()[0];
    expect(first?.baseVerdict.decision).toBe("deny");
    if (first?.baseVerdict.decision === "deny") {
      expect(first.baseVerdict.reason).toMatch(/channel/);
    }
    expect(first?.verdict.decision).toBe("allow");
  });

  test("rejects entries missing required fields (fail closed)", () => {
    expect(() =>
      _validatePolicyAuditEntry({
        ...baseEntry,
        // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
        candidateId: "" as any,
      }),
    ).toThrow(/candidateId/);
    expect(() =>
      _validatePolicyAuditEntry({
        ...baseEntry,
        // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
        configFingerprint: "" as any,
      }),
    ).toThrow(/configFingerprint/);
  });

  test("rejects override entries missing reason or grantedBy", () => {
    expect(() =>
      _validatePolicyAuditEntry({
        ...baseEntry,
        // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
        override: { granted: true, reason: "", grantedBy: "x" } as any,
      }),
    ).toThrow(/reason/);
    expect(() =>
      _validatePolicyAuditEntry({
        ...baseEntry,
        // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
        override: { granted: true, reason: "ok", grantedBy: "" } as any,
      }),
    ).toThrow(/grantedBy/);
  });

  test("entries() returns a snapshot — later mutations to the log do not affect prior reads", () => {
    const log = _createPolicyAuditLogForTesting();
    log.record({ ...baseEntry, candidateId: "a" });
    const snap = log.entries();
    log.record({ ...baseEntry, candidateId: "b" });
    expect(snap).toHaveLength(1);
    expect(log.size()).toBe(2);
  });

  test("FIFO eviction once maxEntries is exceeded", () => {
    const log = _createPolicyAuditLogForTesting({ maxEntries: 2 });
    log.record({ ...baseEntry, candidateId: "a" });
    log.record({ ...baseEntry, candidateId: "b" });
    log.record({ ...baseEntry, candidateId: "c" });
    expect(log.size()).toBe(2);
    expect(log.entries().map((e) => e.candidateId)).toEqual(["b", "c"]);
  });

  test("recordedAt and sequence are bound by the log, not by callers", () => {
    const log = _createPolicyAuditLogForTesting();
    const before = Date.now();
    const a = log.record({ ...baseEntry, candidateId: "a", evaluatedAt: 1 });
    const b = log.record({ ...baseEntry, candidateId: "b", evaluatedAt: 2 });
    const after = Date.now();
    // Sequence numbers monotonically increment per log instance.
    expect(a.sequence).toBe(0);
    expect(b.sequence).toBe(1);
    // recordedAt is the logger's own clock, distinct from caller-supplied evaluatedAt.
    expect(a.recordedAt).toBeGreaterThanOrEqual(before);
    expect(a.recordedAt).toBeLessThanOrEqual(after);
    expect(a.evaluatedAt).toBe(1);
    // Caller-supplied evaluatedAt does not influence sequence ordering.
    expect(b.sequence).toBeGreaterThan(a.sequence);
  });

  test("onOverflow callback fires synchronously when an entry is evicted", () => {
    const dropped: Array<{ id: string; count: number }> = [];
    const log = _createPolicyAuditLogForTesting({
      maxEntries: 2,
      onOverflow: (entry, count) => {
        dropped.push({ id: entry.candidateId, count });
      },
    });
    log.record({ ...baseEntry, candidateId: "a" });
    log.record({ ...baseEntry, candidateId: "b" });
    expect(dropped).toEqual([]);
    log.record({ ...baseEntry, candidateId: "c" });
    expect(dropped).toEqual([{ id: "a", count: 1 }]);
    log.record({ ...baseEntry, candidateId: "d" });
    expect(dropped).toEqual([
      { id: "a", count: 1 },
      { id: "b", count: 2 },
    ]);
  });

  test("failClosedOnOverflowSinkError + throwing sink: throws and preserves both entries", () => {
    const log = _createPolicyAuditLogForTesting({
      maxEntries: 1,
      failClosedOnOverflowSinkError: true,
      onOverflow: () => {
        throw new Error("durable sink down");
      },
    });
    log.record({ ...baseEntry, candidateId: "a" });
    expect(() => log.record({ ...baseEntry, candidateId: "b" })).toThrow(/sink failed/);
    // The original entry must still be present — eviction is rolled
    // back when the sink fails in fail-closed mode.
    expect(log.size()).toBe(1);
    expect(log.entries()[0]?.candidateId).toBe("a");
    expect(log.droppedCount()).toBe(0);
  });

  test("failClosedOnOverflowSinkError + no sink: throws and preserves the original entry", () => {
    const log = _createPolicyAuditLogForTesting({
      maxEntries: 1,
      failClosedOnOverflowSinkError: true,
    });
    log.record({ ...baseEntry, candidateId: "a" });
    expect(() => log.record({ ...baseEntry, candidateId: "b" })).toThrow(/no onOverflow sink/);
    expect(log.size()).toBe(1);
    expect(log.entries()[0]?.candidateId).toBe("a");
    expect(log.droppedCount()).toBe(0);
  });

  test("a throwing onOverflow callback does not crash the policy gate", () => {
    const log = _createPolicyAuditLogForTesting({
      maxEntries: 1,
      onOverflow: () => {
        throw new Error("sink down");
      },
    });
    log.record({ ...baseEntry, candidateId: "a" });
    expect(() => log.record({ ...baseEntry, candidateId: "b" })).not.toThrow();
    expect(log.droppedCount()).toBe(1);
  });

  test("droppedCount reports FIFO evictions (overflow is observable, not silent)", () => {
    const log = _createPolicyAuditLogForTesting({ maxEntries: 2 });
    expect(log.droppedCount()).toBe(0);
    log.record({ ...baseEntry, candidateId: "a" });
    log.record({ ...baseEntry, candidateId: "b" });
    expect(log.droppedCount()).toBe(0);
    log.record({ ...baseEntry, candidateId: "c" });
    expect(log.droppedCount()).toBe(1);
    log.record({ ...baseEntry, candidateId: "d" });
    log.record({ ...baseEntry, candidateId: "e" });
    expect(log.droppedCount()).toBe(3);
    // entries() still returns the freshest survivors
    expect(log.entries().map((e) => e.candidateId)).toEqual(["d", "e"]);
  });

  test("rejects non-positive maxEntries", () => {
    expect(() => createPolicyAuditLog({ maxEntries: 0 })).toThrow(/maxEntries/);
    expect(() => createPolicyAuditLog({ maxEntries: -1 })).toThrow(/maxEntries/);
  });

  test("public PolicyAuditLog has no record() method (only recordEvaluation)", () => {
    const log = createPolicyAuditLog();
    expect((log as { record?: unknown }).record).toBeUndefined();
  });
});

describe("createPolicyAuditLog — cross-field invariants", () => {
  test("rejects entry where verdict differs from baseVerdict without granted override", () => {
    expect(() =>
      _validatePolicyAuditEntry({
        ...baseEntry,
        verdict: { decision: "allow" },
        baseVerdict: { decision: "deny", reason: "x" },
      }),
    ).toThrow(/verdict.*baseVerdict|baseVerdict.*verdict/);
  });

  test("rejects entry where verdict differs from baseVerdict with ungranted override", () => {
    expect(() =>
      _validatePolicyAuditEntry({
        ...baseEntry,
        verdict: { decision: "allow" },
        baseVerdict: { decision: "deny", reason: "x" },
        override: { granted: false, reason: "n/a", grantedBy: "op" },
      }),
    ).toThrow(/verdict.*baseVerdict|baseVerdict.*verdict/);
  });

  test("rejects overrideApplied:true whose verdict is not 'allow'", () => {
    expect(() =>
      _validatePolicyAuditEntry({
        ...baseEntry,
        verdict: { decision: "deny", reason: "x" },
        baseVerdict: { decision: "deny", reason: "x" },
        override: { granted: true, reason: "ok", grantedBy: "op" },
        overrideApplied: true,
      }),
    ).toThrow(/verdict.*allow|allow.*verdict/);
  });

  test("rejects overrideApplied:true whose baseVerdict is 'allow' (no relaxation possible)", () => {
    expect(() =>
      _validatePolicyAuditEntry({
        ...baseEntry,
        verdict: { decision: "allow" },
        baseVerdict: { decision: "allow" },
        override: { granted: true, reason: "noop", grantedBy: "op" },
        overrideApplied: true,
      }),
    ).toThrow(/baseVerdict.*allow|allow.*baseVerdict/);
  });

  test("accepts a well-formed overrideApplied:true entry (allow / non-allow base / granted)", () => {
    expect(() =>
      _validatePolicyAuditEntry({
        ...baseEntry,
        verdict: { decision: "allow" },
        baseVerdict: { decision: "deny", reason: "kind not allowed" },
        override: { granted: true, reason: "ops #42", grantedBy: "alice" },
        overrideApplied: true,
      }),
    ).not.toThrow();
  });

  test("rejects granted override + overrideApplied:false paired with a non-allow verdict (impossible state)", () => {
    expect(() =>
      _validatePolicyAuditEntry({
        ...baseEntry,
        verdict: { decision: "deny", reason: "scope" },
        baseVerdict: { decision: "deny", reason: "scope" },
        override: { granted: true, reason: "x", grantedBy: "op" },
        overrideApplied: false,
      }),
    ).toThrow(/granted override.*overrideApplied:false.*verdict 'allow'/);
  });

  test("accepts a no-op granted override (overrideApplied:false) with override metadata preserved", () => {
    const entry = {
      ...baseEntry,
      verdict: { decision: "allow" } as const,
      baseVerdict: { decision: "allow" } as const,
      override: { granted: true, reason: "noop", grantedBy: "op" },
      overrideApplied: false,
    };
    expect(() => _validatePolicyAuditEntry(entry)).not.toThrow();
    // Round-trip through the test factory to check the entry is preserved
    // verbatim with override metadata intact.
    const log = _createPolicyAuditLogForTesting();
    log.record(entry);
    expect(log.entries()[0]?.override?.grantedBy).toBe("op");
    expect(log.entries()[0]?.overrideApplied).toBe(false);
  });

  test("accepts matching deny verdicts when no override is present", () => {
    expect(() =>
      _validatePolicyAuditEntry({
        ...baseEntry,
        verdict: { decision: "deny", reason: "scope too high" },
        baseVerdict: { decision: "deny", reason: "scope too high" },
      }),
    ).not.toThrow();
  });
});

describe("createPolicyAuditLog — recordEvaluation", () => {
  test("persists configFingerprint from evaluation (bound at decision time)", () => {
    const log = createPolicyAuditLog();
    const config = makeConfig({ allowedKinds: ["tool"] });
    const evaluation = evaluatePolicy(makeCandidate(), config);
    const entry = log.recordEvaluation({
      evaluation,
      evaluatedAt: 1_700_000_000_000,
    });
    expect(entry.configFingerprint).toBe(computeConfigFingerprint(config));
    expect(log.size()).toBe(1);
  });

  test("audit candidateId is bound to the evaluated candidate (no replay across ids)", () => {
    const log = createPolicyAuditLog();
    const config = makeConfig({ allowedKinds: ["tool"] });
    const evaluation = evaluatePolicy(makeCandidate({ id: "cand-real" }), config);
    const entry = log.recordEvaluation({
      evaluation,
      evaluatedAt: 1_700_000_000_000,
    });
    // No caller-supplied candidateId is even possible — the audit
    // entry's candidateId comes from the evaluation, so an authentic
    // evaluation cannot be replayed under a different id.
    expect(entry.candidateId).toBe("cand-real");
  });

  test("post-evaluation config mutation cannot rewrite the recorded fingerprint", () => {
    const log = createPolicyAuditLog();
    const config = makeConfig({ allowedKinds: ["tool"] });
    const fingerprintAtEval = computeConfigFingerprint(config);
    const evaluation = evaluatePolicy(makeCandidate(), config);
    // Caller mutates the live config object after evaluation.
    (config as { -readonly [K in keyof typeof config]: (typeof config)[K] }).allowedKinds = [
      "channel",
    ];
    const entry = log.recordEvaluation({
      evaluation,
      evaluatedAt: 1_700_000_000_000,
    });
    expect(entry.configFingerprint).toBe(fingerprintAtEval);
  });

  test("captures verdict, baseVerdict, AND override from the evaluation", () => {
    const log = createPolicyAuditLog();
    const config = makeConfig({ allowedKinds: ["tool"] });
    const evaluation = evaluatePolicy(makeCandidate({ kind: "channel" }), config, {
      override: { granted: true, reason: "ops #1", grantedBy: "alice" },
    });
    const entry = log.recordEvaluation({
      evaluation,
      evaluatedAt: 1_700_000_000_001,
    });
    expect(entry.verdict.decision).toBe("allow");
    expect(entry.baseVerdict.decision).toBe("deny");
    expect(entry.override?.grantedBy).toBe("alice");
    expect(entry.override?.reason).toBe("ops #1");
  });

  test("preserves no-op granted override metadata (overrideApplied:false) for observability", () => {
    const log = createPolicyAuditLog();
    const config = makeConfig();
    const evaluation = evaluatePolicy(makeCandidate(), config, {
      override: { granted: true, reason: "noop", grantedBy: "ops" },
    });
    expect(evaluation.overrideApplied).toBe(false);
    const entry = log.recordEvaluation({
      evaluation,
      evaluatedAt: 1_700_000_000_002,
    });
    expect(entry.overrideApplied).toBe(false);
    expect(entry.override?.grantedBy).toBe("ops");
    expect(log.size()).toBe(1);
  });

  test("malformed-override fail-closed evaluations are recordable with the real config fingerprint", () => {
    const log = createPolicyAuditLog();
    type Override = NonNullable<Parameters<typeof evaluatePolicy>[2]>["override"];
    const config = makeConfig();
    const evaluation = evaluatePolicy(makeCandidate(), config, {
      override: { granted: true, reason: "", grantedBy: "alice" } as unknown as Override,
    });
    expect(evaluation.failureKind).toBe("override");
    // configFingerprint must remain the real policy identity — audit
    // consumers can still join this entry back to the policy version
    // that evaluated it.
    expect(evaluation.configFingerprint).toBe(computeConfigFingerprint(config));
    expect(() =>
      log.recordEvaluation({ evaluation, evaluatedAt: 1_700_000_000_000 }),
    ).not.toThrow();
    expect(log.size()).toBe(1);
    // The malformed override is dropped from the entry; the failure
    // attribution (grantedBy='alice') is still in the reason text and
    // the failureKind/failureReason fields are preserved.
    const entry = log.entries()[0];
    expect(entry?.override).toBeUndefined();
    expect(entry?.failureKind).toBe("override");
    expect(entry?.failureReason).toMatch(/grantedBy='alice'/);
    expect(entry?.configFingerprint).toBe(computeConfigFingerprint(config));
    if (entry?.verdict.decision === "deny") {
      expect(entry.verdict.reason).toMatch(/grantedBy='alice'/);
    }
  });

  test("rejects a fabricated PolicyEvaluation literal (must come from evaluatePolicy)", () => {
    const log = createPolicyAuditLog();
    const fabricated = {
      verdict: { decision: "allow" } as const,
      baseVerdict: { decision: "deny", reason: "x" } as const,
      overrideApplied: true,
      override: { granted: true, reason: "forged", grantedBy: "mallory" },
      configFingerprint: "f".repeat(64),
      candidateId: "forged-id",
    };
    expect(() =>
      log.recordEvaluation({
        evaluation: fabricated,
        evaluatedAt: 1_700_000_000_000,
      }),
    ).toThrow(/fabricated evaluation rejected/);
  });

  test("returned PolicyEvaluation is deep-frozen (verdict, baseVerdict, override)", () => {
    const config = makeConfig({ allowedKinds: ["tool"] });
    const evaluation = evaluatePolicy(makeCandidate({ kind: "channel" }), config, {
      override: { granted: true, reason: "ops #1", grantedBy: "alice" },
    });
    expect(Object.isFrozen(evaluation)).toBe(true);
    expect(Object.isFrozen(evaluation.verdict)).toBe(true);
    expect(Object.isFrozen(evaluation.baseVerdict)).toBe(true);
    expect(Object.isFrozen(evaluation.override)).toBe(true);
  });
});
