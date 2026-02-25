import { describe, expect, mock, test } from "bun:test";
import type { Agent, Tool, ToolDescriptor } from "@koi/core/ecs";
import type { ToolHandler, ToolRequest, ToolResponse } from "@koi/core/middleware";
import { createPiTools, sanitizeToolName } from "./tool-bridge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolDescriptor(name: string, description: string): ToolDescriptor {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  };
}

function makeTool(name: string, description: string): Tool {
  return {
    descriptor: makeToolDescriptor(name, description),
    trustTier: "sandbox",
    execute: async (args) => `executed ${name} with ${JSON.stringify(args)}`,
  };
}

function makeMockAgent(tools: readonly Tool[]): Agent {
  const componentMap = new Map<string, unknown>();
  for (const tool of tools) {
    componentMap.set(`tool:${tool.descriptor.name}`, tool);
  }

  return {
    pid: { id: "test-agent", name: "test", type: "copilot", depth: 0 },
    manifest: {
      name: "test",
      version: "0.0.0",
      description: "test agent",
    },
    state: "running",
    component: (token: string) =>
      componentMap.get(token as string) as ReturnType<Agent["component"]>,
    has: (token: string) => componentMap.has(token as string),
    hasAll: (...tokens: readonly string[]) => tokens.every((t) => componentMap.has(t as string)),
    query: <T>(prefix: string) => {
      const result = new Map<string, T>();
      for (const [key, value] of componentMap) {
        if (key.startsWith(prefix)) {
          result.set(key, value as T);
        }
      }
      return result as ReadonlyMap<string, T>;
    },
    components: () => componentMap,
  } as unknown as Agent;
}

// ---------------------------------------------------------------------------
// sanitizeToolName
// ---------------------------------------------------------------------------

describe("sanitizeToolName", () => {
  test("passes through simple names unchanged", () => {
    expect(sanitizeToolName("search")).toBe("search");
    expect(sanitizeToolName("add_numbers")).toBe("add_numbers");
    expect(sanitizeToolName("my-tool")).toBe("my-tool");
  });

  test("replaces forward slashes with underscores", () => {
    expect(sanitizeToolName("lsp/ts/hover")).toBe("lsp_ts_hover");
    expect(sanitizeToolName("lsp/ts/get_diagnostics")).toBe("lsp_ts_get_diagnostics");
  });

  test("replaces other invalid characters with underscores", () => {
    expect(sanitizeToolName("tool.name")).toBe("tool_name");
    expect(sanitizeToolName("tool:name")).toBe("tool_name");
    expect(sanitizeToolName("tool name")).toBe("tool_name");
  });

  test("preserves hyphens and underscores", () => {
    expect(sanitizeToolName("my-tool_v2")).toBe("my-tool_v2");
  });

  test("throws when sanitized name exceeds 64 characters", () => {
    const longName = "a".repeat(65);
    expect(() => sanitizeToolName(longName)).toThrow("exceeds 64 characters");
  });

  test("accepts name at exactly 64 characters", () => {
    const name = "a".repeat(64);
    expect(sanitizeToolName(name)).toBe(name);
  });
});

// ---------------------------------------------------------------------------
// createPiTools
// ---------------------------------------------------------------------------

