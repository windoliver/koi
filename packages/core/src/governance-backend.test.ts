import { describe, expect, test } from "bun:test";
import { agentId } from "./ecs.js";
import type {
  ComplianceRecord,
  ComplianceRecorder,
  ConstraintChecker,
  ConstraintQuery,
  GovernanceBackend,
  GovernanceVerdict,
  PolicyEvaluator,
  PolicyRequest,
  PolicyRequestKind,
  Violation,
  ViolationFilter,
  ViolationPage,
  ViolationSeverity,
  ViolationStore,
} from "./governance-backend.js";
import {
  DEFAULT_VIOLATION_QUERY_LIMIT,
  GOVERNANCE_ALLOW,
  VIOLATION_SEVERITY_ORDER,
} from "./governance-backend.js";

describe("PolicyRequestKind", () => {
  test("accepts all standard kinds", () => {
    const kinds: readonly PolicyRequestKind[] = [
      "tool_call",
      "model_call",
      "spawn",
      "delegation",
      "forge",
      "handoff",
    ];
    expect(kinds).toHaveLength(6);
  });

  test("accepts custom: prefixed kinds", () => {
    const customKind: PolicyRequestKind = "custom:my-domain-check";
    expect(customKind).toBe("custom:my-domain-check");
  });

  test("exhaustive switch covers all standard kinds", () => {
    const toLabel = (kind: PolicyRequestKind): string => {
      switch (kind) {
        case "tool_call":
          return "tool";
        case "model_call":
          return "model";
        case "spawn":
          return "spawn";
        case "delegation":
          return "delegation";
        case "forge":
          return "forge";
        case "handoff":
          return "handoff";
        default: {
          // custom:${string} falls through to default
          const custom: `custom:${string}` = kind;
          return `custom(${custom})`;
        }
      }
    };
    expect(toLabel("tool_call")).toBe("tool");
    expect(toLabel("custom:foo")).toBe("custom(custom:foo)");
  });
});

describe("PolicyRequest", () => {
  test("conforms to interface shape", () => {
    const request = {
      kind: "tool_call" as PolicyRequestKind,
      agentId: agentId("agent-a"),
      payload: { toolName: "read_file" },
      timestamp: 1_000_000,
    } satisfies PolicyRequest;
    expect(request.kind).toBe("tool_call");
  });

  test("accepts custom kind", () => {
    const request = {
      kind: "custom:domain-check" as PolicyRequestKind,
      agentId: agentId("agent-b"),
      payload: { domain: "example.com" },
      timestamp: 2_000_000,
    } satisfies PolicyRequest;
    expect(request.kind).toBe("custom:domain-check");
  });
});

describe("VIOLATION_SEVERITY_ORDER", () => {
  test("has 3 ordered levels", () => {
    expect(VIOLATION_SEVERITY_ORDER).toHaveLength(3);
  });

  test("starts with info and ends with critical", () => {
    expect(VIOLATION_SEVERITY_ORDER[0]).toBe("info");
    expect(VIOLATION_SEVERITY_ORDER[VIOLATION_SEVERITY_ORDER.length - 1]).toBe("critical");
  });

  test("is frozen at runtime", () => {
    expect(Object.isFrozen(VIOLATION_SEVERITY_ORDER)).toBe(true);
  });

  test("contains all expected severities in order", () => {
    expect(VIOLATION_SEVERITY_ORDER).toEqual(["info", "warning", "critical"]);
  });

  test("info index is lower than critical index", () => {
    const infoIdx = VIOLATION_SEVERITY_ORDER.indexOf("info");
    const criticalIdx = VIOLATION_SEVERITY_ORDER.indexOf("critical");
    expect(infoIdx).toBeLessThan(criticalIdx);
  });
});

describe("ViolationSeverity", () => {
  test("all values are present in VIOLATION_SEVERITY_ORDER", () => {
    const severities: readonly ViolationSeverity[] = ["info", "warning", "critical"];
    for (const severity of severities) {
      expect(VIOLATION_SEVERITY_ORDER).toContain(severity);
    }
  });
});

