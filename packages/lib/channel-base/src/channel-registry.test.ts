import { describe, expect, it } from "bun:test";
import type { ChannelAdapter } from "@koi/core";
import { type ChannelFactory, createChannelRegistry } from "./channel-registry.js";

const stubAdapter = (name: string): ChannelAdapter => ({
  name,
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
  connect: () => Promise.resolve(),
  disconnect: () => Promise.resolve(),
  send: () => Promise.resolve(),
  onMessage: () => () => {},
});

const factoryFor =
  (name: string): ChannelFactory =>
  () =>
    stubAdapter(name);

describe("createChannelRegistry", () => {
  it("returns the factory for a registered name", () => {
    const reg = createChannelRegistry(new Map([["cli", factoryFor("cli")]]));
    const factory = reg.get("cli");
    expect(factory).toBeDefined();
    expect(factory?.({}).name).toBe("cli");
  });

  it("returns undefined for unknown names", () => {
    const reg = createChannelRegistry(new Map());
    expect(reg.get("missing")).toBeUndefined();
  });

  it("exposes registered names", () => {
    const reg = createChannelRegistry(
      new Map([
        ["cli", factoryFor("cli")],
        ["slack", factoryFor("slack")],
      ]),
    );
    expect(reg.names()).toEqual(new Set(["cli", "slack"]));
  });

  it("snapshots names — mutating original map after build does not change registry", () => {
    const m = new Map<string, ChannelFactory>([["cli", factoryFor("cli")]]);
    const reg = createChannelRegistry(m);
    m.set("slack", factoryFor("slack"));
    expect(reg.names()).toEqual(new Set(["cli"]));
    expect(reg.get("slack")).toBeUndefined();
  });

  it("supports an empty registry", () => {
    const reg = createChannelRegistry(new Map());
    expect(reg.names().size).toBe(0);
    expect(reg.get("anything")).toBeUndefined();
  });
});