describe("createPiTools", () => {
  test("wraps agent tools as pi AgentTools", () => {
    const agent = makeMockAgent([
      makeTool("search", "Search the web"),
      makeTool("write", "Write a file"),
    ]);

    const toolCall: ToolHandler = async (_request) => ({ output: "ok" });
    const piTools = createPiTools(agent, toolCall);

    expect(piTools).toHaveLength(2);
    expect(piTools[0]?.name).toBe("search");
    expect(piTools[0]?.description).toBe("Search the web");
    expect(piTools[0]?.label).toBe("search");
    expect(piTools[1]?.name).toBe("write");
  });

  test("sanitizes tool names with slashes for the API", () => {
    const agent = makeMockAgent([
      makeTool("lsp/ts/hover", "Hover info"),
      makeTool("lsp/ts/get_diagnostics", "Get diagnostics"),
    ]);

    const toolCall: ToolHandler = async (_request) => ({ output: "ok" });
    const piTools = createPiTools(agent, toolCall);

    expect(piTools[0]?.name).toBe("lsp_ts_hover");
    expect(piTools[0]?.label).toBe("lsp/ts/hover");
    expect(piTools[1]?.name).toBe("lsp_ts_get_diagnostics");
  });

  test("routes execute through toolCall with original name as toolId", async () => {
    const agent = makeMockAgent([makeTool("lsp/ts/hover", "Hover")]);
    const toolCallFn = mock(
      async (_request: ToolRequest): Promise<ToolResponse> => ({
        output: { contents: "string" },
      }),
    );

    const piTools = createPiTools(agent, toolCallFn);
    await piTools[0]?.execute("call-1", { uri: "file:///test.ts", line: 1, character: 1 });

    // toolId uses the original Koi name, not the sanitized API name
    const callArg = toolCallFn.mock.calls[0]?.[0];
    expect(callArg?.toolId).toBe("lsp/ts/hover");
  });

  test("routes execute through toolCall handler", async () => {
    const agent = makeMockAgent([makeTool("search", "Search")]);
    const toolCallFn = mock(
      async (_request: ToolRequest): Promise<ToolResponse> => ({
        output: { results: ["found it"] },
      }),
    );

    const piTools = createPiTools(agent, toolCallFn);
    const result = await piTools[0]?.execute("call-1", { query: "test" });

    expect(toolCallFn).toHaveBeenCalledTimes(1);
    const callArg = toolCallFn.mock.calls[0]?.[0];
    expect(callArg?.toolId).toBe("search");
    expect(callArg?.input).toEqual({ query: "test" });
    expect(callArg?.metadata).toEqual({ toolCallId: "call-1" });

    // Result should be formatted as AgentToolResult
    expect(result?.content).toHaveLength(1);
    expect(result?.content[0]?.type).toBe("text");
    expect(result?.details).toEqual({ results: ["found it"] });
  });

  test("formats string output directly", async () => {
    const agent = makeMockAgent([makeTool("echo", "Echo")]);
    const toolCall: ToolHandler = async () => ({ output: "plain text" });

    const piTools = createPiTools(agent, toolCall);
    const result = await piTools[0]?.execute("call-1", {});

    expect(result?.content[0]?.type).toBe("text");
    if (result?.content[0]?.type === "text") {
      expect(result.content[0].text).toBe("plain text");
    }
  });

  test("JSON-serializes non-string output", async () => {
    const agent = makeMockAgent([makeTool("data", "Get data")]);
    const toolCall: ToolHandler = async () => ({ output: { key: "value" } });

    const piTools = createPiTools(agent, toolCall);
    const result = await piTools[0]?.execute("call-1", {});

    if (result?.content[0]?.type === "text") {
      expect(JSON.parse(result.content[0].text)).toEqual({ key: "value" });
    }
  });

  test("returns empty array when agent has no tools", () => {
    const agent = makeMockAgent([]);
    const toolCall: ToolHandler = async () => ({ output: "ok" });

    const piTools = createPiTools(agent, toolCall);
    expect(piTools).toHaveLength(0);
  });

  test("converts inputSchema to TSchema (identity cast)", () => {
    const agent = makeMockAgent([makeTool("search", "Search")]);
    const toolCall: ToolHandler = async () => ({ output: "ok" });

    const piTools = createPiTools(agent, toolCall);
    // TypeBox TSchema is JSON Schema at runtime
    const params = piTools[0]?.parameters as Record<string, unknown>;
    expect(params?.type).toBe("object");
    expect(params?.properties).toBeDefined();
  });
});