describe("Violation", () => {
  test("conforms to interface shape", () => {
    const violation = {
      rule: "max-spawn-depth",
      severity: "critical" as ViolationSeverity,
      message: "Agent exceeded maximum spawn depth of 3",
    } satisfies Violation;
    expect(violation.rule).toBe("max-spawn-depth");
  });

  test("accepts optional context field", () => {
    const violation = {
      rule: "no-external-api",
      severity: "warning" as ViolationSeverity,
      message: "External API access is restricted",
      context: { url: "https://example.com", method: "GET" },
    } satisfies Violation;
    expect(violation.context?.url).toBe("https://example.com");
  });
});

describe("GovernanceVerdict", () => {
  test("narrows to allow branch", () => {
    const verdict: GovernanceVerdict = { ok: true };
    if (verdict.ok) {
      expect(verdict.diagnostics).toBeUndefined();
    }
  });

  test("narrows to deny branch with violations", () => {
    const verdict: GovernanceVerdict = {
      ok: false,
      violations: [{ rule: "test-rule", severity: "critical", message: "denied" }],
    };
    if (!verdict.ok) {
      expect(verdict.violations).toHaveLength(1);
      expect(verdict.violations[0]?.rule).toBe("test-rule");
    }
  });

  test("allow branch accepts optional diagnostics", () => {
    const verdict: GovernanceVerdict = {
      ok: true,
      diagnostics: [{ rule: "rate-limit", severity: "info", message: "Approaching rate limit" }],
    };
    if (verdict.ok) {
      expect(verdict.diagnostics).toHaveLength(1);
    }
  });
});

describe("GOVERNANCE_ALLOW", () => {
  test("is frozen at runtime", () => {
    expect(Object.isFrozen(GOVERNANCE_ALLOW)).toBe(true);
  });

  test("has ok: true", () => {
    expect(GOVERNANCE_ALLOW.ok).toBe(true);
  });

  test("has no diagnostics", () => {
    if (GOVERNANCE_ALLOW.ok) {
      expect(GOVERNANCE_ALLOW.diagnostics).toBeUndefined();
    }
  });

  test("is a valid GovernanceVerdict", () => {
    const verdict: GovernanceVerdict = GOVERNANCE_ALLOW;
    expect(verdict.ok).toBe(true);
  });
});

describe("ConstraintQuery", () => {
  test("conforms to interface shape with all fields", () => {
    const query = {
      kind: "spawn_depth",
      agentId: agentId("agent-a"),
      value: 4,
      context: { maxAllowed: 3 },
    } satisfies ConstraintQuery;
    expect(query.kind).toBe("spawn_depth");
  });

  test("value and context are optional", () => {
    const query: ConstraintQuery = {
      kind: "token_budget",
      agentId: agentId("agent-b"),
    };
    expect(query.value).toBeUndefined();
    expect(query.context).toBeUndefined();
  });

  test("value accepts string", () => {
    const query = {
      kind: "model_tier",
      agentId: agentId("agent-c"),
      value: "premium",
    } satisfies ConstraintQuery;
    expect(query.value).toBe("premium");
  });
});

describe("ComplianceRecord", () => {
  test("conforms to interface shape", () => {
    const record = {
      requestId: "req-001",
      request: {
        kind: "tool_call" as PolicyRequestKind,
        agentId: agentId("agent-a"),
        payload: { toolName: "read_file" },
        timestamp: 1_000_000,
      },
      verdict: GOVERNANCE_ALLOW,
      evaluatedAt: 1_000_001,
      policyFingerprint: "sha256:abc123",
    } satisfies ComplianceRecord;
    expect(record.requestId).toBe("req-001");
    expect(record.verdict.ok).toBe(true);
  });
});

describe("DEFAULT_VIOLATION_QUERY_LIMIT", () => {
  test("is 100", () => {
    expect(DEFAULT_VIOLATION_QUERY_LIMIT).toBe(100);
  });

  test("is a positive integer", () => {
    expect(DEFAULT_VIOLATION_QUERY_LIMIT).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_VIOLATION_QUERY_LIMIT)).toBe(true);
  });
});

