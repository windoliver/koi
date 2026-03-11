import { describe, expect, test } from "bun:test";
import { commandsToSelectItems, DEFAULT_COMMANDS } from "./command-palette.js";

describe("DEFAULT_COMMANDS", () => {
  test("has all expected commands", () => {
    const ids = DEFAULT_COMMANDS.map((c) => c.id);
    expect(ids).toContain("refresh");
    expect(ids).toContain("agents");
    expect(ids).toContain("attach");
    expect(ids).toContain("dispatch");
    expect(ids).toContain("quit");
    expect(ids).toContain("terminate");
    expect(ids).toContain("open-browser");
  });

  test("all commands have required fields", () => {
    for (const cmd of DEFAULT_COMMANDS) {
      expect(typeof cmd.id).toBe("string");
      expect(cmd.id.length).toBeGreaterThan(0);
      expect(typeof cmd.label).toBe("string");
      expect(typeof cmd.description).toBe("string");
    }
  });

  test("refresh has Ctrl+R shortcut", () => {
    const refresh = DEFAULT_COMMANDS.find((c) => c.id === "refresh");
    expect(refresh?.shortcut).toBe("Ctrl+R");
  });
});

describe("commandsToSelectItems", () => {
  test("converts commands to select items", () => {
    const items = commandsToSelectItems(DEFAULT_COMMANDS);
    expect(items.length).toBe(DEFAULT_COMMANDS.length);
    for (const item of items) {
      expect(typeof item.value).toBe("string");
      expect(typeof item.label).toBe("string");
      expect(typeof item.description).toBe("string");
    }
  });

  test("includes shortcut in description when present", () => {
    const items = commandsToSelectItems(DEFAULT_COMMANDS);
    const refresh = items.find((i) => i.value === "refresh");
    expect(refresh?.description).toContain("Ctrl+R");
  });

  test("no shortcut suffix when absent", () => {
    const items = commandsToSelectItems([
      { id: "test", label: "/test", description: "A test command" },
    ]);
    expect(items[0]?.description).toBe("A test command");
  });
});
