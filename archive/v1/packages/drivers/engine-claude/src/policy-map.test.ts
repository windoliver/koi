import { describe, expect, test } from "bun:test";
import type { McpBridgeConfig } from "./policy-map.js";
import { createSdkOptions } from "./policy-map.js";
import type { ClaudeAdapterConfig } from "./types.js";

describe("createSdkOptions", () => {
  test("maps all config fields to SDK options", () => {
    const config: ClaudeAdapterConfig = {
      model: "claude-sonnet-4-5-20250929",
      maxTurns: 10,
      maxBudgetUsd: 1.0,
      cwd: "/tmp/test",
      systemPrompt: "You are helpful.",
      permissionMode: "acceptEdits",
      allowedTools: ["Read", "Edit"],
      disallowedTools: ["Bash"],
    };

    const options = createSdkOptions(config, undefined, undefined, undefined);

    expect(options.model).toBe("claude-sonnet-4-5-20250929");
    expect(options.maxTurns).toBe(10);
    expect(options.maxBudgetUsd).toBe(1.0);
    expect(options.cwd).toBe("/tmp/test");
    expect(options.systemPrompt).toBe("You are helpful.");
    expect(options.permissionMode).toBe("acceptEdits");
    expect(options.allowedTools).toEqual(["Read", "Edit"]);
    expect(options.disallowedTools).toEqual(["Bash"]);
  });

  test("always sets includePartialMessages to true", () => {
    const config: ClaudeAdapterConfig = {};

    const options = createSdkOptions(config, undefined, undefined, undefined);

    expect(options.includePartialMessages).toBe(true);
  });

  test("includes MCP bridge when provided", () => {
    const config: ClaudeAdapterConfig = {};
    const mcpBridge: McpBridgeConfig = {
      type: "sdk",
      name: "koi_tools",
      instance: {},
    };

    const options = createSdkOptions(config, mcpBridge, undefined, undefined);

    expect(options.mcpServers).toBeDefined();
    const servers = options.mcpServers as Record<string, unknown>;
    expect(servers.koi_tools).toBe(mcpBridge);
  });

  test("excludes MCP bridge when not provided", () => {
    const config: ClaudeAdapterConfig = {};

    const options = createSdkOptions(config, undefined, undefined, undefined);

    expect(options.mcpServers).toBeUndefined();
  });

  test("includes resume session ID when provided", () => {
    const config: ClaudeAdapterConfig = {};

    const options = createSdkOptions(config, undefined, "sess-123", undefined);

    expect(options.resume).toBe("sess-123");
  });

  test("excludes resume when not provided", () => {
    const config: ClaudeAdapterConfig = {};

    const options = createSdkOptions(config, undefined, undefined, undefined);

    expect(options.resume).toBeUndefined();
  });

  test("includes abort controller when provided", () => {
    const config: ClaudeAdapterConfig = {};
    const controller = new AbortController();

    const options = createSdkOptions(config, undefined, undefined, controller);

    expect(options.abortController).toBe(controller);
  });

  test("sdkOverrides are merged last and can override derived config", () => {
    const config: ClaudeAdapterConfig = {
      model: "claude-sonnet-4-5-20250929",
      sdkOverrides: {
        model: "claude-opus-4-6",
        includePartialMessages: false,
        customField: "custom-value",
      },
    };

    const options = createSdkOptions(config, undefined, undefined, undefined);

    // sdkOverrides take precedence
    expect(options.model).toBe("claude-opus-4-6");
    expect(options.includePartialMessages).toBe(false);
    expect(options.customField).toBe("custom-value");
  });

  test("omits undefined config fields", () => {
    const config: ClaudeAdapterConfig = {
      model: "test-model",
    };

    const options = createSdkOptions(config, undefined, undefined, undefined);

    expect(options.model).toBe("test-model");
    expect(options.maxTurns).toBeUndefined();
    expect(options.maxBudgetUsd).toBeUndefined();
    expect(options.cwd).toBeUndefined();
    expect(options.systemPrompt).toBeUndefined();
    expect(options.permissionMode).toBeUndefined();
    expect(options.allowedTools).toBeUndefined();
    expect(options.disallowedTools).toBeUndefined();
  });
});
