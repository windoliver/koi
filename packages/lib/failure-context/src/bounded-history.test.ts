import { describe, expect, test } from "bun:test";
import { trimToRecent } from "./bounded-history.js";

describe("trimToRecent", () => {
  test("returns original array when empty", () => {
    const records: readonly number[] = [];
    const result = trimToRecent(records, 5);
    expect(result).toBe(records);
  });

  test("returns original array when within bounds", () => {
    const records = [1, 2, 3] as const;
    const result = trimToRecent(records, 5);
    expect(result).toBe(records);
  });

  test("returns original array when exactly at maxSize", () => {
    const records = [1, 2, 3] as const;
    const result = trimToRecent(records, 3);
    expect(result).toBe(records);
  });

  test("trims to most recent entries when over bounds", () => {
    const records = [1, 2, 3, 4, 5];
    const result = trimToRecent(records, 3);
    expect(result).toEqual([3, 4, 5]);
  });

  test("returns new array when trimmed", () => {
    const records = [1, 2, 3, 4, 5];
    const result = trimToRecent(records, 3);
    expect(result).not.toBe(records);
  });

  test("works with maxSize=1", () => {
    const records = ["a", "b", "c"];
    const result = trimToRecent(records, 1);
    expect(result).toEqual(["c"]);
  });

  test("works with objects", () => {
    const records = [
      { timestamp: 100, kind: "a" },
      { timestamp: 200, kind: "b" },
      { timestamp: 300, kind: "c" },
    ];
    const result = trimToRecent(records, 2);
    expect(result).toEqual([
      { timestamp: 200, kind: "b" },
      { timestamp: 300, kind: "c" },
    ]);
  });
});
