import { describe, expect, test } from "bun:test";
import { isPluginFlags, parsePluginFlags } from "./plugin.js";
import { ParseError } from "./shared.js";

describe("parsePluginFlags", () => {
  test("parses install subcommand", () => {
    const flags = parsePluginFlags(["install", "./my-plugin"]);
    expect(flags.subcommand).toBe("install");
    expect(flags.path).toBe("./my-plugin");
    expect(flags.name).toBeUndefined();
  });

  test("parses remove subcommand", () => {
    const flags = parsePluginFlags(["remove", "my-plugin"]);
    expect(flags.subcommand).toBe("remove");
    expect(flags.name).toBe("my-plugin");
  });

  test("parses enable subcommand", () => {
    const flags = parsePluginFlags(["enable", "my-plugin"]);
    expect(flags.subcommand).toBe("enable");
    expect(flags.name).toBe("my-plugin");
  });

  test("parses disable subcommand", () => {
    const flags = parsePluginFlags(["disable", "my-plugin"]);
    expect(flags.subcommand).toBe("disable");
    expect(flags.name).toBe("my-plugin");
  });

  test("parses update subcommand with name and path", () => {
    const flags = parsePluginFlags(["update", "my-plugin", "./new-version"]);
    expect(flags.subcommand).toBe("update");
    expect(flags.name).toBe("my-plugin");
    expect(flags.path).toBe("./new-version");
  });

  test("parses list subcommand", () => {
    const flags = parsePluginFlags(["list"]);
    expect(flags.subcommand).toBe("list");
  });

  test("parses list with --json flag", () => {
    const flags = parsePluginFlags(["list", "--json"]);
    expect(flags.subcommand).toBe("list");
    expect(flags.json).toBe(true);
  });

  test("throws ParseError for missing subcommand", () => {
    expect(() => parsePluginFlags([])).toThrow(ParseError);
  });

  test("throws ParseError for unknown subcommand", () => {
    expect(() => parsePluginFlags(["bogus"])).toThrow(ParseError);
  });
});

describe("isPluginFlags", () => {
  test("returns true for plugin flags", () => {
    const flags = parsePluginFlags(["list"]);
    expect(isPluginFlags(flags)).toBe(true);
  });

  test("returns false for non-plugin flags", () => {
    expect(isPluginFlags({ command: "start", version: false, help: false })).toBe(false);
  });
});
