import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { ScanContext } from "../types.js";
import { ssrfRule } from "./ssrf.js";

function scanCode(code: string): ReturnType<typeof ssrfRule.check> {
  const result = parseSync("input.ts", code, { sourceType: "module" });
  const ctx: ScanContext = {
    program: result.program,
    sourceText: code,
    filename: "input.ts",
  };
  return ssrfRule.check(ctx);
}

describe("ssrf rule", () => {
  describe("cloud metadata endpoints", () => {
    test("detects fetch to AWS metadata endpoint", () => {
      const findings = scanCode('fetch("http://169.254.169.254/latest/meta-data/");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.severity).toBe("CRITICAL");
      expect(findings[0]?.confidence).toBe(0.95);
      expect(findings[0]?.rule).toBe("ssrf:internal-network");
    });

    test("detects fetch to GCP metadata endpoint", () => {
      const findings = scanCode('fetch("http://metadata.google.internal/computeMetadata/v1/");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.severity).toBe("CRITICAL");
    });
  });

  describe("private RFC 1918 networks", () => {
    test("detects fetch to 10.x.x.x", () => {
      const findings = scanCode('fetch("http://10.0.0.1/internal");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.severity).toBe("HIGH");
      expect(findings[0]?.confidence).toBe(0.85);
    });

    test("detects fetch to 172.16.x.x", () => {
      const findings = scanCode('fetch("http://172.16.0.1/admin");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.severity).toBe("HIGH");
    });

    test("detects fetch to 192.168.x.x", () => {
      const findings = scanCode('fetch("http://192.168.1.1/config");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.severity).toBe("HIGH");
    });
  });

  describe("loopback addresses", () => {
    test("detects fetch to 127.0.0.1", () => {
      const findings = scanCode('fetch("http://127.0.0.1:8080/admin");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.severity).toBe("HIGH");
      expect(findings[0]?.confidence).toBe(0.8);
    });

    test("detects fetch to localhost", () => {
      const findings = scanCode('fetch("http://localhost/secret");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.severity).toBe("HIGH");
    });

    test("detects new WebSocket to private network", () => {
      const findings = scanCode('new WebSocket("ws://192.168.1.1/ws");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.severity).toBe("HIGH");
    });

    test("detects IPv6 loopback", () => {
      const findings = scanCode('fetch("http://[::1]:8080/admin");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.severity).toBe("HIGH");
      expect(findings[0]?.confidence).toBe(0.75);
    });
  });

  describe("172.x boundary tests", () => {
    test("172.15.0.1 is NOT flagged (outside /12)", () => {
      const findings = scanCode('fetch("http://172.15.0.1/api");');
      expect(findings).toHaveLength(0);
    });

    test("172.32.0.1 is NOT flagged (outside /12)", () => {
      const findings = scanCode('fetch("http://172.32.0.1/api");');
      expect(findings).toHaveLength(0);
    });

    test("172.16.0.1 IS flagged", () => {
      const findings = scanCode('fetch("http://172.16.0.1/api");');
      expect(findings.length).toBeGreaterThan(0);
    });

    test("172.31.255.255 IS flagged", () => {
      const findings = scanCode('fetch("http://172.31.255.255/api");');
      expect(findings.length).toBeGreaterThan(0);
    });
  });

  describe("member-based network APIs", () => {
    test("detects http.get to private network", () => {
      const findings = scanCode('http.get("http://10.0.0.5/internal");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.severity).toBe("HIGH");
    });

    test("detects https.request to metadata endpoint", () => {
      const findings = scanCode('https.request("http://169.254.169.254/latest/meta-data/");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.severity).toBe("CRITICAL");
    });
  });

  describe("IP encoding bypass detection", () => {
    test("detects decimal IP for loopback (2130706433 = 127.0.0.1)", () => {
      // URL parser may resolve decimal IPs directly; either way it should be flagged
      const findings = scanCode('fetch("http://2130706433/admin");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.severity).toBe("HIGH");
    });

    test("detects hex IP for loopback (0x7f000001 = 127.0.0.1)", () => {
      const findings = scanCode('fetch("http://0x7f000001/admin");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.severity).toBe("HIGH");
    });

    test("detects octal IP for loopback (0177.0.0.01 = 127.0.0.1)", () => {
      const findings = scanCode('fetch("http://0177.0.0.01/admin");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.severity).toBe("HIGH");
    });

    test("detects decimal IP for metadata (2852039166 = 169.254.169.254)", () => {
      const findings = scanCode('fetch("http://2852039166/latest/meta-data/");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.severity).toBe("CRITICAL");
    });

    test("detects hex IP for private network (0x0a000001 = 10.0.0.1)", () => {
      const findings = scanCode('fetch("http://0x0a000001/internal");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.severity).toBe("HIGH");
    });

    test("normal decimal port number is NOT treated as IP", () => {
      const findings = scanCode('fetch("https://api.example.com:8080/data");');
      expect(findings).toHaveLength(0);
    });
  });

  describe("benign patterns", () => {
    test("fetch to public API produces no findings", () => {
      const findings = scanCode('fetch("https://api.example.com/data");');
      expect(findings).toHaveLength(0);
    });

    test("fetch with dynamic URL produces no findings", () => {
      const findings = scanCode("fetch(variable);");
      expect(findings).toHaveLength(0);
    });

    test("console.log produces no findings", () => {
      const findings = scanCode('console.log("test");');
      expect(findings).toHaveLength(0);
    });

    test("empty code produces no findings", () => {
      const findings = scanCode("");
      expect(findings).toHaveLength(0);
    });

    test("non-network call with URL string produces no findings", () => {
      const findings = scanCode('const url = "http://169.254.169.254/latest";');
      expect(findings).toHaveLength(0);
    });
  });
});
