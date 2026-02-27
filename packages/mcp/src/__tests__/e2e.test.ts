/**
 * End-to-end tests using a real MCP server + client via InMemoryTransport.
 *
 * Verifies the full MCP protocol round-trip: server registers tools,
 * client discovers them, adapter layers wrap them as Koi components,
 * and tool execution produces real results.
 *
 * No mocks — this exercises the actual MCP SDK protocol.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { AttachResult, JsonObject, Tool } from "@koi/core";
import { agentId, isAttachResult, toolToken } from "@koi/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpClientManager, McpToolInfo } from "../client-manager.js";
import { createMcpComponentProvider } from "../component-provider.js";
import type { ResolvedMcpServerConfig } from "../config.js";
import { createMcpResolver } from "../resolver.js";
import { mapMcpToolToKoi } from "../tool-adapter.js";

function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

// ---------------------------------------------------------------------------
// Test server setup
// ---------------------------------------------------------------------------

interface TestServerPair {
  readonly server: Server;
  readonly client: Client;
  readonly close: () => Promise<void>;
}

async function createTestServerPair(): Promise<TestServerPair> {
  const server = new Server(
    { name: "e2e-test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "Echoes the input message back",
        inputSchema: {
          type: "object" as const,
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
      {
        name: "add",
        description: "Adds two numbers together",
        inputSchema: {
          type: "object" as const,
          properties: {
            a: { type: "number" },
            b: { type: "number" },
          },
          required: ["a", "b"],
        },
      },
      {
        name: "fail",
        description: "Always returns an error",
        inputSchema: { type: "object" as const },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    switch (name) {
      case "echo":
        return {
          content: [{ type: "text" as const, text: String(args.message) }],
        };
      case "add":
        return {
          content: [
            {
              type: "text" as const,
              text: String(Number(args.a) + Number(args.b)),
            },
          ],
        };
      case "fail":
        return {
          content: [{ type: "text" as const, text: "Something went wrong" }],
          isError: true,
        };
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);

  const client = new Client({ name: "e2e-test-client", version: "1.0.0" });
  await client.connect(clientTransport);

  const close = async (): Promise<void> => {
    await client.close();
    await server.close();
  };

  return { server, client, close };
}

/**
 * Wraps a real MCP SDK Client as an McpClientManager.
 * Used to bridge the E2E client with the Koi adapter layers.
 */
function wrapClientAsManager(sdkClient: Client, name: string): McpClientManager {
  let connected = true;

  return {
    connect: async () => ({ ok: true as const, value: undefined }),
    listTools: async () => {
      try {
        const response = await sdkClient.listTools();
        const tools: readonly McpToolInfo[] = response.tools.map((t) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: (t.inputSchema ?? { type: "object" }) as JsonObject,
        }));
        return { ok: true as const, value: tools };
      } catch (error: unknown) {
        return {
          ok: false as const,
          error: {
            code: "EXTERNAL" as const,
            message: String(error),
            retryable: false,
          },
        };
      }
    },
    callTool: async (toolName, args) => {
      try {
        const result = await sdkClient.callTool({
          name: toolName,
          arguments: args as Record<string, unknown>,
        });
        const content = result.content as readonly Record<string, unknown>[];

        if (result.isError === true) {
          const errorText = content
            .filter(
              (
                c,
              ): c is Record<string, unknown> & {
                readonly type: "text";
                readonly text: string;
              } => c.type === "text" && typeof c.text === "string",
            )
            .map((c) => c.text)
            .join("\n");
          return {
            ok: false as const,
            error: {
              code: "EXTERNAL" as const,
              message: errorText || "unknown error",
              retryable: false,
            },
          };
        }

        return { ok: true as const, value: content };
      } catch (error: unknown) {
        return {
          ok: false as const,
          error: {
            code: "EXTERNAL" as const,
            message: String(error),
            retryable: false,
          },
        };
      }
    },
    close: async () => {
      connected = false;
    },
    isConnected: () => connected,
    serverName: () => name,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let activePair: TestServerPair | undefined;

afterEach(async () => {
  if (activePair !== undefined) {
    await activePair.close();
    activePair = undefined;
  }
});

