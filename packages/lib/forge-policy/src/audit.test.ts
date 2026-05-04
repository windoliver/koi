import { describe, expect, test } from "bun:test";
import { createPolicyAuditLog } from "./audit.js";

const baseEntry = {
  candidateId: "cand-1",
  verdict: { decision: "allow" } as const,
  baseVerdict: { decision: "allow" } as const,
  evaluatedAt: 1_700_000_000_000,
  configFingerprint: "fp-abc",
} as const;

describe("createPolicyAuditLog", () => {
  test("records all decisions in insertion order", () => {
    const log = createPolicyAuditLog();
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
    const log = createPolicyAuditLog();
    log.record({ ...baseEntry });
    const entries = log.entries();
    const first = entries[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.verdict)).toBe(true);
  });

  test("override is preserved on the entry when present", () => {
    const log = createPolicyAuditLog();
    log.record({
      ...baseEntry,
      verdict: { decision: "allow" },
      baseVerdict: { decision: "deny", reason: "scope too high" },
      override: { granted: true, reason: "ops #42", grantedBy: "alice" },
    });
    const first = log.entries()[0];
    expect(first?.override?.granted).toBe(true);
    expect(first?.override?.reason).toBe("ops #42");
    expect(first?.override?.grantedBy).toBe("alice");
  });

  test("baseVerdict is recorded so an override audit retains the bypassed reason", () => {
    const log = createPolicyAuditLog();
    log.record({
      ...baseEntry,
      verdict: { decision: "allow" },
      baseVerdict: { decision: "deny", reason: "kind 'channel' is not in allowedKinds" },
      override: { granted: true, reason: "ops #42", grantedBy: "alice" },
    });
    const first = log.entries()[0];
    expect(first?.baseVerdict.decision).toBe("deny");
    if (first?.baseVerdict.decision === "deny") {
      expect(first.baseVerdict.reason).toMatch(/channel/);
    }
    expect(first?.verdict.decision).toBe("allow");
  });

  test("rejects entries missing required fields (fail closed)", () => {
    const log = createPolicyAuditLog();
    expect(() =>
      log.record({
        ...baseEntry,
        // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
        candidateId: "" as any,
      }),
    ).toThrow(/candidateId/);
    expect(() =>
      log.record({
        ...baseEntry,
        // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
        configFingerprint: "" as any,
      }),
    ).toThrow(/configFingerprint/);
    expect(log.size()).toBe(0);
  });

  test("rejects override entries missing reason or grantedBy", () => {
    const log = createPolicyAuditLog();
    expect(() =>
      log.record({
        ...baseEntry,
        // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
        override: { granted: true, reason: "", grantedBy: "x" } as any,
      }),
    ).toThrow(/reason/);
    expect(() =>
      log.record({
        ...baseEntry,
        // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
        override: { granted: true, reason: "ok", grantedBy: "" } as any,
      }),
    ).toThrow(/grantedBy/);
  });

  test("entries() returns a snapshot — later mutations to the log do not affect prior reads", () => {
    const log = createPolicyAuditLog();
    log.record({ ...baseEntry, candidateId: "a" });
    const snap = log.entries();
    log.record({ ...baseEntry, candidateId: "b" });
    expect(snap).toHaveLength(1);
    expect(log.size()).toBe(2);
  });

  test("FIFO eviction once maxEntries is exceeded", () => {
    const log = createPolicyAuditLog({ maxEntries: 2 });
    log.record({ ...baseEntry, candidateId: "a" });
    log.record({ ...baseEntry, candidateId: "b" });
    log.record({ ...baseEntry, candidateId: "c" });
    expect(log.size()).toBe(2);
    expect(log.entries().map((e) => e.candidateId)).toEqual(["b", "c"]);
  });

  test("rejects non-positive maxEntries", () => {
    expect(() => createPolicyAuditLog({ maxEntries: 0 })).toThrow(/maxEntries/);
    expect(() => createPolicyAuditLog({ maxEntries: -1 })).toThrow(/maxEntries/);
  });
});

describe("createPolicyAuditLog — cross-field invariants", () => {
  test("rejects entry where verdict differs from baseVerdict without granted override", () => {
    const log = createPolicyAuditLog();
    expect(() =>
      log.record({
        ...baseEntry,
        verdict: { decision: "allow" },
        baseVerdict: { decision: "deny", reason: "x" },
      }),
    ).toThrow(/verdict.*baseVerdict|baseVerdict.*verdict/);
  });

  test("rejects entry where verdict differs from baseVerdict with ungranted override", () => {
    const log = createPolicyAuditLog();
    expect(() =>
      log.record({
        ...baseEntry,
        verdict: { decision: "allow" },
        baseVerdict: { decision: "deny", reason: "x" },
        override: { granted: false, reason: "n/a", grantedBy: "op" },
      }),
    ).toThrow(/verdict.*baseVerdict|baseVerdict.*verdict/);
  });

  test("rejects granted override whose verdict is not 'allow'", () => {
    const log = createPolicyAuditLog();
    expect(() =>
      log.record({
        ...baseEntry,
        verdict: { decision: "deny", reason: "x" },
        baseVerdict: { decision: "deny", reason: "x" },
        override: { granted: true, reason: "ok", grantedBy: "op" },
      }),
    ).toThrow(/verdict.*allow|allow.*verdict/);
  });

  test("rejects granted override whose baseVerdict is 'allow' (override would be a no-op)", () => {
    const log = createPolicyAuditLog();
    expect(() =>
      log.record({
        ...baseEntry,
        verdict: { decision: "allow" },
        baseVerdict: { decision: "allow" },
        override: { granted: true, reason: "noop", grantedBy: "op" },
      }),
    ).toThrow(/baseVerdict.*allow|allow.*baseVerdict/);
  });

  test("accepts a well-formed override entry (allow / non-allow base / granted)", () => {
    const log = createPolicyAuditLog();
    expect(() =>
      log.record({
        ...baseEntry,
        verdict: { decision: "allow" },
        baseVerdict: { decision: "deny", reason: "kind not allowed" },
        override: { granted: true, reason: "ops #42", grantedBy: "alice" },
      }),
    ).not.toThrow();
    expect(log.size()).toBe(1);
  });

  test("accepts matching deny verdicts when no override is present", () => {
    const log = createPolicyAuditLog();
    expect(() =>
      log.record({
        ...baseEntry,
        verdict: { decision: "deny", reason: "scope too high" },
        baseVerdict: { decision: "deny", reason: "scope too high" },
      }),
    ).not.toThrow();
  });
});
