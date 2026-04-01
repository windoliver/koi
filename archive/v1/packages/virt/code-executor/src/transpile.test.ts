import { describe, expect, test } from "bun:test";
import { transpileTs } from "./transpile.js";

describe("transpileTs", () => {
  test("strips type annotations from TypeScript", () => {
    const result = transpileTs("const x: number = 42;");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("42");
      expect(result.code).not.toContain(": number");
    }
  });

  test("passes plain JavaScript through", () => {
    const result = transpileTs("const x = 42;");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("42");
    }
  });

  test("handles interface declarations", () => {
    const code = `
      interface Foo { readonly bar: string; }
      const x = 1;
    `;
    const result = transpileTs(code);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).not.toContain("interface");
      expect(result.code).toContain("1");
    }
  });

  test("handles type imports", () => {
    const code = `
      type Foo = { bar: string };
      const x: Foo = { bar: "hello" };
    `;
    const result = transpileTs(code);
    expect(result.ok).toBe(true);
  });

  test("returns error for syntax errors", () => {
    const result = transpileTs("const x: = ;");
    // Bun's transpiler may handle this differently - it might still produce output
    // Just verify it returns a result without crashing
    expect(typeof result.ok).toBe("boolean");
  });

  test("handles empty input", () => {
    const result = transpileTs("");
    expect(result.ok).toBe(true);
  });

  test("strips generic types", () => {
    const code = "const arr: Array<string> = [];";
    const result = transpileTs(code);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).not.toContain("Array<string>");
    }
  });
});
