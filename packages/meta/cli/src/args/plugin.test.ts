import { describe, expect, test } from "bun:test";
import { isPluginFlags, parsePluginFlags } from "./plugin.js";
import { ParseError } from "./shared.js";

const GLOBAL = { version: false, help: false } as const;

describe("parsePluginFlags", () => {
  test("parses install subcommand", () => {
    const flags = parsePluginFlags(["install", "./my-plugin"], GLOBAL);
    expect(flags.subcommand).toBe("install");
    expect(flags.path).toBe("./my-plugin");
    expect(flags.name).toBeUndefined();
  });

  test("parses remove subcommand", () => {
    const flags = parsePluginFlags(["remove", "my-plugin"], GLOBAL);
    expect(flags.subcommand).toBe("remove");
    expect(flags.name).toBe("my-plugin");
  });

  test("parses enable subcommand", () => {
    const flags = parsePluginFlags(["enable", "my-plugin"], GLOBAL);
    expect(flags.subcommand).toBe("enable");
    expect(flags.name).toBe("my-plugin");
  });

  test("parses disable subcommand", () => {
    const flags = parsePluginFlags(["disable", "my-plugin"], GLOBAL);
    expect(flags.subcommand).toBe("disable");
    expect(flags.name).toBe("my-plugin");
  });

  test("parses update subcommand with name and path", () => {
    const flags = parsePluginFlags(["update", "my-plugin", "./new-version"], GLOBAL);
    expect(flags.subcommand).toBe("update");
    expect(flags.name).toBe("my-plugin");
    expect(flags.path).toBe("./new-version");
  });

  test("parses list subcommand", () => {
    const flags = parsePluginFlags(["list"], GLOBAL);
    expect(flags.subcommand).toBe("list");
  });

  test("parses list with --json flag", () => {
    const flags = parsePluginFlags(["list", "--json"], GLOBAL);
    expect(flags.subcommand).toBe("list");
    expect(flags.json).toBe(true);
  });

  test("throws ParseError for missing subcommand", () => {
    expect(() => parsePluginFlags([], GLOBAL)).toThrow(ParseError);
  });

  test("throws ParseError for unknown subcommand", () => {
    expect(() => parsePluginFlags(["bogus"], GLOBAL)).toThrow(ParseError);
  });
});

describe("isPluginFlags", () => {
  test("returns true for plugin flags", () => {
    const flags = parsePluginFlags(["list"], GLOBAL);
    expect(isPluginFlags(flags)).toBe(true);
  });

  test("returns false for non-plugin flags", () => {
    expect(isPluginFlags({ command: "start", version: false, help: false })).toBe(false);
  });
});
