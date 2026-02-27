/**
 * Tests for checkpoint timing policy.
 */

import { describe, expect, test } from "bun:test";
import { harnessId } from "@koi/core";
import { computeCheckpointId, shouldSoftCheckpoint } from "./checkpoint-policy.js";

describe("shouldSoftCheckpoint", () => {
  test("returns false for turn 0 (session just started)", () => {
    expect(shouldSoftCheckpoint(0, 5)).toBe(false);
  });

  test("returns true at multiples of interval", () => {
    expect(shouldSoftCheckpoint(5, 5)).toBe(true);
    expect(shouldSoftCheckpoint(10, 5)).toBe(true);
    expect(shouldSoftCheckpoint(15, 5)).toBe(true);
  });

  test("returns false at non-multiples of interval", () => {
    expect(shouldSoftCheckpoint(1, 5)).toBe(false);
    expect(shouldSoftCheckpoint(3, 5)).toBe(false);
    expect(shouldSoftCheckpoint(7, 5)).toBe(false);
  });

  test("returns true every turn when interval is 1", () => {
    expect(shouldSoftCheckpoint(1, 1)).toBe(true);
    expect(shouldSoftCheckpoint(2, 1)).toBe(true);
    expect(shouldSoftCheckpoint(100, 1)).toBe(true);
  });

  test("handles large turn indices", () => {
    expect(shouldSoftCheckpoint(1000, 5)).toBe(true);
    expect(shouldSoftCheckpoint(999, 5)).toBe(false);
  });
});

describe("computeCheckpointId", () => {
  test("produces deterministic checkpoint ID", () => {
    const hid = harnessId("harness-1");
    const a = computeCheckpointId(hid, "session-abc", 5);
    const b = computeCheckpointId(hid, "session-abc", 5);
    expect(a).toBe(b);
  });

  test("encodes harness, session, and turn", () => {
    const hid = harnessId("h-42");
    const result = computeCheckpointId(hid, "s-99", 7);
    expect(result).toBe("h-42:s-99:t7");
  });
});
