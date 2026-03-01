/**
 * Integration tests for the Codex MCP recipe.
 *
 * Validates that the koi.yaml manifest loads correctly, declares the expected
 * MCP tool config and governance middleware, and that Codex tools are correctly
 * namespaced when wired through the MCP component provider.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Agent, AttachResult, Tool } from "@koi/core";
import { agentId, isAttachResult, toolToken } from "@koi/core";
import { loadManifest } from "@koi/manifest";
import type { McpClientManager, McpProviderConfig, ResolvedMcpServerConfig } from "@koi/mcp";
import { createMcpComponentProvider } from "@koi/mcp";

// ---------------------------------------------------------------------------
// Helpers (same patterns as packages/mcp/src/component-provider-mock.test.ts)
// ---------------------------------------------------------------------------

const MANIFEST_PATH = resolve(import.meta.dirname, "koi.yaml");

function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

function createMockAgent(): Agent {
  return {
    pid: { id: agentId("codex-test-1"), name: "codex-test", type: "worker", depth: 0 },
    manifest: {
      name: "codex-test-agent",
      version: "1.0.0",
      model: { name: "test-model" },
      tools: [],
      channels: [],
      middleware: [],
    },
    state: "running",
    component: () => undefined,
    has: () => false,
    hasAll: () => false,
    query: () => new Map(),
    components: () => new Map(),
  };
}

function createCodexMockManager(
  callResults: Readonly<Record<string, unknown>> = {},
): McpClientManager {
  let connected = false;
  return {
    connect: async () => {
      connected = true;
      return { ok: true as const, value: undefined };
    },
    listTools: async () => ({
      ok: true as const,
      value: [
        { name: "codex_generate", description: "Generate code", inputSchema: { type: "object" } },
        { name: "codex_edit", description: "Edit code", inputSchema: { type: "object" } },
      ],
    }),
    callTool: async (toolName, _args) => {
      const result = callResults[toolName];
      if (result === undefined) {
        return {
          ok: false as const,
          error: {
            code: "NOT_FOUND" as const,
            message: `Tool "${toolName}" not found`,
            retryable: false,
          },
        };
      }
      return { ok: true as const, value: result };
    },
    close: async () => {
      connected = false;
    },
    isConnected: () => connected,
    serverName: () => "codex",
  };
}

function createMockFactory(
  registry: ReadonlyMap<string, McpClientManager>,
): (
  config: ResolvedMcpServerConfig,
  connectTimeoutMs: number,
  maxReconnectAttempts: number,
) => McpClientManager {
  return (config) => {
    const manager = registry.get(config.name);
    if (manager === undefined) {
      throw new Error(`No mock manager registered for "${config.name}"`);
    }
    return manager;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Codex MCP recipe", () => {
  test("koi.yaml loads without errors", async () => {
    const result = await loadManifest(MANIFEST_PATH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings).toHaveLength(0);
  });

  test("manifest has codex MCP tool config", async () => {
    const result = await loadManifest(MANIFEST_PATH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { manifest } = result.value;
    expect(manifest.tools).toBeDefined();

    const codexTool = manifest.tools?.find((t) => t.name === "codex");
    expect(codexTool).toBeDefined();
    expect(codexTool?.options).toMatchObject({
      command: "codex mcp-server",
      section: "mcp",
    });
  });

  test("manifest declares governance middleware", async () => {
    const result = await loadManifest(MANIFEST_PATH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { manifest } = result.value;
    const names = manifest.middleware?.map((m) => m.name) ?? [];
    expect(names).toContain("@koi/middleware-permissions");
    expect(names).toContain("@koi/middleware-pay");
    expect(names).toContain("@koi/middleware-audit");

    const pay = manifest.middleware?.find((m) => m.name === "@koi/middleware-pay");
    expect(pay?.options).toMatchObject({ dailyBudget: 500 });
  });

  test("codex tools wrap as mcp/codex/*", async () => {
    const registry = new Map<string, McpClientManager>([["codex", createCodexMockManager()]]);

    const config: McpProviderConfig = {
      servers: [{ name: "codex", transport: "stdio", command: "echo", mode: "tools" }],
    };

    const result = await createMcpComponentProvider(config, createMockFactory(registry));
    expect(result.failures).toHaveLength(0);
    expect(result.clients).toHaveLength(1);

    const agent = createMockAgent();
    const components = extractMap(await result.provider.attach(agent));
    expect(components.has(toolToken("mcp/codex/codex_generate") as string)).toBe(true);
    expect(components.has(toolToken("mcp/codex/codex_edit") as string)).toBe(true);
  });

  test("wrapped tool executes via mock", async () => {
    const registry = new Map<string, McpClientManager>([
      [
        "codex",
        createCodexMockManager({
          codex_generate: [{ type: "text", text: "function hello() { return 'world'; }" }],
        }),
      ],
    ]);

    const config: McpProviderConfig = {
      servers: [{ name: "codex", transport: "stdio", command: "echo", mode: "tools" }],
    };

    const result = await createMcpComponentProvider(config, createMockFactory(registry));
    const agent = createMockAgent();
    const components = extractMap(await result.provider.attach(agent));

    const tool = components.get(toolToken("mcp/codex/codex_generate") as string) as Tool;
    expect(tool).toBeDefined();

    const execResult = await tool.execute({ prompt: "hello world function" });
    expect(execResult).toEqual([{ type: "text", text: "function hello() { return 'world'; }" }]);
  });
});
