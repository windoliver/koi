import { describe, expect, mock, test } from "bun:test";
import type { RiskAnalysis, SecurityAnalyzer } from "@koi/core";
import { RISK_ANALYSIS_UNKNOWN } from "@koi/core";
import { DEFAULT_ANALYZER_TIMEOUT_MS, withRiskAnalysis } from "./hof.js";

// ---------------------------------------------------------------------------
// Types that mimic ProgressiveDecision (without importing exec-approvals)
// ---------------------------------------------------------------------------

type Decision =
  | { readonly kind: "allow_once" }
  | { readonly kind: "deny_once"; readonly reason: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestRequest {
  readonly toolId: string;
  readonly input: Record<string, unknown>;
}

function makeAnalyzer(result: RiskAnalysis): SecurityAnalyzer {
  return { analyze: mock(async () => result) };
}

function makeSlowAnalyzer(result: RiskAnalysis, delayMs: number): SecurityAnalyzer {
  return {
    analyze: mock(
      () => new Promise<RiskAnalysis>((resolve) => setTimeout(() => resolve(result), delayMs)),
    ),
  };
}

function makeThrowingAnalyzer(): SecurityAnalyzer {
  return {
    analyze: mock(() => {
      throw new Error("analyzer crashed");
    }),
  };
}

const ALLOW_ONCE: Decision = { kind: "allow_once" };
const DENY_ONCE: Decision = { kind: "deny_once", reason: "denied" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("withRiskAnalysis", () => {
  test("DEFAULT_ANALYZER_TIMEOUT_MS is 2000", () => {
    expect(DEFAULT_ANALYZER_TIMEOUT_MS).toBe(2_000);
  });

  test("'critical' risk → returns deny_once, onAsk never called", async () => {
    const analyzer = makeAnalyzer({
      riskLevel: "critical",
      findings: [],
      rationale: "very dangerous",
    });
    const onAsk = mock(async (_req: TestRequest & { riskAnalysis: RiskAnalysis }) => ALLOW_ONCE);
    const wrapped = withRiskAnalysis<TestRequest, Decision>(analyzer, onAsk, 2000);

    const result = await wrapped({ toolId: "bash", input: { command: "rm -rf /" } });

    expect(result.kind).toBe("deny_once");
    expect((result as { kind: "deny_once"; reason: string }).reason).toContain("Critical risk");
    expect(onAsk).not.toHaveBeenCalled();
  });

  test("'high' risk → calls onAsk with riskAnalysis populated", async () => {
    const riskAnalysis: RiskAnalysis = {
      riskLevel: "high",
      findings: [{ pattern: "sudo", description: "sudo matched", riskLevel: "high" }],
      rationale: "1 pattern(s) matched",
    };
    const analyzer = makeAnalyzer(riskAnalysis);
    const captured: Array<TestRequest & { riskAnalysis: RiskAnalysis }> = [];
    const onAsk = mock(async (req: TestRequest & { riskAnalysis: RiskAnalysis }) => {
      captured.push(req);
      return ALLOW_ONCE;
    });
    const wrapped = withRiskAnalysis<TestRequest, Decision>(analyzer, onAsk, 2000);

    const result = await wrapped({ toolId: "bash", input: { command: "sudo ls" } });

    expect(result.kind).toBe("allow_once");
    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(captured[0]?.riskAnalysis.riskLevel).toBe("high");
    expect(captured[0]?.riskAnalysis.findings).toHaveLength(1);
  });

  test("'low' risk → calls onAsk with riskAnalysis.riskLevel === 'low'", async () => {
    const analyzer = makeAnalyzer({
      riskLevel: "low",
      findings: [],
      rationale: "no patterns",
    });
    const onAsk = mock(async (req: TestRequest & { riskAnalysis: RiskAnalysis }) => {
      expect(req.riskAnalysis.riskLevel).toBe("low");
      return DENY_ONCE;
    });
    const wrapped = withRiskAnalysis<TestRequest, Decision>(analyzer, onAsk, 2000);

    await wrapped({ toolId: "bash", input: { command: "ls" } });
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  test("analyzer timeout → riskAnalysis.riskLevel === 'unknown', onAsk still called", async () => {
    const slowAnalyzer = makeSlowAnalyzer(
      { riskLevel: "high", findings: [], rationale: "slow" },
      500, // 500ms delay
    );
    const captured: Array<TestRequest & { riskAnalysis: RiskAnalysis }> = [];
    const onAsk = mock(async (req: TestRequest & { riskAnalysis: RiskAnalysis }) => {
      captured.push(req);
      return ALLOW_ONCE;
    });
    const wrapped = withRiskAnalysis<TestRequest, Decision>(slowAnalyzer, onAsk, 50); // 50ms timeout

    const result = await wrapped({ toolId: "bash", input: { command: "ls" } });

    expect(result.kind).toBe("allow_once");
    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(captured[0]?.riskAnalysis.riskLevel).toBe("unknown");
    expect(captured[0]?.riskAnalysis).toEqual(RISK_ANALYSIS_UNKNOWN);
  });

  test("analyzer throws → riskAnalysis.riskLevel === 'unknown', onAsk still called", async () => {
    const throwingAnalyzer = makeThrowingAnalyzer();
    const captured: Array<TestRequest & { riskAnalysis: RiskAnalysis }> = [];
    const onAsk = mock(async (req: TestRequest & { riskAnalysis: RiskAnalysis }) => {
      captured.push(req);
      return ALLOW_ONCE;
    });
    const wrapped = withRiskAnalysis<TestRequest, Decision>(throwingAnalyzer, onAsk, 2000);

    const result = await wrapped({ toolId: "bash", input: { command: "ls" } });

    expect(result.kind).toBe("allow_once");
    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(captured[0]?.riskAnalysis.riskLevel).toBe("unknown");
  });

  test("original request fields are preserved in enriched request", async () => {
    interface ExtendedRequest {
      readonly toolId: string;
      readonly input: Record<string, unknown>;
      readonly matchedPattern: string;
    }

    const analyzer = makeAnalyzer({ riskLevel: "medium", findings: [], rationale: "medium" });
    const captured: Array<ExtendedRequest & { riskAnalysis: RiskAnalysis }> = [];
    const onAsk = mock(async (req: ExtendedRequest & { riskAnalysis: RiskAnalysis }) => {
      captured.push(req);
      return ALLOW_ONCE;
    });
    const wrapped = withRiskAnalysis<ExtendedRequest, Decision>(analyzer, onAsk, 2000);

    await wrapped({
      toolId: "bash",
      input: { command: "curl x.com" },
      matchedPattern: "bash:curl*",
    });

    expect(captured[0]?.matchedPattern).toBe("bash:curl*");
    expect(captured[0]?.toolId).toBe("bash");
    expect(captured[0]?.riskAnalysis.riskLevel).toBe("medium");
  });

  test("uses DEFAULT_ANALYZER_TIMEOUT_MS when timeoutMs not specified", async () => {
    // This test just verifies the default is wired in — not a timing test
    const analyzer = makeAnalyzer({ riskLevel: "low", findings: [], rationale: "ok" });
    const onAsk = mock(async () => ALLOW_ONCE);
    const wrapped = withRiskAnalysis<TestRequest, Decision>(analyzer, onAsk); // no timeoutMs

    await wrapped({ toolId: "bash", input: {} });
    expect(onAsk).toHaveBeenCalledTimes(1);
  });
});
