import { describe, expect, test } from "bun:test";
import type { ChannelAdapter } from "@koi/core";
import { createChannelRegistry } from "../channel-registry.js";
import { createChannelStack } from "../channel-stack.js";
import type { ChannelFactory } from "../types.js";

function createMockAdapter(name: string): ChannelAdapter {
  return {
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
    connect: async () => {},
    disconnect: async () => {},
    send: async () => {},
    onMessage: () => () => {},
  };
}

function createMockRegistry(): {
  readonly registry: ReturnType<typeof createChannelRegistry>;
  readonly disconnectLog: string[];
} {
  const disconnectLog: string[] = [];

  const mockFactory: ChannelFactory = (config, _opts) => {
    const name = ((config as Record<string, unknown>).name as string) ?? "mock";
    const adapter = createMockAdapter(name);
    return {
      ...adapter,
      name,
      disconnect: async () => {
        disconnectLog.push(name);
      },
    };
  };

  const registry = createChannelRegistry(
    new Map([
      ["cli", mockFactory],
      ["slack", mockFactory],
      ["discord", mockFactory],
    ]),
  );

  return { registry, disconnectLog };
}

describe("createChannelStack", () => {
  test("resolves channels from manifest config", async () => {
    const { registry } = createMockRegistry();
    const bundle = await createChannelStack({
      channels: [
        { name: "cli", options: { name: "cli" } },
        { name: "slack", options: { name: "slack" } },
      ],
      registry,
    });

    expect(bundle.adapters.size).toBe(2);
    expect(bundle.adapters.has("cli")).toBe(true);
    expect(bundle.adapters.has("slack")).toBe(true);
  });

  test("throws on unknown channel name", async () => {
    const { registry } = createMockRegistry();
    await expect(
      createChannelStack({
        channels: [{ name: "nonexistent" }],
        registry,
      }),
    ).rejects.toThrow('Unknown channel: "nonexistent"');
  });

  test("creates one ComponentProvider per channel", async () => {
    const { registry } = createMockRegistry();
    const bundle = await createChannelStack({
      channels: [
        { name: "cli", options: { name: "cli" } },
        { name: "slack", options: { name: "slack" } },
      ],
      registry,
    });

    expect(bundle.providers).toHaveLength(2);
    expect(bundle.providers[0]?.name).toBe("channel:cli");
    expect(bundle.providers[1]?.name).toBe("channel:slack");
  });

  test("dispose disconnects all channels", async () => {
    const { registry, disconnectLog } = createMockRegistry();
    const bundle = await createChannelStack({
      channels: [
        { name: "cli", options: { name: "cli" } },
        { name: "slack", options: { name: "slack" } },
      ],
      registry,
    });

    await bundle.dispose();

    expect(disconnectLog).toHaveLength(2);
    expect(disconnectLog).toContain("cli");
    expect(disconnectLog).toContain("slack");
  });

  test("healthCheck returns status for all channels", async () => {
    const { registry } = createMockRegistry();
    const bundle = await createChannelStack({
      channels: [{ name: "cli", options: { name: "cli" } }],
      registry,
    });

    const health = bundle.healthCheck();
    expect(health.size).toBe(1);
    expect(health.has("cli")).toBe(true);
  });

  test("defaults to minimal preset when no channels specified", async () => {
    const { registry } = createMockRegistry();
    const bundle = await createChannelStack({ registry });

    // Minimal preset = ["cli"]
    expect(bundle.adapters.size).toBe(1);
    expect(bundle.adapters.has("cli")).toBe(true);
  });
});
