import { describe, expect, test } from "bun:test";
import type { TuiCapabilities } from "../state/domain-types.js";
import {
  commandsToSelectItems,
  DEFAULT_COMMANDS,
  filterCommandsByCapabilities,
} from "./command-palette.js";

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

describe("filterCommandsByCapabilities", () => {
  const ALL_CAPS: TuiCapabilities = {
    temporal: true,
    scheduler: true,
    taskboard: true,
    harness: true,
    forge: true,
    gateway: true,
    nexus: true,
    governance: true,
  };

  const NO_CAPS: TuiCapabilities = {
    temporal: false,
    scheduler: false,
    taskboard: false,
    harness: false,
    forge: false,
    gateway: false,
    nexus: false,
    governance: false,
  };

  test("returns all commands when all capabilities present", () => {
    const filtered = filterCommandsByCapabilities(DEFAULT_COMMANDS, ALL_CAPS);
    expect(filtered.length).toBe(DEFAULT_COMMANDS.length);
  });

  test("hides commands requiring missing capabilities", () => {
    const filtered = filterCommandsByCapabilities(DEFAULT_COMMANDS, NO_CAPS);
    const ids = filtered.map((c) => c.id);
    expect(ids).not.toContain("temporal");
    expect(ids).not.toContain("scheduler");
    expect(ids).not.toContain("taskboard");
    expect(ids).not.toContain("harness");
    expect(ids).not.toContain("governance");
  });

  test("keeps commands without requiredCapability", () => {
    const filtered = filterCommandsByCapabilities(DEFAULT_COMMANDS, NO_CAPS);
    const ids = filtered.map((c) => c.id);
    expect(ids).toContain("refresh");
    expect(ids).toContain("agents");
    expect(ids).toContain("quit");
    expect(ids).toContain("skills");
  });

  test("hides all capability-gated commands when capabilities null", () => {
    const filtered = filterCommandsByCapabilities(DEFAULT_COMMANDS, null);
    const ids = filtered.map((c) => c.id);
    expect(ids).not.toContain("temporal");
    expect(ids).not.toContain("governance");
    // Non-gated commands still present
    expect(ids).toContain("refresh");
  });

  test("filters selectively based on individual capabilities", () => {
    const partial: TuiCapabilities = { ...NO_CAPS, temporal: true };
    const filtered = filterCommandsByCapabilities(DEFAULT_COMMANDS, partial);
    const ids = filtered.map((c) => c.id);
    expect(ids).toContain("temporal");
    expect(ids).not.toContain("scheduler");
  });
});

describe("shortcut consistency", () => {
  test("no duplicate shortcuts across commands", () => {
    const shortcuts = DEFAULT_COMMANDS.filter((c) => c.shortcut !== undefined).map((c) => ({
      id: c.id,
      shortcut: c.shortcut,
    }));
    const seen = new Map<string, string>();
    for (const { id, shortcut } of shortcuts) {
      const existing = seen.get(shortcut as string);
      if (existing !== undefined) {
        throw new Error(`Shortcut "${shortcut}" is claimed by both "${existing}" and "${id}"`);
      }
      seen.set(shortcut as string, id);
    }
  });

  test("Ctrl+F is only on /files, not /nexus", () => {
    const nexus = DEFAULT_COMMANDS.find((c) => c.id === "nexus");
    const files = DEFAULT_COMMANDS.find((c) => c.id === "files");
    expect(nexus?.shortcut).toBeUndefined();
    expect(files?.shortcut).toBe("Ctrl+F");
  });
});
