import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { ScanContext } from "../types.js";
import { obfuscationRule } from "./obfuscation.js";

function scanCode(code: string): ReturnType<typeof obfuscationRule.check> {
  const result = parseSync("input.ts", code, { sourceType: "module" });
  const ctx: ScanContext = {
    program: result.program,
    sourceText: code,
    filename: "input.ts",
  };
  return obfuscationRule.check(ctx);
}

describe("obfuscation rule", () => {
  describe("malicious patterns", () => {
    test("detects string concatenation building 'eval'", () => {
      const findings = scanCode('const name = "ev" + "al";');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.rule === "obfuscation:string-concat-api")).toBe(true);
      expect(findings.some((f) => f.severity === "CRITICAL")).toBe(true);
    });

    test("detects computed property access building dangerous name", () => {
      const findings = scanCode('window["ev" + "al"]("code");');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.rule === "obfuscation:computed-property-concat")).toBe(true);
    });

    test("detects string concatenation building 'require'", () => {
      const findings = scanCode('const r = "req" + "uire";');
      expect(findings.length).toBeGreaterThan(0);
    });

    test("detects high hex escape density in string literals", () => {
      // String with many hex escapes
      const hexString = '"\\x65\\x76\\x61\\x6c\\x28\\x29\\x3b\\x0a"';
      const findings = scanCode(`const x = ${hexString};`);
      expect(findings.some((f) => f.rule === "obfuscation:escape-density")).toBe(true);
    });
  });

  describe("benign patterns", () => {
    test("does not flag normal string concatenation", () => {
      const findings = scanCode('const greeting = "hello" + " " + "world";');
      expect(findings.filter((f) => f.rule === "obfuscation:string-concat-api")).toHaveLength(0);
    });

    test("does not flag normal computed property access", () => {
      const findings = scanCode('const key = "name";\nconst val = obj[key];');
      expect(
        findings.filter((f) => f.rule === "obfuscation:computed-property-concat"),
      ).toHaveLength(0);
    });

    test("does not flag short strings with occasional escapes", () => {
      const findings = scanCode('const x = "hello\\n";');
      expect(findings.filter((f) => f.rule === "obfuscation:escape-density")).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    test("handles empty code", () => {
      const findings = scanCode("");
      expect(findings).toHaveLength(0);
    });

    test("handles code with no string literals", () => {
      const findings = scanCode("const x = 1 + 2;");
      expect(findings).toHaveLength(0);
    });
  });
});
