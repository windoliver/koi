import { describe, expect, test } from "bun:test";
import { createPolicyAuditLog } from "./audit.js";

const baseEntry = {
  candidateId: "cand-1",
  verdict: { decision: "allow" } as const,
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
    });
    log.record({
      ...baseEntry,
      candidateId: "c",
      verdict: { decision: "require-approval", reason: "y" },
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
      override: { granted: true, reason: "ops #42", grantedBy: "alice" },
    });
    const first = log.entries()[0];
    expect(first?.override?.granted).toBe(true);
    expect(first?.override?.reason).toBe("ops #42");
    expect(first?.override?.grantedBy).toBe("alice");
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
