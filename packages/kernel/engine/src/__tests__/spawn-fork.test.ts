/**
 * spawn-fork — unit tests for fork inheritance guard and maxTurns default.
 *
 * Tests the applyForkDenylist() and applyForkMaxTurns() pure helpers directly.
 * These helpers are part of the defense-in-depth enforcement for:
 *   - Inheritance guard: fork children cannot INHERIT the parent's Spawn closure
 *   - Turn cap: fork children default to DEFAULT_FORK_MAX_TURNS when maxTurns is unset
 *
 * Fork children CAN spawn via a fresh Spawn provider when `allowNestedSpawn` is set
 * (bounded by the depth guard). applyForkDenylist prevents inheriting the parent's
 * closure-bound Spawn tool, which would mis-attribute nested spawns to the ancestor.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_FORK_MAX_TURNS } from "@koi/core";
import { applyForkDenylist, applyForkMaxTurns } from "../spawn-child.js";

// applyForkDenylist operates on a DENYLIST (set of tool names to exclude from the child).
// Adding "Spawn" to the denylist means the tool cannot be inherited — the recursion guard.

describe("applyForkDenylist", () => {
  test("adds Spawn to denylist for fork children (blocks recursive forks)", () => {
    // Base denylist has no entry for Spawn — it would normally be inherited
    const base = new Set<string>(["some_tool"]);
    const result = applyForkDenylist(base, true);
    expect(result.has("Spawn")).toBe(true); // now denied → cannot be inherited
    expect(result.has("some_tool")).toBe(true); // original denies preserved
  });

  test("does not add Spawn to denylist for regular (non-fork) spawns", () => {
    const base = new Set<string>(["some_tool"]);
    const result = applyForkDenylist(base, false);
    expect(result.has("Spawn")).toBe(false); // not denied → handled by fresh-provider path
    expect(result.has("some_tool")).toBe(true);
  });

  test("preserves existing denylist entries alongside the fork guard", () => {
    // Base denylist already denies shell_exec and file_write
    const base = new Set<string>(["shell_exec", "file_write"]);
    const result = applyForkDenylist(base, true);
    expect(result.has("Spawn")).toBe(true); // guard added
    expect(result.has("shell_exec")).toBe(true); // original preserved
    expect(result.has("file_write")).toBe(true); // original preserved
  });

  test("is idempotent when Spawn is already in the denylist", () => {
    // If the caller already denied Spawn, adding it again is a no-op
    const base = new Set<string>(["Spawn", "task_list"]);
    const result = applyForkDenylist(base, true);
    expect(result.has("Spawn")).toBe(true);
    expect([...result].filter((t) => t === "Spawn").length).toBe(1); // only once
  });

  test("does not mutate the input set", () => {
    const base = new Set<string>(["task_list"]);
    const before = new Set(base);
    applyForkDenylist(base, true);
    expect(base).toEqual(before);
  });

  test("fork children have Spawn denied in inheritance path (prevents parent closure leak)", () => {
    // Fork children CAN spawn via a fresh provider (bounded by depth guard), but they
    // must NOT inherit the parent's closure-bound Spawn tool — that would mis-attribute
    // nested spawns to the ancestor. This test pins the inheritance guard.
    const base = new Set<string>();
    const result = applyForkDenylist(base, true);
    expect(result.has("Spawn")).toBe(true); // inheritance denied; fresh provider still allowed
  });
});

describe("applyForkMaxTurns", () => {
  test("applies DEFAULT_FORK_MAX_TURNS when fork=true and maxTurns is unset", () => {
    const result = applyForkMaxTurns(undefined, true);
    expect(result).toBe(DEFAULT_FORK_MAX_TURNS);
    expect(result).toBe(200);
  });

  test("respects explicit maxTurns over the fork default", () => {
    const result = applyForkMaxTurns(50, true);
    expect(result).toBe(50);
  });

  test("returns undefined for non-fork spawns with no maxTurns", () => {
    const result = applyForkMaxTurns(undefined, false);
    expect(result).toBeUndefined();
  });

  test("returns explicit maxTurns unchanged for non-fork spawns", () => {
    const result = applyForkMaxTurns(100, false);
    expect(result).toBe(100);
  });
});
