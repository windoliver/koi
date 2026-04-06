/**
 * spawn-fork — unit tests for fork recursion guard and maxTurns default.
 *
 * Tests the applyForkDenylist() and applyForkMaxTurns() pure helpers directly.
 * These helpers are the sole enforcement mechanism for:
 *   - Recursion guard: fork children cannot call agent_spawn
 *   - Turn cap: fork children default to DEFAULT_FORK_MAX_TURNS when maxTurns is unset
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_FORK_MAX_TURNS } from "@koi/core";
import { applyForkDenylist, applyForkMaxTurns } from "../spawn-child.js";

// applyForkDenylist operates on a DENYLIST (set of tool names to exclude from the child).
// Adding agent_spawn to the denylist means the child cannot use it — the recursion guard.

describe("applyForkDenylist", () => {
  test("adds agent_spawn to denylist for fork children (blocks recursive forks)", () => {
    // Base denylist has no entry for agent_spawn — it would normally be inherited
    const base = new Set<string>(["some_tool"]);
    const result = applyForkDenylist(base, true);
    expect(result.has("agent_spawn")).toBe(true); // now denied → cannot be inherited
    expect(result.has("some_tool")).toBe(true); // original denies preserved
  });

  test("does not add agent_spawn to denylist for regular (non-fork) spawns", () => {
    const base = new Set<string>(["some_tool"]);
    const result = applyForkDenylist(base, false);
    expect(result.has("agent_spawn")).toBe(false); // not denied → can be inherited
    expect(result.has("some_tool")).toBe(true);
  });

  test("preserves existing denylist entries alongside the fork guard", () => {
    // Base denylist already denies shell_exec and file_write
    const base = new Set<string>(["shell_exec", "file_write"]);
    const result = applyForkDenylist(base, true);
    expect(result.has("agent_spawn")).toBe(true); // guard added
    expect(result.has("shell_exec")).toBe(true); // original preserved
    expect(result.has("file_write")).toBe(true); // original preserved
  });

  test("is idempotent when agent_spawn is already in the denylist", () => {
    // If the caller already denied agent_spawn, adding it again is a no-op
    const base = new Set<string>(["agent_spawn", "task_list"]);
    const result = applyForkDenylist(base, true);
    expect(result.has("agent_spawn")).toBe(true);
    expect([...result].filter((t) => t === "agent_spawn").length).toBe(1); // only once
  });

  test("does not mutate the input set", () => {
    const base = new Set<string>(["task_list"]);
    const before = new Set(base);
    applyForkDenylist(base, true);
    expect(base).toEqual(before);
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
