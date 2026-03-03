import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { ScanContext } from "../types.js";
import { prototypePollutionRule } from "./prototype-pollution.js";

function scanCode(code: string): ReturnType<typeof prototypePollutionRule.check> {
  const result = parseSync("input.ts", code, { sourceType: "module" });
  const ctx: ScanContext = {
    program: result.program,
    sourceText: code,
    filename: "input.ts",
  };
  return prototypePollutionRule.check(ctx);
}

describe("prototype-pollution rule", () => {
  describe("malicious patterns", () => {
    test("detects merge() without proto guard", () => {
      const findings = scanCode(
        "function copyProps(target: any, source: any) {\n  merge(target, source);\n}",
      );
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.rule === "prototype-pollution:unsafe-merge")).toBe(true);
    });

    test("detects deepMerge without proto guard", () => {
      const findings = scanCode("deepMerge(obj1, obj2);");
      expect(findings.length).toBeGreaterThan(0);
    });

    test("detects Object.assign with variable arg", () => {
      const findings = scanCode("const result = Object.assign({}, userInput);");
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.rule === "prototype-pollution:object-assign")).toBe(true);
    });

    test("detects bracket assignment with dynamic key", () => {
      const findings = scanCode(
        "function set(obj: any, key: string, val: any) {\n  obj[key] = val;\n}",
      );
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.rule === "prototype-pollution:bracket-assignment")).toBe(true);
    });

    test("detects for..in without hasOwnProperty guard", () => {
      const findings = scanCode("for (const key in obj) {\n  result[key] = obj[key];\n}");
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.rule === "prototype-pollution:for-in-unguarded")).toBe(true);
    });
  });

  describe("benign patterns", () => {
    test("does not flag merge with proto guard", () => {
      const findings = scanCode('if (key === "__proto__") continue;\nmerge(target, source);');
      // The proto guard check is text-based, presence of "__proto__" string should suppress
      expect(findings.filter((f) => f.rule === "prototype-pollution:unsafe-merge")).toHaveLength(0);
    });

    test("does not flag for..in with hasOwnProperty", () => {
      const findings = scanCode(
        "for (const key in obj) {\n  if (obj.hasOwnProperty(key)) {\n    result[key] = obj[key];\n  }\n}",
      );
      expect(
        findings.filter((f) => f.rule === "prototype-pollution:for-in-unguarded"),
      ).toHaveLength(0);
    });

    test("does not flag for..in with Object.hasOwn", () => {
      const findings = scanCode(
        "for (const key in obj) {\n  if (Object.hasOwn(obj, key)) {\n    result[key] = obj[key];\n  }\n}",
      );
      expect(
        findings.filter((f) => f.rule === "prototype-pollution:for-in-unguarded"),
      ).toHaveLength(0);
    });

    test("does not flag Object.assign with literal objects", () => {
      const findings = scanCode("Object.assign({}, { a: 1 });");
      expect(findings.filter((f) => f.rule === "prototype-pollution:object-assign")).toHaveLength(
        0,
      );
    });
  });

  describe("edge cases", () => {
    test("handles empty code", () => {
      const findings = scanCode("");
      expect(findings).toHaveLength(0);
    });
  });
});
