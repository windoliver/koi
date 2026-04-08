import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DOOM_LOOP_THRESHOLD,
  DEFAULT_MAX_DOOM_LOOP_INTERVENTIONS,
  parseDoomLoopKey,
  partitionDoomLoopKeys,
  updateStreaks,
} from "./doom-loop.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  test("DEFAULT_DOOM_LOOP_THRESHOLD is 3", () => {
    expect(DEFAULT_DOOM_LOOP_THRESHOLD).toBe(3);
  });

  test("DEFAULT_MAX_DOOM_LOOP_INTERVENTIONS is 2", () => {
    expect(DEFAULT_MAX_DOOM_LOOP_INTERVENTIONS).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// partitionDoomLoopKeys
// ---------------------------------------------------------------------------

describe("partitionDoomLoopKeys", () => {
  const keyA = 'readFile\0{"path":"/foo"}';
  const keyB = 'writeFile\0{"path":"/bar"}';

  test("returns no repeated when streaks map is empty", () => {
    const result = partitionDoomLoopKeys(new Map(), [keyA], 3);
    expect(result.hasRepeated).toBe(false);
    expect(result.allRepeated).toBe(false);
    expect(result.repeatedKeys.size).toBe(0);
  });

  test("returns no repeated when currentKeys is empty", () => {
    const streaks = new Map([[keyA, 5]]);
    const result = partitionDoomLoopKeys(streaks, [], 3);
    expect(result.hasRepeated).toBe(false);
  });

  test("returns no repeated when streak is below threshold", () => {
    const streaks = new Map([[keyA, 2]]);
    const result = partitionDoomLoopKeys(streaks, [keyA], 3);
    expect(result.hasRepeated).toBe(false);
  });

  test("marks key as repeated when streak reaches threshold", () => {
    const streaks = new Map([[keyA, 3]]);
    const result = partitionDoomLoopKeys(streaks, [keyA], 3);
    expect(result.hasRepeated).toBe(true);
    expect(result.allRepeated).toBe(true);
    expect(result.repeatedKeys.has(keyA)).toBe(true);
  });

  test("marks key as repeated when streak exceeds threshold", () => {
    const streaks = new Map([[keyA, 5]]);
    const result = partitionDoomLoopKeys(streaks, [keyA], 3);
    expect(result.hasRepeated).toBe(true);
    expect(result.allRepeated).toBe(true);
  });

  test("allRepeated is true when all keys exceed threshold", () => {
    const streaks = new Map([
      [keyA, 3],
      [keyB, 4],
    ]);
    const result = partitionDoomLoopKeys(streaks, [keyA, keyB], 3);
    expect(result.hasRepeated).toBe(true);
    expect(result.allRepeated).toBe(true);
    expect(result.repeatedKeys.size).toBe(2);
  });

  test("returns no repeated with threshold < 2 (disabled)", () => {
    const streaks = new Map([[keyA, 100]]);
    expect(partitionDoomLoopKeys(streaks, [keyA], 0).hasRepeated).toBe(false);
    expect(partitionDoomLoopKeys(streaks, [keyA], 1).hasRepeated).toBe(false);
  });

  test("ignores keys not in currentKeys", () => {
    const streaks = new Map([[keyA, 10]]);
    const result = partitionDoomLoopKeys(streaks, [keyB], 3);
    expect(result.hasRepeated).toBe(false);
  });

  test("mixed turn: one repeated, one new → hasRepeated but not allRepeated", () => {
    const streaks = new Map([[keyA, 5]]);
    const result = partitionDoomLoopKeys(streaks, [keyA, keyB], 3);
    expect(result.hasRepeated).toBe(true);
    expect(result.allRepeated).toBe(false);
    expect(result.repeatedKeys.has(keyA)).toBe(true);
    expect(result.repeatedKeys.has(keyB)).toBe(false);
  });

  test("mixed turn: one exceeds threshold, one below → partial", () => {
    const streaks = new Map([
      [keyA, 3],
      [keyB, 1],
    ]);
    const result = partitionDoomLoopKeys(streaks, [keyA, keyB], 3);
    expect(result.hasRepeated).toBe(true);
    expect(result.allRepeated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// updateStreaks
// ---------------------------------------------------------------------------

describe("updateStreaks", () => {
  const keyA = "tool_a\0{}";
  const keyB = "tool_b\0{}";

  test("increments present keys from zero", () => {
    const result = updateStreaks(new Map(), [keyA]);
    expect(result.get(keyA)).toBe(1);
  });

  test("increments existing keys", () => {
    const result = updateStreaks(new Map([[keyA, 2]]), [keyA]);
    expect(result.get(keyA)).toBe(3);
  });

  test("drops absent keys (streak broken)", () => {
    const result = updateStreaks(new Map([[keyA, 5]]), [keyB]);
    expect(result.has(keyA)).toBe(false);
    expect(result.get(keyB)).toBe(1);
  });

  test("handles multiple keys per turn", () => {
    const prev = new Map([
      [keyA, 2],
      [keyB, 1],
    ]);
    const result = updateStreaks(prev, [keyA, keyB]);
    expect(result.get(keyA)).toBe(3);
    expect(result.get(keyB)).toBe(2);
  });

  test("returns empty map for empty currentKeys", () => {
    const result = updateStreaks(new Map([[keyA, 5]]), []);
    expect(result.size).toBe(0);
  });

  test("does not mutate input map", () => {
    const input = new Map([[keyA, 2]]);
    updateStreaks(input, [keyA]);
    expect(input.get(keyA)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// parseDoomLoopKey
// ---------------------------------------------------------------------------

describe("parseDoomLoopKey", () => {
  test("splits on first null byte", () => {
    const result = parseDoomLoopKey('readFile\0{"path":"/foo"}');
    expect(result.toolName).toBe("readFile");
    expect(result.canonicalArgs).toBe('{"path":"/foo"}');
  });

  test("handles key with no null byte", () => {
    const result = parseDoomLoopKey("readFile");
    expect(result.toolName).toBe("readFile");
    expect(result.canonicalArgs).toBe("");
  });

  test("handles key with multiple null bytes (splits on first)", () => {
    const result = parseDoomLoopKey("tool\0arg1\0arg2");
    expect(result.toolName).toBe("tool");
    expect(result.canonicalArgs).toBe("arg1\0arg2");
  });

  test("handles empty string", () => {
    const result = parseDoomLoopKey("");
    expect(result.toolName).toBe("");
    expect(result.canonicalArgs).toBe("");
  });
});
