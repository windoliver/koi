import { describe, expect, test } from "bun:test";
import * as api from "../index.js";

describe("@koi/watch-patterns API surface", () => {
  test("exported functions are stable", () => {
    const names = Object.keys(api).sort();
    expect(names).toEqual([
      "compilePatterns",
      "createLineBufferedMatcher",
      "createPendingMatchStore",
    ]);
  });
});
