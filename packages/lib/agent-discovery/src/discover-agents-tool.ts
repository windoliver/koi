import type { JsonObject, Tool, ToolDescriptor } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import type { DiscoveryFilter, DiscoveryHandle } from "./types.js";

const DESCRIPTOR: ToolDescriptor = {
  name: "discover_agents",
  description: "Discover external coding agents available on the host machine",
  inputSchema: {
    type: "object",
    properties: {
      capability: { type: "string" },
      transport: { type: "string", enum: ["cli", "mcp", "a2a"] },
      source: { type: "string", enum: ["path", "mcp", "filesystem"] },
    },
    additionalProperties: false,
  },
  origin: "primordial",
};

function pickFilter(input: JsonObject): DiscoveryFilter {
  const { capability, transport, source } = input;
  const f: { -readonly [K in keyof DiscoveryFilter]: DiscoveryFilter[K] } = {};
  if (typeof capability === "string") f.capability = capability;
  if (transport === "cli" || transport === "mcp" || transport === "a2a") f.transport = transport;
  if (source === "path" || source === "mcp" || source === "filesystem") f.source = source;
  return f;
}

export function createDiscoverAgentsTool(discovery: DiscoveryHandle): Tool {
  return {
    descriptor: DESCRIPTOR,
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async (args) => {
      const filter = pickFilter(args);
      try {
        const agents = await discovery.discover({ filter });
        return { agents, count: agents.length };
      } catch {
        return { agents: [], count: 0 };
      }
    },
  };
}
