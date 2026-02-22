import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { ScanContext } from "../types.js";
import { secretsRule } from "./secrets.js";

function scanCode(code: string): ReturnType<typeof secretsRule.check> {
  const result = parseSync("input.ts", code, { sourceType: "module" });
  const ctx: ScanContext = {
    program: result.program,
    sourceText: code,
    filename: "input.ts",
  };
  return secretsRule.check(ctx);
}

describe("secrets rule", () => {
  describe("AWS keys", () => {
    test("detects AWS Access Key ID", () => {
      const findings = scanCode('const key = "AKIAIOSFODNN7EXAMPLE";');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.rule).toBe("secrets:aws-access-key");
      expect(findings[0]?.severity).toBe("CRITICAL");
    });
  });

  describe("GitHub tokens", () => {
    test("detects GitHub PAT (ghp_)", () => {
      const findings = scanCode('const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn";');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.rule).toBe("secrets:github-token");
      expect(findings[0]?.severity).toBe("CRITICAL");
    });

    test("detects GitHub secret token (ghs_)", () => {
      const findings = scanCode('const token = "ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn";');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.rule).toBe("secrets:github-token");
    });

    test("detects GitHub OAuth token (gho_)", () => {
      const findings = scanCode('const token = "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn";');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.rule).toBe("secrets:github-oauth");
    });
  });

  describe("Slack tokens", () => {
    test("detects Slack bot token", () => {
      const findings = scanCode('const token = "xoxb-1234567890-abcdefghij";');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.rule).toBe("secrets:slack-token");
    });
  });

  describe("private keys", () => {
    test("detects RSA private key header", () => {
      const findings = scanCode('const key = "-----BEGIN RSA PRIVATE KEY-----\\nMIIE...";');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.rule).toBe("secrets:private-key");
      expect(findings[0]?.severity).toBe("CRITICAL");
    });

    test("detects generic private key header", () => {
      const findings = scanCode('const key = "-----BEGIN PRIVATE KEY-----\\nMIIE...";');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.rule).toBe("secrets:private-key");
    });
  });

  describe("API keys", () => {
    test("detects Anthropic API key", () => {
      const findings = scanCode('const key = "sk-ant-api03-abcdefghijklmnopqrst";');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.rule).toBe("secrets:anthropic-key");
    });

    test("detects OpenAI API key", () => {
      const findings = scanCode('const key = "sk-proj-abcdefghijklmnopqrstuvwx";');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.rule).toBe("secrets:openai-key");
    });

    test("detects Stripe secret key", () => {
      const findings = scanCode('const key = "sk_live_TESTKEY00000000000000";');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.rule).toBe("secrets:stripe-key");
    });
  });

  describe("generic patterns", () => {
    test("detects generic api_key assignment", () => {
      const findings = scanCode("const config = 'api_key: \"sk1234567890abcdefghij\"';");
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.rule === "secrets:generic-api-key")).toBe(true);
    });
  });

  describe("benign patterns", () => {
    test("short strings are not flagged", () => {
      const findings = scanCode('const x = "hello";');
      expect(findings).toHaveLength(0);
    });

    test("normal code produces no findings", () => {
      const findings = scanCode("function add(a: number, b: number): number { return a + b; }");
      expect(findings).toHaveLength(0);
    });

    test("empty code produces no findings", () => {
      const findings = scanCode("");
      expect(findings).toHaveLength(0);
    });

    test("environment variable reference is not flagged", () => {
      const findings = scanCode("const key = process.env.API_KEY;");
      expect(findings).toHaveLength(0);
    });

    test("placeholder key is not flagged (too short)", () => {
      const findings = scanCode('const key = "sk-xxxxx";');
      expect(findings).toHaveLength(0);
    });
  });

  describe("deduplication", () => {
    test("same pattern type only reported once", () => {
      const findings = scanCode(
        'const a = "AKIAIOSFODNN7EXAMPLE";\nconst b = "AKIAIOSFODNN7EXAMPL2";',
      );
      const awsFindings = findings.filter((f) => f.rule === "secrets:aws-access-key");
      expect(awsFindings).toHaveLength(1);
    });
  });
});
