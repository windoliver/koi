import { describe, expect, test } from "bun:test";
import { deriveBasenames } from "./derive-basenames.js";

describe("deriveBasenames", () => {
  test("prefixes each src basename", () => {
    const result = deriveBasenames("out", ["a", "b/c"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.paths).toEqual(["out/a", "out/c"]);
  });

  test("strips trailing slash on src basename", () => {
    const result = deriveBasenames("out", ["src/"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.paths).toEqual(["out/src"]);
  });

  test("refuses on / src", () => {
    const result = deriveBasenames("out", ["/"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/basename for src '\/'/);
  });

  test("refuses on empty src", () => {
    const result = deriveBasenames("out", [""]);
    expect(result.ok).toBe(false);
  });

  test("returns first-failure detail for multiple bad srcs", () => {
    const result = deriveBasenames("out", ["a", "/", "b"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("'/'");
  });

  test("empty srcs returns empty paths", () => {
    const result = deriveBasenames("out", []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.paths).toEqual([]);
  });
});
