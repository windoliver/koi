import { describe, expect, test } from "bun:test";
import type { Agent, JsonObject, Tool, ToolDescriptor } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import type { ToolRegistry } from "./tool-bridge.js";
import {
  createToolBridgeMcpServer,
  createToolRegistry,
  executeBridgedTool,
} from "./tool-bridge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockTool(descriptor: ToolDescriptor, executeResult: unknown = "ok"): Tool {
  return {
    descriptor,
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (_args: JsonObject) => executeResult,
  };
}

function createMockAgent(tools: ReadonlyMap<string, Tool>): Agent {
  return {
    id: "test-agent" as ReturnType<typeof import("@koi/core").agentId>,
    manifest: {} as Agent["manifest"],
    query: (prefix: string) => {
      if (!prefix.startsWith("tool:")) return new Map();
      const result = new Map<string, unknown>();
      for (const [name, tool] of tools) {
        result.set(`tool:${name}`, tool);
      }
      return result;
    },
    get: (_token: unknown) => undefined,
    attach: () => {},
    detach: () => false,
  } as unknown as Agent;
}

// ---------------------------------------------------------------------------
// createToolRegistry
// ---------------------------------------------------------------------------

describe("createToolRegistry", () => {
  test("builds registry from agent tool components", () => {
    const tools = new Map<string, Tool>();
    tools.set(
      "search",
      createMockTool({
        name: "search",
        description: "Search for content",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      }),
    );
    tools.set(
      "write",
      createMockTool({
        name: "write",
        description: "Write a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
        },
      }),
    );

    const agent = createMockAgent(tools);
    const registry = createToolRegistry(agent);

    expect(registry.tools.size).toBe(2);
    expect(registry.descriptors).toHaveLength(2);

    const searchDesc = registry.descriptors.find((d) => d.name === "search");
    expect(searchDesc).toBeDefined();
    expect(searchDesc?.description).toBe("Search for content");
  });

  test("returns empty registry when agent has no tools", () => {
    const agent = createMockAgent(new Map());
    const registry = createToolRegistry(agent);

    expect(registry.tools.size).toBe(0);
    expect(registry.descriptors).toHaveLength(0);
  });

  test("preserves inputSchema from tool descriptor", () => {
    const tools = new Map<string, Tool>();
    tools.set(
      "simple",
      createMockTool({
        name: "simple",
        description: "A simple tool",
        inputSchema: { type: "object", properties: {} },
      }),
    );

    const agent = createMockAgent(tools);
    const registry = createToolRegistry(agent);

    expect(registry.descriptors).toHaveLength(1);
    expect(registry.descriptors[0]?.inputSchema).toEqual({
      type: "object",
      properties: {},
    });
  });

  test("uses description from tool descriptor", () => {
    const tools = new Map<string, Tool>();
    tools.set(
      "mytool",
      createMockTool({
        name: "mytool",
        description: "My tool description",
        inputSchema: { type: "object" },
      }),
    );

    const agent = createMockAgent(tools);
    const registry = createToolRegistry(agent);

    expect(registry.descriptors[0]?.description).toBe("My tool description");
  });
});

// ---------------------------------------------------------------------------
// executeBridgedTool
// ---------------------------------------------------------------------------

