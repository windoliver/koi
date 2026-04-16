import { describe, expect, test } from "bun:test";
import { COMMAND_DEFINITIONS, filterCommands } from "./command-definitions.js";

// ---------------------------------------------------------------------------
// COMMAND_DEFINITIONS sanity checks
// ---------------------------------------------------------------------------

describe("COMMAND_DEFINITIONS", () => {
  test("has exactly 21 commands", () => {
    expect(COMMAND_DEFINITIONS).toHaveLength(21);
  });

  test("all command ids are unique", () => {
    const ids = COMMAND_DEFINITIONS.map((c) => c.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  test("all commands have non-empty label and description", () => {
    for (const cmd of COMMAND_DEFINITIONS) {
      expect(cmd.label.length).toBeGreaterThan(0);
      expect(cmd.description.length).toBeGreaterThan(0);
    }
  });

  test("all categories are valid", () => {
    const valid = new Set(["navigation", "agent", "session", "system"]);
    for (const cmd of COMMAND_DEFINITIONS) {
      expect(valid.has(cmd.category)).toBe(true);
    }
  });

  test("agent:rewind is registered as a destructive agent command", () => {
    // /rewind ships in #1625 — verify it's wired into the palette so the
    // CLI's onCommand switch can dispatch it.
    const rewind = COMMAND_DEFINITIONS.find((c) => c.id === "agent:rewind");
    expect(rewind).toBeDefined();
    if (rewind === undefined) return;
    expect(rewind.category).toBe("agent");
    expect(rewind.destructive).toBe(true);
    expect(rewind.label).toBe("Rewind");
  });
});

// ---------------------------------------------------------------------------
// filterCommands — progressive disclosure
// ---------------------------------------------------------------------------

describe("filterCommands", () => {
  test("sessionCount = 0: returns commands with no minSessionCount", () => {
    const result = filterCommands(COMMAND_DEFINITIONS, 0);
    // All commands without minSessionCount should appear
    const alwaysVisible = COMMAND_DEFINITIONS.filter((c) => c.minSessionCount === undefined);
    for (const cmd of alwaysVisible) {
      expect(result.some((r) => r.id === cmd.id)).toBe(true);
    }
  });

  test("sessionCount = 0: hides commands with minSessionCount > 0", () => {
    const result = filterCommands(COMMAND_DEFINITIONS, 0);
    const hidden = COMMAND_DEFINITIONS.filter(
      (c) => c.minSessionCount !== undefined && c.minSessionCount > 0,
    );
    for (const cmd of hidden) {
      expect(result.some((r) => r.id === cmd.id)).toBe(false);
    }
  });

  test("sessionCount at threshold: reveals command at exact threshold", () => {
    // session:rename has minSessionCount: 1
    const atOne = filterCommands(COMMAND_DEFINITIONS, 1);
    expect(atOne.some((c) => c.id === "session:rename")).toBe(true);
  });

  test("sessionCount below threshold: hides command", () => {
    // session:export has minSessionCount: 3
    const atTwo = filterCommands(COMMAND_DEFINITIONS, 2);
    expect(atTwo.some((c) => c.id === "session:export")).toBe(false);
  });

  test("sessionCount above threshold: reveals command", () => {
    const atFive = filterCommands(COMMAND_DEFINITIONS, 5);
    expect(atFive.some((c) => c.id === "session:export")).toBe(true);
  });

  test("sessionCount = 100: all commands visible", () => {
    const result = filterCommands(COMMAND_DEFINITIONS, 100);
    expect(result).toHaveLength(COMMAND_DEFINITIONS.length);
  });

  test("empty commands array returns empty array", () => {
    expect(filterCommands([], 10)).toHaveLength(0);
  });

  test("does not mutate input array", () => {
    const copy = [...COMMAND_DEFINITIONS];
    filterCommands(COMMAND_DEFINITIONS, 0);
    expect(COMMAND_DEFINITIONS).toEqual(copy);
  });
});
