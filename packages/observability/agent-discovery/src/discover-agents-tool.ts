/**
 * discover_agents tool — exposes agent discovery as a Koi Tool.
 *
 * Agents can call this tool to discover external coding agents available
 * on the host machine. Supports filtering by capability, transport, and source.
 */

import type {
  ExternalAgentSource,
  ExternalAgentTransport,
  JsonObject,
  Tool,
  ToolDescriptor,
} from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import type { DiscoveryHandle } from "./discovery.js";

const VALID_TRANSPORTS = new Set<string>(["cli", "mcp", "a2a"]);
const VALID_SOURCES = new Set<string>(["path", "mcp", "filesystem"]);

/** Type guard for ExternalAgentTransport. */
function isValidTransport(value: string): value is ExternalAgentTransport {
  return VALID_TRANSPORTS.has(value);
}

/** Type guard for ExternalAgentSource. */
function isValidSource(value: string): value is ExternalAgentSource {
  return VALID_SOURCES.has(value);
}

const TOOL_DESCRIPTOR: ToolDescriptor = {
  name: "discover_agents",
  description:
    "Discover external coding agents (Claude Code, Codex, Aider, etc.) available on the host machine. " +
    "Returns a list of agent descriptors with name, transport, capabilities, and health status.",
  inputSchema: {
    type: "object",
    properties: {
      capability: {
        type: "string",
        description: "Filter by capability (e.g., 'code-generation', 'code-review')",
      },
      transport: {
        type: "string",
        description: "Filter by transport protocol: 'cli', 'mcp', or 'a2a'",
        enum: ["cli", "mcp", "a2a"],
      },
      source: {
        type: "string",
        description: "Filter by discovery source: 'path', 'mcp', or 'filesystem'",
        enum: ["path", "mcp", "filesystem"],
      },
    },
    additionalProperties: false,
  },
};

/**
 * Creates a Tool that discovers external agents with optional filtering.
 */
export function createDiscoverAgentsTool(discovery: DiscoveryHandle): Tool {
  return {
    descriptor: TOOL_DESCRIPTOR,
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,

    execute: async (args: JsonObject): Promise<unknown> => {
      const capability = typeof args.capability === "string" ? args.capability : undefined;
      const rawTransport = typeof args.transport === "string" ? args.transport : undefined;
      const rawSource = typeof args.source === "string" ? args.source : undefined;

      const transport =
        rawTransport !== undefined && isValidTransport(rawTransport) ? rawTransport : undefined;
      const source = rawSource !== undefined && isValidSource(rawSource) ? rawSource : undefined;

      const agents = await discovery.discover({
        filter: { capability, transport, source },
      });

      return { agents, count: agents.length };
    },
  };
}
