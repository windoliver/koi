import { describe, expect, test } from "bun:test";
import { interpolate } from "./interpolate.js";

describe("interpolate", () => {
  test("replaces known variables", () => {
    expect(interpolate("Hello {{name}}", { name: "world" })).toBe("Hello world");
  });

  test("replaces multiple variables", () => {
    const result = interpolate("{{a}} and {{b}}", { a: "foo", b: "bar" });
    expect(result).toBe("foo and bar");
  });

  test("produces placeholder for undefined variables", () => {
    expect(interpolate("{{missing}}", {})).toBe("<undefined:missing>");
  });

  test("returns template unchanged when no placeholders", () => {
    expect(interpolate("no vars here", { key: "val" })).toBe("no vars here");
  });

  test("stringifies numeric values", () => {
    expect(interpolate("count: {{n}}", { n: 42 })).toBe("count: 42");
  });

  test("stringifies boolean values", () => {
    expect(interpolate("ok: {{flag}}", { flag: true })).toBe("ok: true");
  });

  test("handles repeated variable", () => {
    expect(interpolate("{{x}} {{x}}", { x: "a" })).toBe("a a");
  });

  test("handles empty template", () => {
    expect(interpolate("", { a: 1 })).toBe("");
  });
});
