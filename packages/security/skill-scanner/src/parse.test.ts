import { describe, expect, test } from "bun:test";
import { parseCode } from "./parse.js";

describe("parseCode", () => {
  test("parses valid TypeScript with no errors", () => {
    const output = parseCode("const x: number = 1;");
    expect(output.hasErrors).toBe(false);
    expect(output.findings).toHaveLength(0);
    expect(output.program).toBeDefined();
  });

  test("parses valid JavaScript with no errors", () => {
    const output = parseCode('const x = "hello";', "input.js");
    expect(output.hasErrors).toBe(false);
    expect(output.findings).toHaveLength(0);
  });

  test("returns parse error findings for invalid code", () => {
    const output = parseCode("const x = {;");
    expect(output.hasErrors).toBe(true);
    expect(output.findings.length).toBeGreaterThan(0);
    expect(output.findings.every((f) => f.category === "UNPARSEABLE")).toBe(true);
    expect(output.findings.every((f) => f.rule === "parse-error")).toBe(true);
    expect(output.findings.every((f) => f.confidence === 1.0)).toBe(true);
  });

  test("parse error findings have HIGH severity", () => {
    const output = parseCode("function (;");
    expect(output.findings.every((f) => f.severity === "HIGH")).toBe(true);
  });

  test("still returns a program AST for error-tolerant parsing", () => {
    const output = parseCode("const x = {;");
    // oxc-parser is error-tolerant — partial AST is always returned
    expect(output.program).toBeDefined();
    expect(typeof output.program.type).toBe("string");
  });

  test("includes location info in parse error findings when possible", () => {
    const output = parseCode("const x = {;");
    // At least one finding should have location info
    const withLocation = output.findings.filter((f) => f.location !== undefined);
    expect(withLocation.length).toBeGreaterThan(0);
    const loc = withLocation[0]?.location;
    if (loc) {
      expect(loc.line).toBeGreaterThanOrEqual(1);
      expect(loc.column).toBeGreaterThanOrEqual(1);
    }
  });

  test("infers tsx language for .tsx filename", () => {
    const output = parseCode("const x = <div />;", "input.tsx");
    // JSX in TSX file should not produce parse errors
    expect(output.hasErrors).toBe(false);
  });

  test("infers jsx language for .jsx filename", () => {
    const output = parseCode("const x = <div />;", "input.jsx");
    expect(output.hasErrors).toBe(false);
  });

  test("defaults to ts for unknown extensions", () => {
    const output = parseCode("const x: string = 'hello';", "block-0.ts");
    expect(output.hasErrors).toBe(false);
  });

  test("parse error message includes error detail", () => {
    const output = parseCode("const x = {;");
    expect(output.findings.length).toBeGreaterThan(0);
    const msg = output.findings[0]?.message;
    expect(typeof msg).toBe("string");
    expect((msg ?? "").startsWith("Parse error:")).toBe(true);
  });

  test("handles empty string without errors", () => {
    const output = parseCode("");
    expect(output.hasErrors).toBe(false);
    expect(output.findings).toHaveLength(0);
  });
});
