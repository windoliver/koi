import { describe, expect, it } from "bun:test";
import type { KoiError } from "@koi/core";
import type { McpAgentSource } from "../types.js";
import { createMcpSource } from "./mcp-scanner.js";

function createMockManager(
  name: string,
  tools: readonly { readonly name: string; readonly description: string }[],
): McpAgentSource {
  return {
    name,
    listTools: async () => ({ ok: true as const, value: tools }),
  };
}

function createFailingManager(name: string): McpAgentSource {
  const error: KoiError = {
    code: "EXTERNAL",
    message: "Connection refused",
    retryable: false,
  };
  return {
    name,
    listTools: async () => ({ ok: false as const, error }),
  };
}

describe("createMcpSource", () => {
  it("discovers agents from managers with agent-like tools", async () => {
    const manager = createMockManager("my-server", [
      { name: "code_review", description: "Review code changes" },
      { name: "generate_code", description: "Generate code from prompt" },
    ]);
    const source = createMcpSource([manager]);

    const results = await source.discover();

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("mcp-my-server");
    expect(results[0]?.transport).toBe("mcp");
    expect(results[0]?.source).toBe("mcp");
    expect(results[0]?.healthy).toBe(true);
    expect(results[0]?.capabilities).toContain("code_review");
    expect(results[0]?.capabilities).toContain("generate_code");
  });

  it("skips managers with no agent-like tools", async () => {
    const manager = createMockManager("database-server", [
      { name: "query_table", description: "Query a database table" },
      { name: "insert_row", description: "Insert a row into a table" },
    ]);
    const source = createMcpSource([manager]);

    const results = await source.discover();

    expect(results).toHaveLength(0);
  });

  it("returns empty array when no managers provided", async () => {
    const source = createMcpSource([]);
    const results = await source.discover();

    expect(results).toHaveLength(0);
  });

  it("handles failing managers gracefully", async () => {
    const failing = createFailingManager("broken-server");
    const working = createMockManager("working-server", [
      { name: "agent_chat", description: "Chat with an AI assistant" },
    ]);
    const source = createMcpSource([failing, working]);

    const results = await source.discover();

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("mcp-working-server");
  });

  it("discovers from multiple managers", async () => {
    const m1 = createMockManager("server-a", [
      { name: "code_assist", description: "AI code assistant" },
    ]);
    const m2 = createMockManager("server-b", [
      { name: "review_agent", description: "Review agent for PRs" },
    ]);
    const source = createMcpSource([m1, m2]);

    const results = await source.discover();

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.name)).toEqual(["mcp-server-a", "mcp-server-b"]);
  });

  it("includes server metadata in descriptors", async () => {
    const manager = createMockManager("test-server", [
      { name: "code_gen", description: "Generate code" },
    ]);
    const source = createMcpSource([manager]);

    const results = await source.discover();

    expect(results[0]?.metadata).toEqual({
      serverName: "test-server",
      toolCount: 1,
    });
  });

  it("has name 'mcp'", () => {
    const source = createMcpSource([]);
    expect(source.name).toBe("mcp");
  });
});
