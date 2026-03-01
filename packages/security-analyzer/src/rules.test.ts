import { describe, expect, test } from "bun:test";
import {
  createRulesSecurityAnalyzer,
  DEFAULT_HIGH_RISK_PATTERNS,
  DEFAULT_MEDIUM_RISK_PATTERNS,
  defaultExtractCommand,
  maxRiskLevel,
} from "./rules.js";

// ---------------------------------------------------------------------------
// maxRiskLevel
// ---------------------------------------------------------------------------

describe("maxRiskLevel", () => {
  test("returns 'low' for empty array", () => {
    expect(maxRiskLevel([])).toBe("low");
  });

  test("returns the single level for single-element array", () => {
    expect(maxRiskLevel(["medium"])).toBe("medium");
    expect(maxRiskLevel(["critical"])).toBe("critical");
    expect(maxRiskLevel(["unknown"])).toBe("unknown");
  });

  test("returns maximum across mixed levels", () => {
    expect(maxRiskLevel(["low", "medium", "high"])).toBe("high");
    expect(maxRiskLevel(["critical", "low"])).toBe("critical");
    expect(maxRiskLevel(["unknown", "medium"])).toBe("medium");
  });
});

// ---------------------------------------------------------------------------
// defaultExtractCommand
// ---------------------------------------------------------------------------