describe("executeBridgedTool", () => {
  test("executes tool and returns MCP text content", async () => {
    const tools = new Map<string, Tool>();
    tools.set("echo", {
      descriptor: { name: "echo", description: "Echo back", inputSchema: { type: "object" } },
      origin: "primordial",
      policy: DEFAULT_SANDBOXED_POLICY,
      execute: async (args: JsonObject) => `Echo: ${String(args.text)}`,
    });

    const registry: ToolRegistry = {
      tools,
      descriptors: [{ name: "echo", description: "Echo back", inputSchema: { type: "object" } }],
    };

    const result = await executeBridgedTool(registry, "echo", { text: "hello" });

    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.text).toBe("Echo: hello");
  });

  test("returns error for unknown tool", async () => {
    const registry: ToolRegistry = {
      tools: new Map(),
      descriptors: [],
    };

    const result = await executeBridgedTool(registry, "nonexistent", {});

    expect(result.content[0]?.text).toContain("Unknown tool");
    expect(result.content[0]?.text).toContain("nonexistent");
  });

  test("handles tool execution errors gracefully", async () => {
    const tools = new Map<string, Tool>();
    tools.set("failing", {
      descriptor: { name: "failing", description: "Always fails", inputSchema: { type: "object" } },
      origin: "primordial",
      policy: DEFAULT_SANDBOXED_POLICY,
      execute: async () => {
        throw new Error("Tool exploded");
      },
    });

    const registry: ToolRegistry = {
      tools,
      descriptors: [{ name: "failing", description: "Fails", inputSchema: { type: "object" } }],
    };

    const result = await executeBridgedTool(registry, "failing", {});

    expect(result.content[0]?.text).toContain("Tool execution error");
    expect(result.content[0]?.text).toContain("Tool exploded");
  });

  test("serializes non-string results as JSON", async () => {
    const tools = new Map<string, Tool>();
    tools.set("json-tool", {
      descriptor: {
        name: "json-tool",
        description: "Returns JSON",
        inputSchema: { type: "object" },
      },
      origin: "primordial",
      policy: DEFAULT_SANDBOXED_POLICY,
      execute: async () => ({ key: "value", count: 42 }),
    });

    const registry: ToolRegistry = {
      tools,
      descriptors: [{ name: "json-tool", description: "JSON", inputSchema: { type: "object" } }],
    };

    const result = await executeBridgedTool(registry, "json-tool", {});

    expect(result.content[0]?.text).toBe('{"key":"value","count":42}');
  });

  test("handles non-Error throws", async () => {
    const tools = new Map<string, Tool>();
    tools.set("string-throw", {
      descriptor: {
        name: "string-throw",
        description: "Throws string",
        inputSchema: { type: "object" },
      },
      origin: "primordial",
      policy: DEFAULT_SANDBOXED_POLICY,
      execute: async () => {
        throw "raw string error";
      },
    });

    const registry: ToolRegistry = {
      tools,
      descriptors: [
        { name: "string-throw", description: "Throws", inputSchema: { type: "object" } },
      ],
    };

    const result = await executeBridgedTool(registry, "string-throw", {});

    expect(result.content[0]?.text).toContain("raw string error");
  });
});

// ---------------------------------------------------------------------------
// createToolBridgeMcpServer
// ---------------------------------------------------------------------------

describe("createToolBridgeMcpServer", () => {
  test("creates MCP server config with tool bridge", () => {
    const tools = new Map<string, Tool>();
    tools.set(
      "search",
      createMockTool({
        name: "search",
        description: "Search",
        inputSchema: { type: "object" },
      }),
    );
    const agent = createMockAgent(tools);

    const mockTools: unknown[] = [];
    const mockCreateServer = (config: { name: string }) => ({ serverName: config.name });
    const mockToolFn = (name: string, desc: string, schema: unknown, handler: unknown) => {
      const toolDef = { name, desc, schema, handler };
      mockTools.push(toolDef);
      return toolDef;
    };

    const result = createToolBridgeMcpServer(agent, mockCreateServer, mockToolFn);

    expect(result).toBeDefined();
    expect(result?.config.type).toBe("sdk");
    expect(result?.config.name).toBe("koi_tools");
    expect(mockTools).toHaveLength(1);
  });

  test("returns undefined when agent has no tools", () => {
    const agent = createMockAgent(new Map());

    const result = createToolBridgeMcpServer(
      agent,
      () => ({}),
      () => ({}),
    );

    expect(result).toBeUndefined();
  });

  test("includes all tool descriptors in the MCP server", () => {
    const tools = new Map<string, Tool>();
    tools.set(
      "read",
      createMockTool({
        name: "read",
        description: "Read file",
        inputSchema: { type: "object" },
      }),
    );
    tools.set(
      "write",
      createMockTool({
        name: "write",
        description: "Write file",
        inputSchema: { type: "object" },
      }),
    );
    const agent = createMockAgent(tools);

    const registeredTools: string[] = [];
    const mockCreateServer = () => ({});
    const mockToolFn = (name: string) => {
      registeredTools.push(name);
      return {};
    };

    createToolBridgeMcpServer(agent, mockCreateServer, mockToolFn);

    expect(registeredTools).toContain("read");
    expect(registeredTools).toContain("write");
    expect(registeredTools).toHaveLength(2);
  });
});
