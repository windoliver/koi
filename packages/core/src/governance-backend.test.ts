/**
 * governance-backend.test.ts
 *
 * Structural and invariant tests for @koi/core governance backend types.
 * Tests runtime values (branded constructors, constants) and structural
 * shapes that api-surface snapshot tests cannot catch (wrong constant values,
 * silent severity additions/removals).
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_VIOLATION_QUERY_LIMIT,
  type GovernanceAttestation,
  type GovernanceAttestationInput,
  type GovernanceBackend,
  type GovernanceBackendEvent,
  type GovernanceVerdict,
  governanceAttestationId,
  VIOLATION_SEVERITIES,
  type Violation,
  type ViolationQuery,
  type ViolationSeverity,
} from "./governance-backend.js";

// ---------------------------------------------------------------------------
// governanceAttestationId — branded constructor
// ---------------------------------------------------------------------------

describe("governanceAttestationId", () => {
  test("is an identity cast — returns the input string unchanged", () => {
    const id = governanceAttestationId("attest-abc-123");
    expect(id).toBe(governanceAttestationId("attest-abc-123"));
  });

  test("produces distinct values for distinct inputs", () => {
    const a = governanceAttestationId("a");
    const b = governanceAttestationId("b");
    expect(a).not.toBe(b);
  });

  test("round-trips through string comparison", () => {
    const raw = "governance-attest-xyz";
    const id = governanceAttestationId(raw);
    expect(String(id)).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_VIOLATION_QUERY_LIMIT — default page size constant
// ---------------------------------------------------------------------------

describe("DEFAULT_VIOLATION_QUERY_LIMIT", () => {
  test("is 100", () => {
    expect(DEFAULT_VIOLATION_QUERY_LIMIT).toBe(100);
  });

  test("is a positive integer", () => {
    expect(Number.isInteger(DEFAULT_VIOLATION_QUERY_LIMIT)).toBe(true);
    expect(DEFAULT_VIOLATION_QUERY_LIMIT).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// VIOLATION_SEVERITIES — exhaustiveness + ordering + immutability
// ---------------------------------------------------------------------------

describe("VIOLATION_SEVERITIES", () => {
  test("contains exactly the three defined severity levels", () => {
    expect(VIOLATION_SEVERITIES).toEqual(["info", "warning", "critical"]);
  });

  test("is ordered from lowest to highest impact", () => {
    const infoIdx = VIOLATION_SEVERITIES.indexOf("info");
    const warningIdx = VIOLATION_SEVERITIES.indexOf("warning");
    const criticalIdx = VIOLATION_SEVERITIES.indexOf("critical");

    expect(infoIdx).toBeGreaterThanOrEqual(0);
    expect(warningIdx).toBeGreaterThan(infoIdx);
    expect(criticalIdx).toBeGreaterThan(warningIdx);
  });

  test("indexOf enables severity comparison", () => {
    const atLeastWarning = (s: ViolationSeverity): boolean =>
      VIOLATION_SEVERITIES.indexOf(s) >= VIOLATION_SEVERITIES.indexOf("warning");

    expect(atLeastWarning("info")).toBe(false);
    expect(atLeastWarning("warning")).toBe(true);
    expect(atLeastWarning("critical")).toBe(true);
  });

  test("is frozen (immutable at runtime)", () => {
    expect(Object.isFrozen(VIOLATION_SEVERITIES)).toBe(true);
  });

  test("every entry is a non-empty string", () => {
    for (const s of VIOLATION_SEVERITIES) {
      expect(typeof s).toBe("string");
      expect(s.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// GovernanceVerdict — discriminated union structural shape
// ---------------------------------------------------------------------------

describe("GovernanceVerdict structural shape", () => {
  test("ok:true verdict has no violations field", () => {
    const verdict: GovernanceVerdict = { ok: true };
    expect(verdict.ok).toBe(true);
    expect("violations" in verdict).toBe(false);
  });

  test("ok:false verdict carries a readonly violations array", () => {
    const violation: Violation = {
      rule: "max-spawn-depth",
      severity: "critical",
      message: "Spawn depth 10 exceeds the limit of 5",
    };
    const verdict: GovernanceVerdict = { ok: false, violations: [violation] };

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations).toHaveLength(1);
      expect(verdict.violations[0]?.rule).toBe("max-spawn-depth");
      expect(verdict.violations[0]?.severity).toBe("critical");
      expect(verdict.violations[0]?.message).toContain("5");
    }
  });

  test("ok:false verdict may carry multiple violations (all rules reported)", () => {
    const violations: Violation[] = [
      { rule: "max-spawn-depth", severity: "critical", message: "depth exceeded" },
      { rule: "max-token-usage", severity: "warning", message: "token budget low" },
    ];
    const verdict: GovernanceVerdict = { ok: false, violations };

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations).toHaveLength(2);
    }
  });

  test("ok:false verdict with optional context field on violation", () => {
    const violation: Violation = {
      rule: "cost-limit",
      severity: "warning",
      message: "Cost $0.95 approaching limit $1.00",
      context: { currentUsd: 0.95, limitUsd: 1.0 },
    };
    const verdict: GovernanceVerdict = { ok: false, violations: [violation] };

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations[0]?.context).toEqual({ currentUsd: 0.95, limitUsd: 1.0 });
    }
  });
});

// ---------------------------------------------------------------------------
// GovernanceBackendEvent — structural shape
// ---------------------------------------------------------------------------

describe("GovernanceBackendEvent structural shape", () => {
  test("accepts well-known kinds", () => {
    const kinds = ["tool_call", "spawn", "forge", "promotion", "proposal"];
    for (const kind of kinds) {
      const event: GovernanceBackendEvent = {
        kind,
        agentId: "agent-1" as ReturnType<typeof governanceAttestationId> extends never
          ? never
          : // biome-ignore lint/suspicious/noExplicitAny: cast for test only
            any,
        payload: {},
        timestamp: Date.now(),
      };
      expect(event.kind).toBe(kind);
    }
  });

  test("accepts arbitrary custom kind (open string union)", () => {
    const event: GovernanceBackendEvent = {
      kind: "custom:my-domain-event",
      // biome-ignore lint/suspicious/noExplicitAny: cast for test only
      agentId: "agent-x" as any,
      payload: { foo: "bar" },
      timestamp: 1_700_000_000_000,
    };
    expect(event.kind).toBe("custom:my-domain-event");
    expect(event.payload).toEqual({ foo: "bar" });
  });
});

// ---------------------------------------------------------------------------
// GovernanceAttestationInput / GovernanceAttestation — relationship
// ---------------------------------------------------------------------------

describe("GovernanceAttestation enrichment contract", () => {
  test("GovernanceAttestation extends GovernanceAttestationInput with backend-assigned fields", () => {
    const input: GovernanceAttestationInput = {
      // biome-ignore lint/suspicious/noExplicitAny: cast for test only
      agentId: "agent-1" as any,
      ruleId: "no-exfiltration",
      verdict: { ok: true },
    };

    // Simulate what a backend would return after storing
    const stored: GovernanceAttestation = {
      id: governanceAttestationId("attest-001"),
      agentId: input.agentId,
      ruleId: input.ruleId,
      verdict: input.verdict,
      attestedAt: 1_700_000_000_000,
      attestedBy: "local",
    };

    expect(stored.id).toBe(governanceAttestationId("attest-001"));
    expect(stored.agentId).toBe(input.agentId);
    expect(stored.ruleId).toBe(input.ruleId);
    expect(stored.verdict.ok).toBe(true);
    expect(stored.attestedAt).toBeGreaterThan(0);
    expect(stored.attestedBy).toBe("local");
    // evidence is optional and absent when not provided
    expect("evidence" in stored).toBe(false);
  });

  test("GovernanceAttestation with optional evidence field", () => {
    const stored: GovernanceAttestation = {
      id: governanceAttestationId("attest-002"),
      // biome-ignore lint/suspicious/noExplicitAny: cast for test only
      agentId: "agent-2" as any,
      ruleId: "cost-limit",
      verdict: {
        ok: false,
        violations: [{ rule: "cost-limit", severity: "warning", message: "high cost" }],
      },
      evidence: { costUsd: 0.95, sessionId: "sess-xyz" },
      attestedAt: 1_700_000_001_000,
      attestedBy: "nexus",
    };

    expect(stored.evidence).toEqual({ costUsd: 0.95, sessionId: "sess-xyz" });
    expect(stored.attestedBy).toBe("nexus");
  });
});

// ---------------------------------------------------------------------------
// ViolationQuery — default limit constant usage
// ---------------------------------------------------------------------------

describe("ViolationQuery with DEFAULT_VIOLATION_QUERY_LIMIT", () => {
  test("empty query uses default limit", () => {
    const query: ViolationQuery = {};
    // When limit is omitted, backends apply DEFAULT_VIOLATION_QUERY_LIMIT
    const effectiveLimit = query.limit ?? DEFAULT_VIOLATION_QUERY_LIMIT;
    expect(effectiveLimit).toBe(100);
  });

  test("explicit limit overrides default", () => {
    const query: ViolationQuery = { limit: 10 };
    const effectiveLimit = query.limit ?? DEFAULT_VIOLATION_QUERY_LIMIT;
    expect(effectiveLimit).toBe(10);
  });

  test("severity filter accepts subset of VIOLATION_SEVERITIES", () => {
    const query: ViolationQuery = { severity: ["warning", "critical"] };
    expect(query.severity).toEqual(["warning", "critical"]);
  });
});

// ---------------------------------------------------------------------------
// GovernanceBackend interface shape (compile-time contract smoke test)
// ---------------------------------------------------------------------------

describe("GovernanceBackend interface contract", () => {
  test("a minimal in-memory implementation satisfies the interface", () => {
    // Structural check: verify a minimal object assignable to GovernanceBackend compiles
    const backend: GovernanceBackend = {
      evaluate: (_event) => ({ ok: true }),
      checkConstraint: (_query) => true,
      recordAttestation: (_input) => ({
        ok: true,
        value: {
          id: governanceAttestationId("test-id"),
          // biome-ignore lint/suspicious/noExplicitAny: cast for test only
          agentId: "agent-test" as any,
          ruleId: "test-rule",
          verdict: { ok: true },
          attestedAt: Date.now(),
          attestedBy: "test-backend",
        },
      }),
      getViolations: (_filter) => ({ ok: true, value: [] }),
    };

    expect(typeof backend.evaluate).toBe("function");
    expect(typeof backend.checkConstraint).toBe("function");
    expect(typeof backend.recordAttestation).toBe("function");
    expect(typeof backend.getViolations).toBe("function");
    expect(backend.dispose).toBeUndefined();
  });

  test("dispose is optional on GovernanceBackend", () => {
    const withDispose: GovernanceBackend = {
      evaluate: (_event) => ({ ok: true }),
      checkConstraint: (_query) => true,
      recordAttestation: (_input) => ({ ok: true, value: {} as GovernanceAttestation }),
      getViolations: (_filter) => ({ ok: true, value: [] }),
      dispose: () => {},
    };

    expect(typeof withDispose.dispose).toBe("function");
  });
});
