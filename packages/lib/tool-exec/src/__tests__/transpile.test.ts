import { describe, expect, test } from "bun:test";
import { transpileTs } from "../transpile.js";

describe("transpileTs", () => {
  test("produces an async function expression", () => {
    const out = transpileTs("return 42;");
    expect(out).toMatch(/\(async function\(tools\)/);
  });

  test("strips TypeScript type annotations", () => {
    const out = transpileTs("const x: number = 10; return x;");
    expect(out).not.toContain(": number");
    expect(out).toContain("const x");
    expect(out).toContain("return x");
  });

  test("preserves async/await inside the function body", () => {
    const out = transpileTs("const v = await Promise.resolve(1); return v;");
    expect(out).toContain("await");
    expect(out).toContain("return v");
  });

  test("strips interface declarations", () => {
    const out = transpileTs("interface Foo { bar: string; } const x = { bar: 'hi' }; return x;");
    expect(out).not.toContain("interface");
    expect(out).toContain("const x");
  });

  test("the output is eval-able as a function returning the script value", async () => {
    const out = transpileTs("return 99;");
    // biome-ignore lint/security/noGlobalEval: test verifies eval-able output
    const fn = eval(out) as () => Promise<unknown>;
    const result = await fn();
    expect(result).toBe(99);
  });

  test("plain JavaScript (no types) works identically", async () => {
    const out = transpileTs("const x = 7; return x * 2;");
    // biome-ignore lint/security/noGlobalEval: test verifies eval-able output
    const fn = eval(out) as () => Promise<unknown>;
    const result = await fn();
    expect(result).toBe(14);
  });
});
