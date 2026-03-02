import { describe, expect, test } from "bun:test";
import type { MemoryResult } from "@koi/core/ecs";
import { createPreferenceCache } from "./preference-cache.js";

describe("createPreferenceCache", () => {
  test("initially returns undefined", () => {
    const cache = createPreferenceCache();
    expect(cache.get()).toBeUndefined();
  });

  test("returns cached value after set", () => {
    const cache = createPreferenceCache();
    const prefs: readonly MemoryResult[] = [{ content: "dark mode", score: 0.9 }];
    cache.set(prefs);
    expect(cache.get()).toEqual(prefs);
  });

  test("returns undefined after invalidate", () => {
    const cache = createPreferenceCache();
    cache.set([{ content: "dark mode", score: 0.9 }]);
    cache.invalidate();
    expect(cache.get()).toBeUndefined();
  });

  test("returns latest value after multiple sets", () => {
    const cache = createPreferenceCache();
    cache.set([{ content: "first", score: 0.5 }]);
    const latest: readonly MemoryResult[] = [{ content: "second", score: 0.8 }];
    cache.set(latest);
    expect(cache.get()).toEqual(latest);
  });

  test("can set again after invalidate", () => {
    const cache = createPreferenceCache();
    cache.set([{ content: "first" }]);
    cache.invalidate();
    const newPrefs: readonly MemoryResult[] = [{ content: "after-invalidate" }];
    cache.set(newPrefs);
    expect(cache.get()).toEqual(newPrefs);
  });
});
