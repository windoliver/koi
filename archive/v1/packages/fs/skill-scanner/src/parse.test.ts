import { describe, expect, test } from "bun:test";
import { parseCode } from "./parse.js";

describe("parseCode", () => {
  test("parses valid JavaScript", () => {
    const result = parseCode("const x = 1;", "input.js");
    expect(result.hasErrors).toBe(false);
    expect(result.findings).toHaveLength(0);
    expect(result.program.type).toBe("Program");
    expect(result.program.body.length).toBeGreaterThan(0);
  });

  test("parses valid TypeScript", () => {
    const result = parseCode("const x: number = 1;", "input.ts");
    expect(result.hasErrors).toBe(false);
    expect(result.findings).toHaveLength(0);
  });

  test("returns findings for parse errors", () => {
    const result = parseCode("const x = {;", "input.js");
    expect(result.hasErrors).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0]?.category).toBe("UNPARSEABLE");
    expect(result.findings[0]?.severity).toBe("HIGH");
    expect(result.findings[0]?.confidence).toBe(1.0);
  });

  test("still returns program node on parse errors", () => {
    const result = parseCode("const x = 1;\nconst y = {;", "input.js");
    expect(result.hasErrors).toBe(true);
    expect(result.program.type).toBe("Program");
    // oxc-parser is error-tolerant and returns a Program node regardless
    expect(result.program).toBeDefined();
  });

  test("handles empty string gracefully", () => {
    const result = parseCode("", "input.ts");
    expect(result.hasErrors).toBe(false);
    expect(result.findings).toHaveLength(0);
    expect(result.program.type).toBe("Program");
  });

  test("defaults to .ts when no filename specified", () => {
    const result = parseCode('const x: string = "hello";');
    expect(result.hasErrors).toBe(false);
  });

  test("infers .tsx for .tsx files", () => {
    const result = parseCode("const el = <div>hello</div>;", "input.tsx");
    expect(result.hasErrors).toBe(false);
  });

  test("includes location info in parse error findings", () => {
    const result = parseCode("const x = {;", "input.js");
    expect(result.findings.length).toBeGreaterThan(0);
    const finding = result.findings[0] ?? undefined;
    if (finding === undefined) throw new Error("Expected at least one finding");
    expect(finding.location).toBeDefined();
    expect(finding.location?.line).toBeGreaterThanOrEqual(1);
  });
});
