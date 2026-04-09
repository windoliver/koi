import { describe, expect, test } from "bun:test";
import { isPluginId, pluginId } from "./plugin-id.js";

describe("pluginId", () => {
  test("creates a branded PluginId", () => {
    const id = pluginId("my-plugin");
    expect(id).toBe(pluginId("my-plugin"));
    // Branded type — at runtime it's just a string
    expect(typeof id).toBe("string");
  });
});

describe("isPluginId", () => {
  test("valid kebab-case name returns true", () => {
    expect(isPluginId("my-plugin")).toBe(true);
    expect(isPluginId("plugin-v2")).toBe(true);
    expect(isPluginId("a")).toBe(true);
    expect(isPluginId("abc")).toBe(true);
  });

  test("invalid names return false", () => {
    expect(isPluginId("My-Plugin")).toBe(false);
    expect(isPluginId("-leading")).toBe(false);
    expect(isPluginId("123-starts-with-digit")).toBe(false);
    expect(isPluginId("")).toBe(false);
    expect(isPluginId("has space")).toBe(false);
    expect(isPluginId("has_underscore")).toBe(false);
  });
});
