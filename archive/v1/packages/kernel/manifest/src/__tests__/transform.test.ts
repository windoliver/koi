import { describe, expect, test } from "bun:test";
import { brickId } from "@koi/core";
import {
  normalizeChannelConfig,
  normalizeConfigItem,
  normalizeMiddlewareConfig,
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
    const input = { "@koi/middleware-audit": { scope: "agent" } };
    const result = normalizeConfigItem(input);
    expect(result).toEqual({ name: "@koi/middleware-audit", options: { scope: "agent" } });
  });

  test("converts key-value map with no options to { name }", () => {
    const input = { "@koi/middleware-log": {} };
    const result = normalizeConfigItem(input);
    expect(result).toEqual({ name: "@koi/middleware-log", options: {} });
  });

  test("passes through version and publisher", () => {
    const input = { name: "@koi/calc", options: { x: 1 }, version: "1.0.0", publisher: "alice" };
    const result = normalizeConfigItem(input);
    expect(result).toEqual({
      name: "@koi/calc",
      options: { x: 1 },
      version: "1.0.0",
      publisher: "alice",
    });
  });

  test("omits version and publisher when absent", () => {
    const input = { name: "@koi/calc" };
    const result = normalizeConfigItem(input);
    expect("version" in result).toBe(false);
    expect("publisher" in result).toBe(false);
  });
});

describe("normalizeMiddlewareConfig", () => {
  test("passes through required: false", () => {
    const input = { name: "@koi/middleware-audit", required: false };
    const result = normalizeMiddlewareConfig(input);
    expect(result.name).toBe("@koi/middleware-audit");
    expect(result.required).toBe(false);
  });

  test("omits required when absent", () => {
    const input = { name: "@koi/middleware-permissions" };
    const result = normalizeMiddlewareConfig(input);
    expect(result.name).toBe("@koi/middleware-permissions");
    expect("required" in result).toBe(false);
  });

  test("preserves options alongside required", () => {
    const input = { name: "@koi/middleware-audit", options: { level: "verbose" }, required: false };
    const result = normalizeMiddlewareConfig(input);
    expect(result.name).toBe("@koi/middleware-audit");
    expect(result.options).toEqual({ level: "verbose" });
    expect(result.required).toBe(false);
  });

  test("handles key-value shorthand (no required support)", () => {
    const input = { "@koi/middleware-audit": { scope: "agent" } };
    const result = normalizeMiddlewareConfig(input);
    expect(result.name).toBe("@koi/middleware-audit");
    expect(result.options).toEqual({ scope: "agent" });
    expect("required" in result).toBe(false);
  });
});

