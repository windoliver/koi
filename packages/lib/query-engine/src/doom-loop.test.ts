import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DOOM_LOOP_THRESHOLD,
  DEFAULT_MAX_DOOM_LOOP_INTERVENTIONS,
  detectDoomLoop,
  parseDoomLoopKey,
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
// detectDoomLoop
// ---------------------------------------------------------------------------

describe("detectDoomLoop", () => {
  const keyA = 'readFile\0{"path":"/foo"}';
  const keyB = 'writeFile\0{"path":"/bar"}';

  test("returns null when streaks map is empty", () => {
    expect(detectDoomLoop(new Map(), [keyA], 3)).toBeNull();
  });

  test("returns null when currentKeys is empty", () => {
    const streaks = new Map([[keyA, 5]]);
    expect(detectDoomLoop(streaks, [], 3)).toBeNull();
  });

  test("returns null when streak is below threshold", () => {
    const streaks = new Map([[keyA, 2]]);
    expect(detectDoomLoop(streaks, [keyA], 3)).toBeNull();
  });

  test("returns key when streak reaches threshold", () => {
    const streaks = new Map([[keyA, 3]]);
    expect(detectDoomLoop(streaks, [keyA], 3)).toBe(keyA);
  });

  test("returns key when streak exceeds threshold", () => {
    const streaks = new Map([[keyA, 5]]);
    expect(detectDoomLoop(streaks, [keyA], 3)).toBe(keyA);
  });

  test("returns first matching key when multiple exceed threshold", () => {
    const streaks = new Map([
      [keyA, 3],
      [keyB, 4],
    ]);
    const result = detectDoomLoop(streaks, [keyA, keyB], 3);
    expect(result).toBe(keyA);
  });

  test("returns null with threshold < 2 (disabled)", () => {
    const streaks = new Map([[keyA, 100]]);
    expect(detectDoomLoop(streaks, [keyA], 0)).toBeNull();
    expect(detectDoomLoop(streaks, [keyA], 1)).toBeNull();
  });

  test("ignores keys not in currentKeys", () => {
    const streaks = new Map([[keyA, 10]]);
    expect(detectDoomLoop(streaks, [keyB], 3)).toBeNull();
  });

  test("returns null when one key is repeated but another is new (mixed progress)", () => {
    const streaks = new Map([[keyA, 5]]);
    // keyA is repeated but keyB is new → model is making progress
    expect(detectDoomLoop(streaks, [keyA, keyB], 3)).toBeNull();
  });

  test("returns null when only some keys exceed threshold in mixed turn", () => {
    const streaks = new Map([
      [keyA, 3],
      [keyB, 1],
    ]);
    // keyA exceeds threshold but keyB does not → model is making progress
    expect(detectDoomLoop(streaks, [keyA, keyB], 3)).toBeNull();
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
