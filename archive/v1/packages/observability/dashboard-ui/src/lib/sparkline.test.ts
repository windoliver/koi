import { describe, expect, test } from "bun:test";
import { sparkline } from "./sparkline.js";

describe("sparkline", () => {
  test("empty array returns empty string", () => {
    expect(sparkline([])).toBe("");
  });

  test("single value returns single character", () => {
    const result = sparkline([42]);
    expect(result).toHaveLength(1);
  });

  test("all same values returns uniform characters", () => {
    const result = sparkline([5, 5, 5, 5]);
    const chars = new Set(result.split(""));
    expect(chars.size).toBe(1);
  });

  test("ascending values produce ascending blocks", () => {
    const result = sparkline([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(result).toBe("▁▂▃▄▅▆▇█");
  });

  test("two values produce min and max chars", () => {
    const result = sparkline([0, 100]);
    expect(result).toBe("▁█");
  });

  test("length matches input length", () => {
    const values = [10, 20, 30, 40, 50];
    expect(sparkline(values)).toHaveLength(5);
  });
});