describe("normalizeChannelConfig", () => {
  test("passes through channel without identity", () => {
    const result = normalizeChannelConfig({ name: "@koi/channel-cli" });
    expect(result).toEqual({ name: "@koi/channel-cli" });
  });

  test("preserves identity block on channel config", () => {
    const input = {
      name: "@koi/channel-telegram",
      identity: { name: "Alex", instructions: "Be casual." },
    };
    const result = normalizeChannelConfig(input);
    expect(result.name).toBe("@koi/channel-telegram");
    expect(result.identity).toEqual({ name: "Alex", instructions: "Be casual." });
  });

  test("preserves full identity with avatar", () => {
    const input = {
      name: "@koi/channel-slack",
      identity: { name: "Bot", avatar: "bot.png", instructions: "Be helpful." },
    };
    const result = normalizeChannelConfig(input);
    expect(result.identity).toEqual({
      name: "Bot",
      avatar: "bot.png",
      instructions: "Be helpful.",
    });
  });

  test("omits identity properties not present in source", () => {
    const input = { name: "@koi/channel-telegram", identity: { name: "Alex" } };
    const result = normalizeChannelConfig(input);
    expect(result.identity).toEqual({ name: "Alex" });
    expect("avatar" in (result.identity ?? {})).toBe(false);
    expect("instructions" in (result.identity ?? {})).toBe(false);
  });

  test("passes through version and publisher", () => {
    const input = { name: "@koi/channel-cli", version: "2.0.0", publisher: "bob" };
    const result = normalizeChannelConfig(input);
    expect(result.version).toBe("2.0.0");
    expect(result.publisher).toBe("bob");
  });

  test("passes through version and publisher with identity", () => {
    const input = {
      name: "@koi/channel-telegram",
      identity: { name: "Alex" },
      version: "1.0.0",
      publisher: "alice",
    };
    const result = normalizeChannelConfig(input);
    expect(result.version).toBe("1.0.0");
    expect(result.publisher).toBe("alice");
    expect(result.identity).toEqual({ name: "Alex" });
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
      middleware: [{ "@koi/middleware-audit": { scope: "agent" } }],
    };
    const result = transformToLoadedManifest(raw);
    expect(result.middleware).toEqual([
      { name: "@koi/middleware-audit", options: { scope: "agent" } },
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

  test("transforms channels with identity block", () => {
    const raw = {
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
      channels: [
        {
          name: "@koi/channel-telegram",
          identity: { name: "Alex", instructions: "Be casual." },
        },
        { name: "@koi/channel-cli" }, // no identity
      ],
    };
    const result = transformToLoadedManifest(raw);
    expect(result.channels).toHaveLength(2);
    expect(result.channels?.[0]?.identity).toEqual({ name: "Alex", instructions: "Be casual." });
    expect(result.channels?.[1]?.identity).toBeUndefined();
  });

  test("passes through version and publisher on tools", () => {
    const raw = {
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
      tools: [{ name: "calculator", version: "2.0.0", publisher: "alice" }],
    };
    const result = transformToLoadedManifest(raw);
    expect(result.tools?.[0]?.version).toBe("2.0.0");
    expect(result.tools?.[0]?.publisher).toBe("alice");
  });

  test("passes through version and publisher on keyed-section tools", () => {
    const raw = {
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
      tools: {
        mcp: [{ name: "fs", command: "npx mcp-server", version: "1.0.0", publisher: "bob" }],
      },
    };
    const result = transformToLoadedManifest(raw);
    expect(result.tools?.[0]?.version).toBe("1.0.0");
    expect(result.tools?.[0]?.publisher).toBe("bob");
  });

  test("passes through version and publisher on middleware", () => {
    const raw = {
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
      middleware: [{ name: "@koi/middleware-audit", version: "3.0.0", publisher: "koi-team" }],
    };
    const result = transformToLoadedManifest(raw);
    expect(result.middleware?.[0]?.version).toBe("3.0.0");
    expect(result.middleware?.[0]?.publisher).toBe("koi-team");
  });

  test("passes through required: false on middleware", () => {
    const raw = {
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
      middleware: [{ name: "@koi/middleware-audit", required: false }],
    };
    const result = transformToLoadedManifest(raw);
    expect(result.middleware?.[0]?.required).toBe(false);
  });

  test("omits required on middleware when absent in raw", () => {
    const raw = {
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
      middleware: [{ name: "@koi/middleware-permissions" }],
    };
    const result = transformToLoadedManifest(raw);
    expect("required" in (result.middleware?.[0] ?? {})).toBe(false);
  });

  test("passes through version and publisher on channels", () => {
    const raw = {
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
      channels: [{ name: "@koi/channel-cli", version: "1.0.0", publisher: "alice" }],
    };
    const result = transformToLoadedManifest(raw);
    expect(result.channels?.[0]?.version).toBe("1.0.0");
    expect(result.channels?.[0]?.publisher).toBe("alice");
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

  test("transforms filesystem skills with source", () => {
    const raw = {
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
      skills: [
        {
          name: "code-review",
          source: { kind: "filesystem" as const, path: "./skills/code-review" },
        },
      ],
    };
    const result = transformToLoadedManifest(raw);
    expect(result.skills).toEqual([
      { name: "code-review", source: { kind: "filesystem", path: "./skills/code-review" } },
    ]);
  });

  test("transforms forged skills with source", () => {
    const raw = {
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
      skills: [
        { name: "forged-review", source: { kind: "forged" as const, brickId: "sha256:abc123" } },
      ],
    };
    const result = transformToLoadedManifest(raw);
    expect(result.skills).toEqual([
      { name: "forged-review", source: { kind: "forged", brickId: brickId("sha256:abc123") } },
    ]);
  });

  test("transforms skills with options", () => {
    const raw = {
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
      skills: [
        {
          name: "code-review",
          source: { kind: "filesystem" as const, path: "./skills/cr" },
          options: { verbose: true },
        },
      ],
    };
    const result = transformToLoadedManifest(raw);
    expect(result.skills?.[0]?.options).toEqual({ verbose: true });
  });

  test("omits skills when not present in raw", () => {
    const raw = {
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
    };
    const result = transformToLoadedManifest(raw);
    expect("skills" in result).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // dataSources extension
  // ---------------------------------------------------------------------------

  test("passes through dataSources extension with auth", () => {
    const raw = {
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
      dataSources: [
        {
          name: "main-db",
          protocol: "postgres",
          description: "Primary database",
          auth: { kind: "connection_string", ref: "DATABASE_URL" },
          allowedHosts: ["db.example.com"],
        },
      ],
    };
    const result = transformToLoadedManifest(raw);
    expect(result.dataSources).toHaveLength(1);
    expect(result.dataSources?.[0]?.name).toBe("main-db");
    expect(result.dataSources?.[0]?.protocol).toBe("postgres");
    expect(result.dataSources?.[0]?.auth?.kind).toBe("connection_string");
    expect(result.dataSources?.[0]?.auth?.ref).toBe("DATABASE_URL");
    expect(result.dataSources?.[0]?.allowedHosts).toEqual(["db.example.com"]);
  });

  test("passes through dataSources without auth", () => {
    const raw = {
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
      dataSources: [{ name: "local-db", protocol: "sqlite" }],
    };
    const result = transformToLoadedManifest(raw);
    expect(result.dataSources).toHaveLength(1);
    expect(result.dataSources?.[0]?.name).toBe("local-db");
    expect(result.dataSources?.[0]?.protocol).toBe("sqlite");
    expect(result.dataSources?.[0]?.auth).toBeUndefined();
  });

  test("omits dataSources when not present in raw", () => {
    const raw = {
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
    };
    const result = transformToLoadedManifest(raw);
    expect("dataSources" in result).toBe(false);
  });

  test("passes hooks through to LoadedManifest", () => {
    const raw = {
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
      hooks: [
        {
          kind: "prompt" as const,
          name: "safety-check",
          prompt: "Is this action safe?",
          model: "haiku",
          failMode: "closed" as const,
        },
        {
          kind: "command" as const,
          name: "audit-log",
          command: "echo audit",
        },
      ],
    };
    const result = transformToLoadedManifest(raw);
    expect(result.hooks).toHaveLength(2);
    expect(result.hooks?.[0]?.kind).toBe("prompt");
    expect(result.hooks?.[0]?.name).toBe("safety-check");
    expect(result.hooks?.[1]?.kind).toBe("command");
  });

  test("omits hooks when not present in raw", () => {
    const raw = {
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
    };
    const result = transformToLoadedManifest(raw);
    expect("hooks" in result).toBe(false);
  });
});