describe("defaultExtractCommand", () => {
  test("uses 'command' field when present", () => {
    const result = defaultExtractCommand("bash", { command: "rm -rf /tmp" });
    expect(result).toBe("bash rm -rf /tmp");
  });

  test("uses 'cmd' field as fallback", () => {
    const result = defaultExtractCommand("exec", { cmd: "sudo ls" });
    expect(result).toBe("exec sudo ls");
  });

  test("uses 'args' field as second fallback", () => {
    const result = defaultExtractCommand("run", { args: "wget http://x.com" });
    expect(result).toBe("run wget http://x.com");
  });

  test("falls back to JSON serialization when no known field", () => {
    const result = defaultExtractCommand("mytool", { foo: "bar" });
    expect(result).toContain("mytool");
    expect(result).toContain("bar");
  });

  test("includes toolId as prefix in all cases", () => {
    const result = defaultExtractCommand("bash", { command: "ls" });
    expect(result.startsWith("bash")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createRulesSecurityAnalyzer — default patterns
// ---------------------------------------------------------------------------

describe("createRulesSecurityAnalyzer — high risk patterns", () => {
  const analyzer = createRulesSecurityAnalyzer();

  test("'rm -rf /home' → riskLevel 'high'", async () => {
    const result = await analyzer.analyze("bash", { command: "rm -rf /home" });
    expect(result.riskLevel).toBe("high");
    expect(result.findings.some((f) => f.riskLevel === "high")).toBe(true);
  });

  test("'sudo apt-get install' → riskLevel 'high' (sudo matched)", async () => {
    const result = await analyzer.analyze("bash", { command: "sudo apt-get install curl" });
    expect(result.riskLevel).toBe("high");
  });

  test("'eval(' → riskLevel 'high'", async () => {
    const result = await analyzer.analyze("bash", { command: "eval(someCode)" });
    expect(result.riskLevel).toBe("high");
  });

  test("'exec(' → riskLevel 'high'", async () => {
    const result = await analyzer.analyze("bash", { command: "exec(cmd)" });
    expect(result.riskLevel).toBe("high");
  });

  test("'chmod 777' → riskLevel 'high'", async () => {
    const result = await analyzer.analyze("bash", { command: "chmod 777 /etc/shadow" });
    expect(result.riskLevel).toBe("high");
  });
});

describe("createRulesSecurityAnalyzer — medium risk patterns", () => {
  const analyzer = createRulesSecurityAnalyzer();

  test("'curl https://example.com' → riskLevel 'medium'", async () => {
    const result = await analyzer.analyze("bash", { command: "curl https://example.com" });
    expect(result.riskLevel).toBe("medium");
    expect(result.findings.some((f) => f.riskLevel === "medium")).toBe(true);
  });

  test("'wget' → riskLevel 'medium'", async () => {
    const result = await analyzer.analyze("bash", { command: "wget https://example.com/file" });
    expect(result.riskLevel).toBe("medium");
  });

  test("'git clone' → riskLevel 'medium'", async () => {
    const result = await analyzer.analyze("bash", {
      command: "git clone https://github.com/org/repo",
    });
    expect(result.riskLevel).toBe("medium");
  });
});

describe("createRulesSecurityAnalyzer — safe commands", () => {
  const analyzer = createRulesSecurityAnalyzer();

  test("'cat file.ts' → riskLevel 'low', empty findings", async () => {
    const result = await analyzer.analyze("bash", { command: "cat file.ts" });
    expect(result.riskLevel).toBe("low");
    expect(result.findings).toHaveLength(0);
    expect(result.rationale).toContain("no risky patterns");
  });

  test("'ls -la' → riskLevel 'low'", async () => {
    const result = await analyzer.analyze("bash", { command: "ls -la" });
    expect(result.riskLevel).toBe("low");
  });

  test("'echo hello' → riskLevel 'low'", async () => {
    const result = await analyzer.analyze("bash", { command: "echo hello" });
    expect(result.riskLevel).toBe("low");
  });
});

describe("createRulesSecurityAnalyzer — multiple matches", () => {
  const analyzer = createRulesSecurityAnalyzer();

  test("returns max risk + all findings when multiple patterns match", async () => {
    // "sudo rm -rf" matches both "sudo" (high) and "rm -rf" (high) — and also "curl" (medium)
    const result = await analyzer.analyze("bash", {
      command: "sudo curl https://x.com && rm -rf /",
    });
    expect(result.riskLevel).toBe("high");
    // at least sudo, rm -rf, and curl should be in findings
    expect(result.findings.length).toBeGreaterThanOrEqual(3);
  });

  test("rationale reflects count of matches", async () => {
    const result = await analyzer.analyze("bash", { command: "sudo rm -rf /home" });
    expect(result.rationale).toMatch(/\d+ pattern\(s\) matched/);
  });
});

describe("createRulesSecurityAnalyzer — case insensitivity", () => {
  const analyzer = createRulesSecurityAnalyzer();

  test("'RM -RF' matches 'rm -rf' pattern (case-insensitive)", async () => {
    const result = await analyzer.analyze("bash", { command: "RM -RF /tmp" });
    expect(result.riskLevel).toBe("high");
  });

  test("'SUDO ls' matches 'sudo' pattern (case-insensitive)", async () => {
    const result = await analyzer.analyze("bash", { command: "SUDO ls" });
    expect(result.riskLevel).toBe("high");
  });

  test("'CURL https://x.com' matches 'curl' pattern (case-insensitive)", async () => {
    const result = await analyzer.analyze("bash", { command: "CURL https://x.com" });
    expect(result.riskLevel).toBe("medium");
  });
});

describe("createRulesSecurityAnalyzer — custom patterns", () => {
  test("custom highPatterns override defaults", async () => {
    const analyzer = createRulesSecurityAnalyzer({
      highPatterns: ["DANGER"],
      mediumPatterns: [],
    });

    // Default pattern "rm -rf" should NOT match (overridden)
    const safe = await analyzer.analyze("bash", { command: "rm -rf /tmp" });
    expect(safe.riskLevel).toBe("low");

    // Custom pattern should match
    const risky = await analyzer.analyze("bash", { command: "something DANGER here" });
    expect(risky.riskLevel).toBe("high");
  });

  test("custom mediumPatterns override defaults", async () => {
    const analyzer = createRulesSecurityAnalyzer({
      highPatterns: [],
      mediumPatterns: ["MY_PATTERN"],
    });

    const result = await analyzer.analyze("bash", { command: "use MY_PATTERN now" });
    expect(result.riskLevel).toBe("medium");
  });

  test("custom extractCommand receives full input object", async () => {
    const captured: { toolId: string; input: Record<string, unknown> }[] = [];

    const analyzer = createRulesSecurityAnalyzer({
      extractCommand: (toolId, input) => {
        captured.push({ toolId, input: { ...input } });
        return `${toolId} ${String(input.action ?? "")}`;
      },
    });

    await analyzer.analyze("mytool", { action: "rm -rf /" });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.toolId).toBe("mytool");
    expect(captured[0]?.input.action).toBe("rm -rf /");
  });
});

describe("createRulesSecurityAnalyzer — default exports", () => {
  test("DEFAULT_HIGH_RISK_PATTERNS is a non-empty readonly array", () => {
    expect(Array.isArray(DEFAULT_HIGH_RISK_PATTERNS)).toBe(true);
    expect(DEFAULT_HIGH_RISK_PATTERNS.length).toBeGreaterThan(0);
  });

  test("DEFAULT_MEDIUM_RISK_PATTERNS is a non-empty readonly array", () => {
    expect(Array.isArray(DEFAULT_MEDIUM_RISK_PATTERNS)).toBe(true);
    expect(DEFAULT_MEDIUM_RISK_PATTERNS.length).toBeGreaterThan(0);
  });
});
