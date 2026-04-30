import { describe, expect, test } from "bun:test";
import { isWithinReplayWindow } from "./replay.js";

describe("isWithinReplayWindow", () => {
  test("accepts timestamps inside the window", () => {
    expect(isWithinReplayWindow(1000, 1100, 300)).toBe(true);
    expect(isWithinReplayWindow(1000, 900, 300)).toBe(true);
  });

  test("rejects timestamps outside the window", () => {
    expect(isWithinReplayWindow(1000, 1301, 300)).toBe(false);
    expect(isWithinReplayWindow(1000, 699, 300)).toBe(false);
  });

  test("rejects non-numeric timestamps", () => {
    expect(isWithinReplayWindow(1000, NaN, 300)).toBe(false);
    expect(isWithinReplayWindow(1000, Infinity, 300)).toBe(false);
  });

  test("treats negative drift symmetrically", () => {
    expect(isWithinReplayWindow(1000, 1000 - 300, 300)).toBe(true);
    expect(isWithinReplayWindow(1000, 1000 + 300, 300)).toBe(true);
    expect(isWithinReplayWindow(1000, 1000 - 301, 300)).toBe(false);
  });
});
