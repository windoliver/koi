import { describe, expect, mock, test } from "bun:test";
import type { KoiError } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import type { Agent, Tool, ToolDescriptor } from "@koi/core/ecs";
import type { ToolHandler, ToolRequest, ToolResponse } from "@koi/core/middleware";
import { PARSE_ERROR_KEY } from "./stream-bridge.js";
import { createPiTools, sanitizeToolName, wrapTool } from "./tool-bridge.js";

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
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
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

// ---------------------------------------------------------------------------
// wrapTool — error handling (defense-in-depth)
// ---------------------------------------------------------------------------

describe("wrapTool error handling", () => {
  test("returns formatted error result when toolCall throws a KoiError", async () => {
    const descriptor = makeToolDescriptor("search", "Search");
    const koiError: KoiError = {
      code: "VALIDATION",
      message: "Invalid query format",
      retryable: false,
    };
    const toolCall: ToolHandler = async () => {
      throw koiError;
    };

    const piTool = wrapTool(descriptor, toolCall);
    const result = await piTool.execute("call-1", { query: "test" });

    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    if (result.content[0]?.type === "text") {
      expect(result.content[0].text).toContain("search");
      expect(result.content[0].text).toContain("Invalid query format");
    }
  });

  test("returns formatted error result when toolCall throws a generic Error", async () => {
    const descriptor = makeToolDescriptor("write", "Write file");
    const toolCall: ToolHandler = async () => {
      throw new Error("ENOENT: no such file or directory");
    };

    const piTool = wrapTool(descriptor, toolCall);
    const result = await piTool.execute("call-2", {});

    expect(result.content).toHaveLength(1);
    if (result.content[0]?.type === "text") {
      expect(result.content[0].text).toContain("write");
      expect(result.content[0].text).toContain("ENOENT");
    }
  });

  test("returns formatted error result when toolCall throws a non-Error value", async () => {
    const descriptor = makeToolDescriptor("fetch", "Fetch data");
    const toolCall: ToolHandler = async () => {
      throw "connection refused";
    };

    const piTool = wrapTool(descriptor, toolCall);
    const result = await piTool.execute("call-3", {});

    expect(result.content).toHaveLength(1);
    if (result.content[0]?.type === "text") {
      expect(result.content[0].text).toContain("fetch");
      expect(result.content[0].text).toContain("connection refused");
    }
  });

  test("error result does not throw (does not propagate to pi runtime)", async () => {
    const descriptor = makeToolDescriptor("crash", "Crash tool");
    const toolCall: ToolHandler = async () => {
      throw new Error("boom");
    };

    const piTool = wrapTool(descriptor, toolCall);

    // Should resolve, not reject
    const result = await piTool.execute("call-4", {});
    expect(result).toBeDefined();
    expect(result.content).toHaveLength(1);
  });

  test("error result includes error details in details field", async () => {
    const descriptor = makeToolDescriptor("broken", "Broken tool");
    const toolCall: ToolHandler = async () => {
      throw new Error("something went wrong");
    };

    const piTool = wrapTool(descriptor, toolCall);
    const result = await piTool.execute("call-5", {});

    expect(result.details).toBeDefined();
    const details = result.details as { readonly error: string };
    expect(details.error).toContain("something went wrong");
  });

  test("deferred parse error throws VALIDATION to pi runtime (bypasses defense-in-depth)", async () => {
    const descriptor = makeToolDescriptor("search", "Search");
    const toolCall: ToolHandler = async () => ({ output: "should not reach" });

    const piTool = wrapTool(descriptor, toolCall);
    // Simulate stream-bridge's deferred parse error marker in arguments
    const poisonedInput = {
      [PARSE_ERROR_KEY]: "Tool 'search' received malformed JSON: Unexpected token",
    };

    // Should throw (propagate to pi runtime), NOT be caught by defense-in-depth
    await expect(piTool.execute("call-6", poisonedInput)).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("malformed JSON"),
    });
  });
});
