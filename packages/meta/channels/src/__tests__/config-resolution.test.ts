import { describe, expect, test } from "bun:test";
import { resolveChannelStackConfig } from "../config-resolution.js";

describe("resolveChannelStackConfig", () => {
  test("explicit channels take priority over preset", () => {
    const result = resolveChannelStackConfig({
      preset: "full",
      channels: [{ name: "cli" }],
    });

    expect(result.channels).toHaveLength(1);
    expect(result.channels[0]?.name).toBe("cli");
  });

  test("preset expands to channel declarations", () => {
    const result = resolveChannelStackConfig({ preset: "standard" });

    expect(result.channels).toHaveLength(4);
    const names = result.channels.map((c) => c.name);
    expect(names).toEqual(["cli", "slack", "discord", "telegram"]);
  });

  test("defaults to minimal preset when neither channels nor preset provided", () => {
    const result = resolveChannelStackConfig({});

    expect(result.channels).toHaveLength(1);
    expect(result.channels[0]?.name).toBe("cli");
  });

  test("full preset includes all 14 adapters", () => {
    const result = resolveChannelStackConfig({ preset: "full" });
    expect(result.channels).toHaveLength(14);
  });

  test("applies default runtime opts", () => {
    const result = resolveChannelStackConfig({});

    expect(result.runtimeOpts.connectTimeoutMs).toBe(30_000);
    expect(result.runtimeOpts.healthTimeoutMs).toBe(300_000);
  });

  test("user overrides runtime opts", () => {
    const result = resolveChannelStackConfig({
      connectTimeoutMs: 5_000,
      healthTimeoutMs: 60_000,
    });

    expect(result.runtimeOpts.connectTimeoutMs).toBe(5_000);
    expect(result.runtimeOpts.healthTimeoutMs).toBe(60_000);
  });

  test("preserves custom registry in resolved config", () => {
    const customRegistry = {
      get: () => undefined,
      names: () => new Set<string>(),
    };

    const result = resolveChannelStackConfig({ registry: customRegistry });
    expect(result.registry).toBe(customRegistry);
  });

  test("empty channels array falls through to preset", () => {
    const result = resolveChannelStackConfig({
      channels: [],
      preset: "standard",
    });

    // Empty array → falls through to preset
    expect(result.channels).toHaveLength(4);
  });
});
