import { describe, expect, test } from "bun:test";
import {
  normalizeConfigItem,
  normalizeModelConfig,
  transformToLoadedManifest,
} from "../transform.js";

describe("normalizeModelConfig", () => {
  test("converts string to ModelConfig", () => {
    const result = normalizeModelConfig("anthropic:claude-sonnet-4-5-20250929");
    expect(result).toEqual({ name: "anthropic:claude-sonnet-4-5-20250929" });
  });

  test("passes through ModelConfig object", () => {
    const input = { name: "anthropic:claude-sonnet-4-5-20250929", options: { temperature: 0.7 } };
    const result = normalizeModelConfig(input);
    expect(result).toEqual(input);
  });
});

describe("normalizeConfigItem", () => {
  test("passes through { name, options } format", () => {
    const input = { name: "@koi/mw-memory", options: { scope: "agent" } };
    const result = normalizeConfigItem(input);
    expect(result).toEqual(input);
  });

  test("converts key-value map to { name, options }", () => {
    const input = { "@koi/middleware-memory": { scope: "agent" } };
    const result = normalizeConfigItem(input);
    expect(result).toEqual({ name: "@koi/middleware-memory", options: { scope: "agent" } });
  });

  test("converts key-value map with no options to { name }", () => {
    const input = { "@koi/middleware-log": {} };
    const result = normalizeConfigItem(input);
    expect(result).toEqual({ name: "@koi/middleware-log", options: {} });
  });
});

describe("transformToLoadedManifest", () => {
  test("transforms minimal raw manifest", () => {
    const raw = {
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
    };
    const result = transformToLoadedManifest(raw);
    expect(result.name).toBe("my-agent");
    expect(result.version).toBe("1.0.0");
    expect(result.model).toEqual({ name: "anthropic:claude-sonnet-4-5-20250929" });
  });

  test("transforms middleware key-value format", () => {
    const raw = {
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
      middleware: [{ "@koi/middleware-memory": { scope: "agent" } }],
    };
    const result = transformToLoadedManifest(raw);
    expect(result.middleware).toEqual([
      { name: "@koi/middleware-memory", options: { scope: "agent" } },
    ]);
  });

  test("flattens tools keyed sections", () => {
    const raw = {
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
      tools: {
        mcp: [{ name: "filesystem", command: "npx mcp-server /workspace" }],
      },
    };
    const result = transformToLoadedManifest(raw);
    expect(result.tools).toEqual([
      { name: "filesystem", options: { command: "npx mcp-server /workspace", section: "mcp" } },
    ]);
  });

  test("transforms outboundWebhooks with all fields", () => {
    const raw = {
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
      outboundWebhooks: [
        {
          url: "https://hooks.example.com/events",
          events: ["session.started", "tool.failed"],
          secret: "wh-secret",
          description: "Notify on failures",
          enabled: true,
        },
      ],
    };
    const result = transformToLoadedManifest(raw);
    expect(result.outboundWebhooks).toEqual([
      {
        url: "https://hooks.example.com/events",
        events: ["session.started", "tool.failed"],
        secret: "wh-secret",
        description: "Notify on failures",
        enabled: true,
      },
    ]);
  });

  test("transforms outboundWebhooks with required fields only", () => {
    const raw = {
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
      outboundWebhooks: [
        {
          url: "https://hooks.example.com/events",
          events: ["session.ended"],
          secret: "s3cret",
        },
      ],
    };
    const result = transformToLoadedManifest(raw);
    expect(result.outboundWebhooks).toEqual([
      {
        url: "https://hooks.example.com/events",
        events: ["session.ended"],
        secret: "s3cret",
      },
    ]);
    // Optional fields should not be present (exactOptionalPropertyTypes)
    const hook = result.outboundWebhooks?.[0];
    expect("description" in (hook ?? {})).toBe(false);
    expect("enabled" in (hook ?? {})).toBe(false);
  });

  test("omits outboundWebhooks when not present in raw", () => {
    const raw = {
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
    };
    const result = transformToLoadedManifest(raw);
    expect("outboundWebhooks" in result).toBe(false);
  });

  test("passes through extension fields", () => {
    const raw = {
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
      engine: "deepagents",
      schedule: "0 9 * * *",
    };
    const result = transformToLoadedManifest(raw);
    expect(result.engine).toBe("deepagents");
    expect(result.schedule).toBe("0 9 * * *");
  });

  test("transforms permissions", () => {
    const raw = {
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
      permissions: {
        allow: ["read_file:/workspace/**"],
        deny: ["bash:rm -rf *"],
      },
    };
    const result = transformToLoadedManifest(raw);
    expect(result.permissions).toEqual({
      allow: ["read_file:/workspace/**"],
      deny: ["bash:rm -rf *"],
    });
  });
});
