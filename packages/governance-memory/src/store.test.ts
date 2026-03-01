/**
 * Tests for the in-memory governance store — compliance, violations, constraints.
 */

import { describe, expect, test } from "bun:test";
import { agentId } from "@koi/core/ecs";
import type {
  ComplianceRecord,
  GovernanceVerdict,
  PolicyRequest,
} from "@koi/core/governance-backend";
import { GOVERNANCE_ALLOW } from "@koi/core/governance-backend";
import { createMemoryEvaluator } from "./evaluator.js";
import { createGovernanceMemoryStore } from "./store.js";
import type { GovernanceRule } from "./types.js";

function makeRule(overrides: Partial<GovernanceRule> & { readonly id: string }): GovernanceRule {
  return {
    effect: "permit",
    priority: 0,
    condition: () => true,
    message: `Rule ${overrides.id}`,
    ...overrides,
  };
}

function makeRequest(): PolicyRequest {
  return {
    kind: "tool_call",
    agentId: agentId("agent-1"),
    payload: {},
    timestamp: Date.now(),
  };
}

function makeComplianceRecord(requestId: string = "req-1"): ComplianceRecord {
  return {
    requestId,
    request: makeRequest(),
    verdict: GOVERNANCE_ALLOW,
    evaluatedAt: Date.now(),
    policyFingerprint: "v1",
  };
}

describe("GovernanceMemoryStore", () => {
  function createStore(rules: readonly GovernanceRule[] = [makeRule({ id: "allow" })]) {
    const evaluator = createMemoryEvaluator({ rules });
    return createGovernanceMemoryStore(evaluator);
  }

  describe("compliance", () => {
    test("recordCompliance stores and returns record", async () => {
      const store = createStore();
      const record = makeComplianceRecord("req-1");
      const result = await store.compliance.recordCompliance(record);
      expect(result).toBe(record);
    });
  });

  describe("violations", () => {
    test("empty store returns empty page", async () => {
      const store = createStore();
      const page = await store.violations.getViolations({});
      expect(page.items).toHaveLength(0);
      expect(page.total).toBe(0);
    });

    test("records violations from deny verdict", async () => {
      const store = createStore();
      const agent = agentId("agent-1");
      const verdict: GovernanceVerdict = {
        ok: false,
        violations: [{ rule: "r1", severity: "critical", message: "Denied" }],
      };

      store.recordViolationsFromVerdict(agent, verdict, Date.now());
      const page = await store.violations.getViolations({ agentId: agent });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.rule).toBe("r1");
    });

    test("per-agent isolation", async () => {
      const store = createStore();
      const a1 = agentId("agent-1");
      const a2 = agentId("agent-2");
      const verdict: GovernanceVerdict = {
        ok: false,
        violations: [{ rule: "r1", severity: "critical", message: "Denied" }],
      };

      store.recordViolationsFromVerdict(a1, verdict, Date.now());
      store.recordViolationsFromVerdict(a2, verdict, Date.now());

      const page1 = await store.violations.getViolations({ agentId: a1 });
      const page2 = await store.violations.getViolations({ agentId: a2 });
      expect(page1.items).toHaveLength(1);
      expect(page2.items).toHaveLength(1);
    });

    test("filter by severity", async () => {
      const store = createStore();
      const agent = agentId("agent-1");
      const verdict: GovernanceVerdict = {
        ok: false,
        violations: [
          { rule: "r1", severity: "info", message: "Info" },
          { rule: "r2", severity: "warning", message: "Warning" },
          { rule: "r3", severity: "critical", message: "Critical" },
        ],
      };

      store.recordViolationsFromVerdict(agent, verdict, Date.now());

      const warningAndAbove = await store.violations.getViolations({
        agentId: agent,
        severity: "warning",
      });
      expect(warningAndAbove.items).toHaveLength(2);

      const criticalOnly = await store.violations.getViolations({
        agentId: agent,
        severity: "critical",
      });
      expect(criticalOnly.items).toHaveLength(1);
    });

    test("filter by rule", async () => {
      const store = createStore();
      const agent = agentId("agent-1");
      const verdict: GovernanceVerdict = {
        ok: false,
        violations: [
          { rule: "r1", severity: "critical", message: "R1" },
          { rule: "r2", severity: "critical", message: "R2" },
        ],
      };

      store.recordViolationsFromVerdict(agent, verdict, Date.now());
      const page = await store.violations.getViolations({ agentId: agent, rule: "r1" });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.rule).toBe("r1");
    });

    test("filter by time range", async () => {
      const store = createStore();
      const agent = agentId("agent-1");
      const now = Date.now();

      store.recordViolationsFromVerdict(
        agent,
        {
          ok: false,
          violations: [{ rule: "r-old", severity: "info", message: "Old" }],
        },
        now - 10000,
      );

      store.recordViolationsFromVerdict(
        agent,
        {
          ok: false,
          violations: [{ rule: "r-new", severity: "info", message: "New" }],
        },
        now,
      );

      const recent = await store.violations.getViolations({
        agentId: agent,
        since: now - 5000,
      });
      expect(recent.items).toHaveLength(1);
      expect(recent.items[0]?.rule).toBe("r-new");
    });

    test("does not record violations from allow verdict", async () => {
      const store = createStore();
      const agent = agentId("agent-1");
      store.recordViolationsFromVerdict(agent, GOVERNANCE_ALLOW, Date.now());
      const page = await store.violations.getViolations({ agentId: agent });
      expect(page.items).toHaveLength(0);
    });

    test("pagination with limit and offset", async () => {
      const store = createStore();
      const agent = agentId("agent-1");
      const violations = Array.from({ length: 5 }, (_, i) => ({
        rule: `r${i}`,
        severity: "critical" as const,
        message: `Violation ${i}`,
      }));

      store.recordViolationsFromVerdict(
        agent,
        {
          ok: false,
          violations,
        },
        Date.now(),
      );

      const page1 = await store.violations.getViolations({ agentId: agent, limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.cursor).toBe("2");

      const page2 = await store.violations.getViolations({
        agentId: agent,
        limit: 2,
        offset: page1.cursor,
      });
      expect(page2.items).toHaveLength(2);
    });
  });

  describe("constraints", () => {
    test("checkConstraint returns true for allowed", async () => {
      const evaluator = createMemoryEvaluator({
        rules: [makeRule({ id: "allow-all", effect: "permit" })],
      });
      const store = createGovernanceMemoryStore(evaluator);
      const result = await store.constraints.checkConstraint({
        kind: "spawn_depth",
        agentId: agentId("agent-1"),
        value: 3,
      });
      expect(result).toBe(true);
    });

    test("checkConstraint returns false for denied", async () => {
      const evaluator = createMemoryEvaluator({
        rules: [
          makeRule({ id: "deny-all", effect: "forbid", priority: 0 }),
          makeRule({ id: "allow", effect: "permit", priority: 1 }),
        ],
      });
      const store = createGovernanceMemoryStore(evaluator);
      const result = await store.constraints.checkConstraint({
        kind: "token_budget",
        agentId: agentId("agent-1"),
      });
      expect(result).toBe(false);
    });
  });

  describe("clear", () => {
    test("clear removes all stored data", async () => {
      const store = createStore();
      const agent = agentId("agent-1");

      await store.compliance.recordCompliance(makeComplianceRecord());
      store.recordViolationsFromVerdict(
        agent,
        {
          ok: false,
          violations: [{ rule: "r1", severity: "critical", message: "X" }],
        },
        Date.now(),
      );

      store.clear();

      const page = await store.violations.getViolations({ agentId: agent });
      expect(page.items).toHaveLength(0);
    });
  });
});
