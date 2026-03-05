import { describe, expect, test } from "bun:test";
import type { UserSnapshot } from "@koi/core/user-model";
import { createSnapshotCache } from "./snapshot-cache.js";

function createSnapshot(ambiguous: boolean = false): UserSnapshot {
  return {
    preferences: [{ content: "pref1", score: 0.9 }],
    state: {},
    ambiguityDetected: ambiguous,
  };
}

describe("createSnapshotCache", () => {
  test("first call returns undefined", () => {
    const cache = createSnapshotCache();
    expect(cache.get()).toBeUndefined();
  });

  test("returns cached value on second call", () => {
    const cache = createSnapshotCache();
    const snapshot = createSnapshot();
    cache.set(snapshot);
    expect(cache.get()).toBe(snapshot);
  });

  test("invalidate clears the cache", () => {
    const cache = createSnapshotCache();
    cache.set(createSnapshot());
    cache.invalidate();
    expect(cache.get()).toBeUndefined();
  });

  test("set overwrites previous value", () => {
    const cache = createSnapshotCache();
    const first = createSnapshot(false);
    const second = createSnapshot(true);
    cache.set(first);
    cache.set(second);
    expect(cache.get()).toBe(second);
  });
});
