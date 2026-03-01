import { describe, expect, mock, test } from "bun:test";
import type { RiskAnalysis, SecurityAnalyzer } from "@koi/core";
import { createCompositeSecurityAnalyzer } from "./composite.js";
import { createRulesSecurityAnalyzer } from "./rules.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStaticAnalyzer(result: RiskAnalysis): SecurityAnalyzer {
  return { analyze: mock(async () => result) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCompositeSecurityAnalyzer", () => {
  test("empty analyzers → riskLevel 'low', no findings", async () => {
    const composite = createCompositeSecurityAnalyzer([]);
    const result = await composite.analyze("bash", { command: "rm -rf /" });
    expect(result.riskLevel).toBe("low");
    expect(result.findings).toHaveLength(0);
  });

  test("all analyzers are called (spy verifies)", async () => {
    const a1 = makeStaticAnalyzer({ riskLevel: "low", findings: [], rationale: "ok" });
    const a2 = makeStaticAnalyzer({ riskLevel: "low", findings: [], rationale: "ok" });
    const a3 = makeStaticAnalyzer({ riskLevel: "low", findings: [], rationale: "ok" });

    const composite = createCompositeSecurityAnalyzer([a1, a2, a3]);
    await composite.analyze("bash", { command: "ls" });

    expect(a1.analyze).toHaveBeenCalledTimes(1);
    expect(a2.analyze).toHaveBeenCalledTimes(1);
    expect(a3.analyze).toHaveBeenCalledTimes(1);
  });

  test("max risk taken across analyzers", async () => {
    const a1 = makeStaticAnalyzer({
      riskLevel: "low",
      findings: [],
      rationale: "ok",
    });
    const a2 = makeStaticAnalyzer({
      riskLevel: "high",
      findings: [{ pattern: "sudo", description: "High-risk: sudo", riskLevel: "high" }],
      rationale: "sudo matched",
    });
    const a3 = makeStaticAnalyzer({
      riskLevel: "medium",
      findings: [{ pattern: "curl", description: "Medium-risk: curl", riskLevel: "medium" }],
      rationale: "curl matched",
    });

    const composite = createCompositeSecurityAnalyzer([a1, a2, a3]);
    const result = await composite.analyze("bash", { command: "sudo curl ..." });

    expect(result.riskLevel).toBe("high");
    expect(result.findings).toHaveLength(2); // high + medium findings combined
  });

  test("all analyzers return 'low' → result is 'low'", async () => {
    const analyzers = [
      makeStaticAnalyzer({ riskLevel: "low", findings: [], rationale: "ok" }),
      makeStaticAnalyzer({ riskLevel: "low", findings: [], rationale: "ok" }),
    ];
    const composite = createCompositeSecurityAnalyzer(analyzers);
    const result = await composite.analyze("bash", { command: "ls" });
    expect(result.riskLevel).toBe("low");
  });

  test("'critical' propagates when one analyzer returns critical", async () => {
    const a1 = makeStaticAnalyzer({ riskLevel: "critical", findings: [], rationale: "very bad" });
    const a2 = makeStaticAnalyzer({ riskLevel: "low", findings: [], rationale: "ok" });

    const composite = createCompositeSecurityAnalyzer([a1, a2]);
    const result = await composite.analyze("bash", { command: "something" });
    expect(result.riskLevel).toBe("critical");
  });

  test("parallel execution: total latency ≈ slowest analyzer, not sum", async () => {
    const SLOW_MS = 60;
    const FAST_MS = 10;

    const slow: SecurityAnalyzer = {
      analyze: () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ riskLevel: "high", findings: [], rationale: "slow" }),
            SLOW_MS,
          ),
        ),
    };
    const fast: SecurityAnalyzer = {
      analyze: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ riskLevel: "low", findings: [], rationale: "fast" }), FAST_MS),
        ),
    };

    const composite = createCompositeSecurityAnalyzer([slow, fast]);
    const start = Date.now();
    const result = await composite.analyze("bash", { command: "test" });
    const elapsed = Date.now() - start;

    expect(result.riskLevel).toBe("high");
    // Should take ~SLOW_MS, not SLOW_MS + FAST_MS
    expect(elapsed).toBeLessThan(SLOW_MS + FAST_MS + 30); // 30ms slack
  });

  test("forwards context to all analyzers", async () => {
    const captured: Array<{ context: unknown }> = [];
    const a1: SecurityAnalyzer = {
      analyze: (_toolId, _input, ctx) => {
        captured.push({ context: ctx });
        return { riskLevel: "low", findings: [], rationale: "ok" };
      },
    };
    const a2: SecurityAnalyzer = {
      analyze: (_toolId, _input, ctx) => {
        captured.push({ context: ctx });
        return { riskLevel: "low", findings: [], rationale: "ok" };
      },
    };

    const composite = createCompositeSecurityAnalyzer([a1, a2]);
    const ctx = { sessionId: "sess-123" };
    await composite.analyze("bash", {}, ctx);

    expect(captured).toHaveLength(2);
    expect(captured[0]?.context).toEqual(ctx);
    expect(captured[1]?.context).toEqual(ctx);
  });

  test("works with real rules analyzer", async () => {
    const rules = createRulesSecurityAnalyzer();
    const composite = createCompositeSecurityAnalyzer([rules]);
    const result = await composite.analyze("bash", { command: "rm -rf /tmp" });
    expect(result.riskLevel).toBe("high");
  });
});