describe("E2E: real MCP protocol via InMemoryTransport", () => {
  test("SDK client lists tools from real server", async () => {
    activePair = await createTestServerPair();

    const result = await activePair.client.listTools();
    expect(result.tools).toHaveLength(3);
    expect(result.tools.map((t) => t.name)).toContain("echo");
    expect(result.tools.map((t) => t.name)).toContain("add");
    expect(result.tools.map((t) => t.name)).toContain("fail");
  });

  test("SDK client calls echo tool on real server", async () => {
    activePair = await createTestServerPair();

    const result = await activePair.client.callTool({
      name: "echo",
      arguments: { message: "Hello, MCP!" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as readonly { type: string; text: string }[];
    expect(content).toHaveLength(1);
    expect(content[0]?.text).toBe("Hello, MCP!");
  });

  test("SDK client calls add tool on real server", async () => {
    activePair = await createTestServerPair();

    const result = await activePair.client.callTool({
      name: "add",
      arguments: { a: 17, b: 25 },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as readonly { type: string; text: string }[];
    expect(content[0]?.text).toBe("42");
  });

  test("SDK client receives isError from failing tool", async () => {
    activePair = await createTestServerPair();

    const result = await activePair.client.callTool({
      name: "fail",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const content = result.content as readonly { type: string; text: string }[];
    expect(content[0]?.text).toBe("Something went wrong");
  });
});

describe("E2E: Koi adapter layers with real MCP server", () => {
  test("mapMcpToolToKoi wraps real MCP tool and executes it", async () => {
    activePair = await createTestServerPair();
    const manager = wrapClientAsManager(activePair.client, "e2e-server");

    const toolsResult = await manager.listTools();
    expect(toolsResult.ok).toBe(true);
    if (!toolsResult.ok) return;

    const echoInfo = toolsResult.value.find((t) => t.name === "echo");
    expect(echoInfo).toBeDefined();
    if (echoInfo === undefined) return;

    const tool = mapMcpToolToKoi(echoInfo, manager, "e2e-server");
    expect(tool.descriptor.name).toBe("mcp/e2e-server/echo");
    expect(tool.trustTier).toBe("promoted");

    const result = await tool.execute({ message: "E2E test" });
    expect(result).toEqual([{ type: "text", text: "E2E test" }]);
  });

  test("mapMcpToolToKoi returns error for failing tool", async () => {
    activePair = await createTestServerPair();
    const manager = wrapClientAsManager(activePair.client, "e2e-server");

    const toolsResult = await manager.listTools();
    if (!toolsResult.ok) return;

    const failInfo = toolsResult.value.find((t) => t.name === "fail");
    if (failInfo === undefined) return;

    const tool = mapMcpToolToKoi(failInfo, manager, "e2e-server");
    const result = (await tool.execute({})) as { ok: boolean };
    expect(result.ok).toBe(false);
  });

  test("createMcpResolver discovers and loads real MCP tools", async () => {
    activePair = await createTestServerPair();
    const manager = wrapClientAsManager(activePair.client, "e2e-server");

    const resolver = createMcpResolver([manager]);

    // Discover
    const descriptors = await resolver.discover();
    expect(descriptors).toHaveLength(3);
    expect(descriptors.map((d) => d.name)).toContain("mcp/e2e-server/echo");
    expect(descriptors.map((d) => d.name)).toContain("mcp/e2e-server/add");
    expect(descriptors.map((d) => d.name)).toContain("mcp/e2e-server/fail");

    // Load and execute
    const loadResult = await resolver.load("mcp/e2e-server/add");
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const execResult = await loadResult.value.execute({ a: 10, b: 32 });
    expect(execResult).toEqual([{ type: "text", text: "42" }]);
  });

  test("createMcpComponentProvider attaches real tools via DI", async () => {
    activePair = await createTestServerPair();
    const manager = wrapClientAsManager(activePair.client, "e2e-test");

    // Use createManager DI to inject the real client wrapper
    const createManager = (
      _config: ResolvedMcpServerConfig,
      _timeout: number,
      _attempts: number,
    ): McpClientManager => manager;

    const result = await createMcpComponentProvider(
      {
        servers: [
          {
            name: "e2e-test",
            transport: "stdio",
            command: "unused",
            mode: "tools",
          },
        ],
      },
      createManager,
    );

    expect(result.failures).toHaveLength(0);
    expect(result.clients).toHaveLength(1);

    const agent = {
      pid: { id: agentId("e2e-1"), name: "e2e", type: "worker" as const, depth: 0 },
      manifest: {
        name: "e2e-agent",
        version: "1.0.0",
        model: { name: "test" },
        tools: [],
        channels: [],
        middleware: [],
      },
      state: "running" as const,
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    };

    const components = extractMap(await result.provider.attach(agent));
    expect(components.size).toBe(3);

    // Execute echo tool through the component
    const echoTool = components.get(toolToken("mcp/e2e-test/echo") as string) as Tool;
    expect(echoTool).toBeDefined();

    const echoResult = await echoTool.execute({ message: "Real E2E!" });
    expect(echoResult).toEqual([{ type: "text", text: "Real E2E!" }]);

    // Execute add tool through the component
    const addTool = components.get(toolToken("mcp/e2e-test/add") as string) as Tool;
    const addResult = await addTool.execute({ a: 100, b: 23 });
    expect(addResult).toEqual([{ type: "text", text: "123" }]);
  });
});
