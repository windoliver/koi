import { describe, expect, test } from "bun:test";
import { computeDrift } from "./drift-scoring.js";

describe("computeDrift", () => {
  test("returns 0 for empty sourcePatterns", () => {
    expect(computeDrift([], ["src/foo.ts"])).toBe(0);
  });

  test("returns 0 for empty changedFiles", () => {
    expect(computeDrift(["src/**/*.ts"], [])).toBe(0);
  });

  test("returns 0 when both inputs are empty", () => {
    expect(computeDrift([], [])).toBe(0);
  });

  test("returns 0 when no patterns match changed files", () => {
    expect(computeDrift(["packages/pay/**/*.ts"], ["packages/auth/src/login.ts"])).toBe(0);
  });

  test("returns 1.0 when all patterns have matching changes", () => {
    const patterns = ["src/foo.ts", "src/bar.ts"];
    const changed = ["src/foo.ts", "src/bar.ts", "src/baz.ts"];
    expect(computeDrift(patterns, changed)).toBe(1.0);
  });

  test("returns proportional score for partial overlap", () => {
    const patterns = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const changed = ["src/a.ts"];
    expect(computeDrift(patterns, changed)).toBeCloseTo(1 / 3);
  });

  test("handles ** glob pattern matching nested paths", () => {
    const patterns = ["packages/pay/**/*.ts"];
    const changed = ["packages/pay/src/deep/nested/file.ts"];
    expect(computeDrift(patterns, changed)).toBe(1.0);
  });

  test("handles * glob pattern not matching directory separators", () => {
    const patterns = ["src/*.ts"];
    const changed = ["src/nested/foo.ts"];
    expect(computeDrift(patterns, changed)).toBe(0);
  });

  test("handles * glob pattern matching flat files", () => {
    const patterns = ["src/*.ts"];
    const changed = ["src/foo.ts"];
    expect(computeDrift(patterns, changed)).toBe(1.0);
  });

  test("handles ? glob pattern matching single character", () => {
    const patterns = ["src/?.ts"];
    const changed = ["src/a.ts"];
    expect(computeDrift(patterns, changed)).toBe(1.0);
  });

  test("? does not match directory separator", () => {
    const patterns = ["src/?.ts"];
    const changed = ["src/ab.ts"];
    expect(computeDrift(patterns, changed)).toBe(0);
  });

  test("handles exact file path pattern", () => {
    const patterns = ["packages/core/src/engine.ts"];
    const changed = ["packages/core/src/engine.ts"];
    expect(computeDrift(patterns, changed)).toBe(1.0);
  });

  test("exact path does not match different file", () => {
    const patterns = ["packages/core/src/engine.ts"];
    const changed = ["packages/core/src/errors.ts"];
    expect(computeDrift(patterns, changed)).toBe(0);
  });

  test("handles multiple patterns with mixed matches", () => {
    const patterns = ["packages/pay/**", "packages/auth/**", "packages/core/**"];
    const changed = ["packages/pay/src/config.ts", "packages/core/src/types.ts"];
    expect(computeDrift(patterns, changed)).toBeCloseTo(2 / 3);
  });

  test("handles overlapping glob patterns", () => {
    const patterns = ["src/**/*.ts", "src/foo.ts"];
    const changed = ["src/foo.ts"];
    // Both patterns match, so score is 1.0
    expect(computeDrift(patterns, changed)).toBe(1.0);
  });

  test("handles deeply nested paths", () => {
    const patterns = ["packages/**/utils/**/*.ts"];
    const changed = ["packages/forge/src/utils/helpers/format.ts"];
    expect(computeDrift(patterns, changed)).toBe(1.0);
  });

  test("escapes regex special characters in patterns", () => {
    const patterns = ["src/file[1].ts"];
    const changed = ["src/file[1].ts"];
    expect(computeDrift(patterns, changed)).toBe(1.0);
  });
});
