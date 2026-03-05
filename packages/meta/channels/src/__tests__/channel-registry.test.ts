import { describe, expect, test } from "bun:test";
import type { ChannelAdapter } from "@koi/core";
import { createChannelRegistry, createDefaultChannelRegistry } from "../channel-registry.js";
import type { ChannelFactory } from "../types.js";

const mockAdapter: ChannelAdapter = {
  name: "mock",
  capabilities: {
    text: true,
    images: false,
    files: false,
    buttons: false,
    audio: false,
    video: false,
    threads: false,
    supportsA2ui: false,
  },
  connect: async () => {},
  disconnect: async () => {},
  send: async () => {},
  onMessage: () => () => {},
};

const mockFactory: ChannelFactory = () => mockAdapter;

describe("createChannelRegistry", () => {
  test("get() returns registered factory", () => {
    const registry = createChannelRegistry(new Map([["test", mockFactory]]));
    expect(registry.get("test")).toBe(mockFactory);
  });

  test("get() returns undefined for unknown name", () => {
    const registry = createChannelRegistry(new Map([["test", mockFactory]]));
    expect(registry.get("unknown")).toBeUndefined();
  });

  test("names() returns set of registered names", () => {
    const registry = createChannelRegistry(
      new Map([
        ["a", mockFactory],
        ["b", mockFactory],
      ]),
    );
    expect(registry.names()).toEqual(new Set(["a", "b"]));
  });
});

describe("createDefaultChannelRegistry", () => {
  test("registers all 14 built-in adapters", () => {
    const registry = createDefaultChannelRegistry();
    const names = registry.names();

    expect(names.size).toBe(14);
    expect(names.has("cli")).toBe(true);
    expect(names.has("slack")).toBe(true);
    expect(names.has("discord")).toBe(true);
    expect(names.has("telegram")).toBe(true);
    expect(names.has("teams")).toBe(true);
    expect(names.has("email")).toBe(true);
    expect(names.has("matrix")).toBe(true);
    expect(names.has("signal")).toBe(true);
    expect(names.has("whatsapp")).toBe(true);
    expect(names.has("voice")).toBe(true);
    expect(names.has("mobile")).toBe(true);
    expect(names.has("canvas-fallback")).toBe(true);
    expect(names.has("chat-sdk")).toBe(true);
    expect(names.has("agui")).toBe(true);
  });

  test("all entries are functions", () => {
    const registry = createDefaultChannelRegistry();
    for (const name of registry.names()) {
      expect(typeof registry.get(name)).toBe("function");
    }
  });
});
