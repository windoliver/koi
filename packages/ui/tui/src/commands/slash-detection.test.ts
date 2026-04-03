import { describe, expect, test } from "bun:test";
import {
  detectSlashPrefix,
  matchCommands,
  parseSlashCommand,
  type SlashCommand,
} from "./slash-detection.js";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const COMMANDS: readonly SlashCommand[] = [
  { name: "clear", description: "Clear conversation" },
  { name: "compact", description: "Compact messages" },
  { name: "help", description: "Show help" },
  { name: "sessions", description: "List sessions" },
  { name: "doctor", description: "Run diagnostics" },
  { name: "config", description: "Edit configuration", keybind: "Ctrl+," },
];

// ---------------------------------------------------------------------------
// detectSlashPrefix
// ---------------------------------------------------------------------------

describe("detectSlashPrefix", () => {
  test("returns query for '/' at position 0", () => {
    expect(detectSlashPrefix("/")).toBe("");
  });

  test("returns command name for '/clear'", () => {
    expect(detectSlashPrefix("/clear")).toBe("clear");
  });

  test("returns partial command for '/cl'", () => {
    expect(detectSlashPrefix("/cl")).toBe("cl");
  });

  test("returns command name only (before space) for '/clear all'", () => {
    expect(detectSlashPrefix("/clear all")).toBe("clear");
  });

  test("returns null for empty input", () => {
    expect(detectSlashPrefix("")).toBeNull();
  });

  test("returns null for non-slash input", () => {
    expect(detectSlashPrefix("hello")).toBeNull();
  });

  test("returns null for '/' in middle of text", () => {
    expect(detectSlashPrefix("hello /world")).toBeNull();
  });

  test("returns null for text starting with space then '/'", () => {
    expect(detectSlashPrefix(" /clear")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseSlashCommand
// ---------------------------------------------------------------------------

describe("parseSlashCommand", () => {
  test("parses command without args", () => {
    expect(parseSlashCommand("/clear")).toEqual({ command: "clear", args: "" });
  });

  test("parses command with args", () => {
    expect(parseSlashCommand("/help topics")).toEqual({ command: "help", args: "topics" });
  });

  test("trims args whitespace", () => {
    expect(parseSlashCommand("/config   key=value  ")).toEqual({
      command: "config",
      args: "key=value",
    });
  });

  test("parses bare '/' as empty command", () => {
    expect(parseSlashCommand("/")).toEqual({ command: "", args: "" });
  });

  test("returns null for non-slash input", () => {
    expect(parseSlashCommand("hello")).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(parseSlashCommand("")).toBeNull();
  });

  test("returns null for slash in middle", () => {
    expect(parseSlashCommand("hello /world")).toBeNull();
  });

  test("handles multiple spaces between command and args", () => {
    expect(parseSlashCommand("/help   detailed")).toEqual({
      command: "help",
      args: "detailed",
    });
  });
});

// ---------------------------------------------------------------------------
// matchCommands
// ---------------------------------------------------------------------------

describe("matchCommands", () => {
  test("empty query returns all commands", () => {
    const matches = matchCommands(COMMANDS, "");
    expect(matches).toHaveLength(COMMANDS.length);
    expect(matches.every((m) => !m.exact)).toBe(true);
  });

  test("prefix 'cl' matches 'clear'", () => {
    const matches = matchCommands(COMMANDS, "cl");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.command.name).toBe("clear");
    expect(matches[0]?.exact).toBe(false);
  });

  test("prefix 'c' matches 'clear', 'compact', 'config'", () => {
    const matches = matchCommands(COMMANDS, "c");
    expect(matches).toHaveLength(3);
    const names = matches.map((m) => m.command.name);
    expect(names).toContain("clear");
    expect(names).toContain("compact");
    expect(names).toContain("config");
  });

  test("exact match is marked as exact", () => {
    const matches = matchCommands(COMMANDS, "clear");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.exact).toBe(true);
  });

  test("exact match comes before prefix matches", () => {
    // Add a command that starts with "clear" to test ordering
    const extended: readonly SlashCommand[] = [
      ...COMMANDS,
      { name: "clearall", description: "Clear everything" },
    ];
    const matches = matchCommands(extended, "clear");
    expect(matches).toHaveLength(2);
    expect(matches[0]?.command.name).toBe("clear");
    expect(matches[0]?.exact).toBe(true);
    expect(matches[1]?.command.name).toBe("clearall");
    expect(matches[1]?.exact).toBe(false);
  });

  test("no matches for unknown prefix returns empty array", () => {
    const matches = matchCommands(COMMANDS, "xyz");
    expect(matches).toHaveLength(0);
  });

  test("matching is case-insensitive", () => {
    const matches = matchCommands(COMMANDS, "CL");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.command.name).toBe("clear");
  });

  test("prefix matches are sorted alphabetically", () => {
    const matches = matchCommands(COMMANDS, "co");
    expect(matches).toHaveLength(2);
    expect(matches[0]?.command.name).toBe("compact");
    expect(matches[1]?.command.name).toBe("config");
  });

  test("single-character prefix", () => {
    const matches = matchCommands(COMMANDS, "d");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.command.name).toBe("doctor");
  });

  test("empty commands list returns empty matches", () => {
    const matches = matchCommands([], "help");
    expect(matches).toHaveLength(0);
  });
});
