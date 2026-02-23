/**
 * Koi tools → MCP server bridge.
 *
 * Creates an in-process MCP server that exposes Koi tool components
 * to the Claude Agent SDK, enabling the SDK to call Koi-registered tools.
 */

import type { Agent, Tool } from "@koi/core";
import type { McpBridgeConfig } from "./policy-map.js";

/**
 * Tool registry for the MCP bridge — maps tool names to Koi Tool components.
 */
export interface ToolRegistry {
  readonly tools: ReadonlyMap<string, Tool>;
  readonly descriptors: readonly ToolBridgeDescriptor[];
}

/**
 * A tool descriptor suitable for MCP tool definition.
 */
export interface ToolBridgeDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/**
 * Build a tool registry from an agent's tool components.
 *
 * Queries the agent for all tool components and builds a lookup map.
 */
export function buildToolRegistry(agent: Agent): ToolRegistry {
  const toolComponents = agent.query("tool:");
  const tools = new Map<string, Tool>();
  const descriptors: ToolBridgeDescriptor[] = [];

  for (const [key, component] of toolComponents) {
    const tool = component as Tool;
    const toolName = key.replace("tool:", "");

    tools.set(toolName, tool);
    descriptors.push({
      name: toolName,
      description: tool.descriptor.description,
      inputSchema: tool.descriptor.inputSchema as Readonly<Record<string, unknown>>,
    });
  }

  return { tools, descriptors };
}

/**
 * Execute a tool from the registry by name.
 *
 * Returns the result as an MCP-compatible text content response.
 */
export async function executeBridgedTool(
  registry: ToolRegistry,
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): Promise<{ readonly content: readonly { readonly type: "text"; readonly text: string }[] }> {
  const tool = registry.tools.get(toolName);
  if (tool === undefined) {
    return {
      content: [{ type: "text", text: `Error: Unknown tool "${toolName}"` }],
    };
  }

  try {
    const result = await tool.execute(args);
    const text = typeof result === "string" ? result : JSON.stringify(result);
    return { content: [{ type: "text", text }] };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Tool execution error: ${message}` }],
    };
  }
}

/**
 * Create an in-process MCP server config that bridges Koi tools to the SDK.
 *
 * Returns `undefined` if the agent has no tool components,
 * meaning no MCP bridge is needed.
 *
 * @param agent - The Koi agent to bridge tools from
 * @param createMcpServerFn - The SDK's createSdkMcpServer function
 * @param toolFn - The SDK's tool() helper function
 * @returns MCP server config or undefined if no tools
 */
export function createToolBridgeMcpServer(
  agent: Agent,
  createMcpServerFn: (config: {
    readonly name: string;
    readonly version: string;
    readonly tools: readonly unknown[];
  }) => unknown,
  toolFn: (
    name: string,
    description: string,
    schema: unknown,
    handler: (args: Readonly<Record<string, unknown>>) => Promise<unknown>,
  ) => unknown,
): { readonly config: McpBridgeConfig; readonly registry: ToolRegistry } | undefined {
  const registry = buildToolRegistry(agent);

  if (registry.descriptors.length === 0) {
    return undefined;
  }

  const mcpTools = registry.descriptors.map((desc) =>
    toolFn(desc.name, desc.description, desc.inputSchema, async (args) =>
      executeBridgedTool(registry, desc.name, args),
    ),
  );

  const server = createMcpServerFn({
    name: "koi_tools",
    version: "1.0.0",
    tools: mcpTools,
  });

  const config: McpBridgeConfig = {
    type: "sdk",
    name: "koi_tools",
    instance: server,
  };

  return { config, registry };
}
