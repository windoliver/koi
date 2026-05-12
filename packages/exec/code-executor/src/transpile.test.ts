import { describe, expect, test } from "bun:test";
import { transpileTs } from "./transpile.js";

describe("transpileTs", () => {
  test("strips type annotations from TypeScript", () => {
    const result = transpileTs("const x: number = 1; export {};");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.code).toContain("const x = 1");
    expect(result.code).not.toContain(": number");
  });

  test("returns ok=false for syntactically invalid input", () => {
    const result = transpileTs("const x: = ;");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.length).toBeGreaterThan(0);
  });
});
