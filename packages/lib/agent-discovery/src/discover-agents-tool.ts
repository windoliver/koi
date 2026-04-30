import type { Tool, ToolDescriptor } from "@koi/core";
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

function pickFilter(input: unknown): DiscoveryFilter {
  // Fail closed on malformed payloads (null, arrays, primitives) — return an
  // empty filter rather than throwing on destructure.
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {};
  }
  const f: { -readonly [K in keyof DiscoveryFilter]: DiscoveryFilter[K] } = {};
  if ("capability" in input && typeof input.capability === "string") {
    f.capability = input.capability;
  }
  if ("transport" in input) {
    const t = input.transport;
    if (t === "cli" || t === "mcp" || t === "a2a") f.transport = t;
  }
  if ("source" in input) {
    const s = input.source;
    if (s === "path" || s === "mcp" || s === "filesystem") f.source = s;
  }
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
