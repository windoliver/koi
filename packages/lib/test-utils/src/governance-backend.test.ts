import { describe, expect, test } from "bun:test";
import type {
  ComplianceRecord,
  GovernanceVerdict,
  PolicyRequest,
  ViolationFilter,
} from "@koi/core";
import { agentId, GOVERNANCE_ALLOW } from "@koi/core";
import { createMockGovernanceBackend } from "./governance.js";

describe("createMockGovernanceBackend", () => {
  test("default evaluator returns GOVERNANCE_ALLOW", () => {
    const backend = createMockGovernanceBackend();
    const request: PolicyRequest = {
      kind: "tool_call",
      agentId: agentId("agent-a"),
      payload: { toolName: "read_file" },
      timestamp: 1_000_000,
    };
    expect(backend.evaluator.evaluate(request)).toBe(GOVERNANCE_ALLOW);
  });

  test("default evaluator has no scope", () => {
    const backend = createMockGovernanceBackend();
    expect(backend.evaluator.scope).toBeUndefined();
  });

  test("default has no optional sub-interfaces or dispose", () => {
    const backend = createMockGovernanceBackend();
    expect(backend.constraints).toBeUndefined();
    expect(backend.compliance).toBeUndefined();
    expect(backend.violations).toBeUndefined();
    expect(backend.dispose).toBeUndefined();
  });

  test("override evaluator to return deny verdict", async () => {
    const denyVerdict: GovernanceVerdict = {
      ok: false,
      violations: [{ rule: "no-spawn", severity: "critical", message: "spawning denied" }],
    };
    const backend = createMockGovernanceBackend({
      evaluator: { evaluate: () => denyVerdict },
    });
    const request: PolicyRequest = {
      kind: "spawn",
      agentId: agentId("agent-a"),
      payload: {},
      timestamp: 1_000_000,
    };
    const result = await backend.evaluator.evaluate(request);
    expect(result).toBe(denyVerdict);
    if (!result.ok) {
      expect(result.violations).toHaveLength(1);
    }
  });

  test("override evaluator scope", () => {
    const backend = createMockGovernanceBackend({
      evaluator: { scope: ["tool_call", "spawn"] },
    });
    expect(backend.evaluator.scope).toEqual(["tool_call", "spawn"]);
    // evaluate still defaults to GOVERNANCE_ALLOW when not overridden
    const request: PolicyRequest = {
      kind: "tool_call",
      agentId: agentId("agent-a"),
      payload: {},
      timestamp: 1_000_000,
    };
    expect(backend.evaluator.evaluate(request)).toBe(GOVERNANCE_ALLOW);
  });

  test("default constraint checker returns true", () => {
    const backend = createMockGovernanceBackend({
      constraints: {},
    });
    expect(backend.constraints).toBeDefined();
    const result = backend.constraints?.checkConstraint({
      kind: "spawn_depth",
      agentId: agentId("agent-a"),
      value: 3,
    });
    expect(result).toBe(true);
  });

  test("override constraint checker", () => {
    const backend = createMockGovernanceBackend({
      constraints: { checkConstraint: () => false },
    });
    const result = backend.constraints?.checkConstraint({
      kind: "token_budget",
      agentId: agentId("agent-a"),
    });
    expect(result).toBe(false);
  });

  test("default compliance recorder returns input record", () => {
    const backend = createMockGovernanceBackend({
      compliance: {},
    });
    expect(backend.compliance).toBeDefined();
    const record: ComplianceRecord = {
      requestId: "req-001",
      request: {
        kind: "tool_call",
        agentId: agentId("agent-a"),
        payload: {},
        timestamp: 1_000_000,
      },
      verdict: GOVERNANCE_ALLOW,
      evaluatedAt: 1_000_001,
      policyFingerprint: "sha256:abc",
    };
    expect(backend.compliance?.recordCompliance(record)).toBe(record);
  });

  test("default violation store returns empty page", () => {
    const backend = createMockGovernanceBackend({
      violations: {},
    });
    expect(backend.violations).toBeDefined();
    const filter: ViolationFilter = {};
    const page = backend.violations?.getViolations(filter);
    expect(page).toEqual({ items: [], total: 0 });
  });

  test("override with partial sub-interfaces — only evaluator", () => {
    const backend = createMockGovernanceBackend({
      evaluator: { evaluate: () => GOVERNANCE_ALLOW },
    });
    expect(backend.evaluator).toBeDefined();
    expect(backend.constraints).toBeUndefined();
    expect(backend.compliance).toBeUndefined();
    expect(backend.violations).toBeUndefined();
  });

  test("dispose override is attached", () => {
    // let justified: mutable counter for testing dispose calls
    let disposed = false;
    const backend = createMockGovernanceBackend({
      dispose: () => {
        disposed = true;
      },
    });
    expect(backend.dispose).toBeDefined();
    backend.dispose?.();
    expect(disposed).toBe(true);
  });

  test("all sub-interfaces present simultaneously", () => {
    const backend = createMockGovernanceBackend({
      evaluator: { scope: ["tool_call"] },
      constraints: {},
      compliance: {},
      violations: {},
      dispose: () => {},
    });
    expect(backend.evaluator).toBeDefined();
    expect(backend.evaluator.scope).toEqual(["tool_call"]);
    expect(backend.constraints).toBeDefined();
    expect(backend.compliance).toBeDefined();
    expect(backend.violations).toBeDefined();
    expect(backend.dispose).toBeDefined();
  });
});
