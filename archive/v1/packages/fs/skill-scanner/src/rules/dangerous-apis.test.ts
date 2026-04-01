import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { ScanContext } from "../types.js";
import { dangerousApisRule } from "./dangerous-apis.js";

function scanCode(code: string): ReturnType<typeof dangerousApisRule.check> {
  const result = parseSync("input.ts", code, { sourceType: "module" });
  const ctx: ScanContext = {
    program: result.program,
    sourceText: code,
    filename: "input.ts",
  };
  return dangerousApisRule.check(ctx);
}

describe("dangerous-apis rule", () => {
  describe("malicious patterns", () => {
    test("detects direct eval()", () => {
      const findings = scanCode('eval("malicious code");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.severity).toBe("CRITICAL");
      expect(findings[0]?.rule).toContain("eval");
    });

    test("detects new Function()", () => {
      const findings = scanCode('new Function("return 1");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.severity).toBe("CRITICAL");
      expect(findings[0]?.rule).toContain("Function");
    });

    test("detects Function() call", () => {
      const findings = scanCode('Function("return 1")();');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.severity).toBe("CRITICAL");
    });

    test("detects require('child_process')", () => {
      const findings = scanCode('const cp = require("child_process");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.rule.includes("require-dangerous-module"))).toBe(true);
    });

    test("detects child_process.exec()", () => {
      const findings = scanCode('child_process.exec("ls");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.severity).toBe("CRITICAL");
    });

    test("detects aliased eval via variable", () => {
      const findings = scanCode('const e = eval;\ne("code");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.confidence === 0.8)).toBe(true);
    });

    test("detects dynamic import of dangerous module", () => {
      const findings = scanCode('import("child_process");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.severity).toBe("CRITICAL");
    });

    test("detects dynamic import with variable", () => {
      const findings = scanCode('const mod = "fs";\nimport(mod);');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.rule === "dangerous-api:dynamic-import")).toBe(true);
    });

    test("detects setTimeout with string argument", () => {
      const findings = scanCode('setTimeout("alert(1)", 1000);');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.severity).toBe("HIGH");
    });

    test("detects process.binding()", () => {
      const findings = scanCode('process.binding("spawn_sync");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.severity).toBe("CRITICAL");
    });

    test("detects dynamic require with variable", () => {
      const findings = scanCode("const mod = 'fs';\nrequire(mod);");
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.rule === "dangerous-api:dynamic-require")).toBe(true);
    });

    test("detects globalThis.eval()", () => {
      const findings = scanCode('globalThis.eval("malicious");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.rule === "dangerous-api:global-eval")).toBe(true);
      expect(findings[0]?.severity).toBe("CRITICAL");
    });

    test("detects window.eval()", () => {
      const findings = scanCode('window.eval("code");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.rule === "dangerous-api:global-eval")).toBe(true);
    });
  });

  describe("benign patterns", () => {
    test("does not flag console.log", () => {
      const findings = scanCode('console.log("hello");');
      expect(findings).toHaveLength(0);
    });

    test("does not flag normal function calls", () => {
      const findings = scanCode(
        "function add(a: number, b: number): number { return a + b; }\nadd(1, 2);",
      );
      expect(findings).toHaveLength(0);
    });

    test("does not flag static imports", () => {
      const findings = scanCode('import { readFile } from "fs";');
      expect(findings).toHaveLength(0);
    });

    test("does not flag setTimeout with function argument", () => {
      const findings = scanCode("setTimeout(() => {}, 1000);");
      expect(findings).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    test("handles empty code", () => {
      const findings = scanCode("");
      expect(findings).toHaveLength(0);
    });
  });
});