describe("ViolationFilter", () => {
  test("all fields are optional", () => {
    const emptyFilter = {} satisfies ViolationFilter;
    expect(emptyFilter).toBeDefined();
  });

  test("supports full filter shape", () => {
    const fullFilter = {
      agentId: agentId("agent-a"),
      sessionId: "session-1" as import("./ecs.js").SessionId,
      severity: "warning" as ViolationSeverity,
      rule: "max-spawn-depth",
      since: 1_000_000,
      until: 2_000_000,
      limit: 50,
      offset: "cursor-abc",
    } satisfies ViolationFilter;
    expect(fullFilter.limit).toBe(50);
  });
});

describe("ViolationPage", () => {
  test("conforms to interface shape", () => {
    const page: ViolationPage = {
      items: [],
    };
    expect(page.items).toHaveLength(0);
    expect(page.cursor).toBeUndefined();
    expect(page.total).toBeUndefined();
  });

  test("accepts cursor and total", () => {
    const page = {
      items: [{ rule: "test", severity: "info" as ViolationSeverity, message: "ok" }],
      cursor: "next-page",
      total: 42,
    } satisfies ViolationPage;
    expect(page.cursor).toBe("next-page");
    expect(page.total).toBe(42);
  });
});

describe("PolicyEvaluator", () => {
  test("scope field is optional", () => {
    const evaluator: PolicyEvaluator = {
      evaluate: () => GOVERNANCE_ALLOW,
    };
    expect(evaluator.scope).toBeUndefined();
  });

  test("scope field accepts PolicyRequestKind array", () => {
    const evaluator: PolicyEvaluator = {
      evaluate: () => GOVERNANCE_ALLOW,
      scope: ["tool_call", "spawn"],
    };
    expect(evaluator.scope).toHaveLength(2);
  });
});

describe("GovernanceBackend interface", () => {
  test("type-compatible minimal implementation compiles", () => {
    const backend = {
      evaluator: {
        evaluate: (_request: PolicyRequest) => GOVERNANCE_ALLOW,
      },
    } satisfies GovernanceBackend;
    expect(backend.evaluator).toBeDefined();
  });

  test("optional sub-interfaces are not required", () => {
    const minimalBackend: GovernanceBackend = {
      evaluator: {
        evaluate: () => GOVERNANCE_ALLOW,
      },
    };
    expect(minimalBackend.constraints).toBeUndefined();
    expect(minimalBackend.compliance).toBeUndefined();
    expect(minimalBackend.violations).toBeUndefined();
    expect(minimalBackend.dispose).toBeUndefined();
  });

  test("accepts all sub-interfaces", () => {
    const backend: GovernanceBackend = {
      evaluator: {
        evaluate: () => GOVERNANCE_ALLOW,
        scope: ["tool_call"],
      } satisfies PolicyEvaluator,
      constraints: {
        checkConstraint: () => true,
      } satisfies ConstraintChecker,
      compliance: {
        recordCompliance: (record: ComplianceRecord) => record,
      } satisfies ComplianceRecorder,
      violations: {
        getViolations: (_filter: ViolationFilter) => ({ items: [], total: 0 }),
      } satisfies ViolationStore,
      dispose: () => {},
    };
    expect(backend.evaluator).toBeDefined();
    expect(backend.constraints).toBeDefined();
    expect(backend.compliance).toBeDefined();
    expect(backend.violations).toBeDefined();
    expect(backend.dispose).toBeDefined();
  });

  test("sub-interfaces compose independently", () => {
    // Evaluator + constraints only
    const withConstraints: GovernanceBackend = {
      evaluator: { evaluate: () => GOVERNANCE_ALLOW },
      constraints: { checkConstraint: () => true },
    };
    expect(withConstraints.compliance).toBeUndefined();

    // Evaluator + violations only
    const withViolations: GovernanceBackend = {
      evaluator: { evaluate: () => GOVERNANCE_ALLOW },
      violations: { getViolations: () => ({ items: [] }) },
    };
    expect(withViolations.constraints).toBeUndefined();
  });
});
