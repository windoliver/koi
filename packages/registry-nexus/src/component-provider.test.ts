/**
 * Tests for the Nexus registry ComponentProvider.
 */

import { describe, expect, test } from "bun:test";
import type { Agent, AgentManifest, ProcessId, ProcessState } from "@koi/core";
import { agentId } from "@koi/core";
import { createNexusRegistryProvider } from "./component-provider.js";
import type { NexusRegistryConfig } from "./config.js";
import type { NexusAgent } from "./nexus-client.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockAgent(id: string, state: ProcessState = "created"): Agent {
  const pid: ProcessId = {
    id: agentId(id),
    name: `test-${id}`,
    type: "worker",
    depth: 0,
  };

  const manifest: AgentManifest = {
    name: `test-${id}`,
    model: { provider: "test", id: "test-model" },
    channels: [],
  };

  return {
    pid,
    manifest,
    state,
    component: () => undefined,
    has: () => false,
    hasAll: () => false,
    query: () => new Map(),
    components: () => new Map(),
  };
}

function createMockConfig(): {
  readonly config: NexusRegistryConfig;
  readonly agents: Map<string, NexusAgent>;
} {
  const agents = new Map<string, NexusAgent>();

  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(init?.body as string) as {
      readonly method: string;
      readonly params: Readonly<Record<string, unknown>>;
      readonly id: string;
    };

    const { method, params, id } = body;

    const success = (result: unknown): Response =>
      new Response(JSON.stringify({ jsonrpc: "2.0", result, id }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const error = (code: number, message: string): Response =>
      new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    switch (method) {
      case "register_agent": {
        const agentIdStr = params.agent_id as string;
        const agent: NexusAgent = {
          agent_id: agentIdStr,
          state: "UNKNOWN",
          generation: 0,
          metadata: params.metadata as Readonly<Record<string, unknown>> | undefined,
        };
        agents.set(agentIdStr, agent);
        return success(agent);
      }

      case "agent_transition": {
        const agentIdStr = params.agent_id as string;
        const agent = agents.get(agentIdStr);
        if (agent === undefined) return error(-32000, "not found");
        const updated: NexusAgent = {
          ...agent,
          state: params.target_state as string,
          generation: (agent.generation ?? 0) + 1,
        };
        agents.set(agentIdStr, updated);
        return success(updated);
      }

      case "delete_agent": {
        const agentIdStr = params.agent_id as string;
        agents.delete(agentIdStr);
        return success(true);
      }

      default:
        return success({});
    }
  };

  const config: NexusRegistryConfig = {
    baseUrl: "https://nexus.test",
    apiKey: "sk-test",
    timeoutMs: 5000,
    fetch,
  };

  return { config, agents };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createNexusRegistryProvider", () => {
  test("has correct name", () => {
    const { config } = createMockConfig();
    const provider = createNexusRegistryProvider(config);
    expect(provider.name).toBe("registry-nexus");
  });

  test("attach registers agent in Nexus", async () => {
    const { config, agents } = createMockConfig();
    const provider = createNexusRegistryProvider(config);
    const agent = createMockAgent("test-1");

    await provider.attach(agent);

    expect(agents.has("test-1")).toBe(true);
  });

  test("attach transitions agent to CONNECTED", async () => {
    const { config, agents } = createMockConfig();
    const provider = createNexusRegistryProvider(config);
    const agent = createMockAgent("test-1");

    await provider.attach(agent);

    const nexusAgent = agents.get("test-1");
    expect(nexusAgent?.state).toBe("CONNECTED");
  });

  test("attach returns empty components map", async () => {
    const { config } = createMockConfig();
    const provider = createNexusRegistryProvider(config);
    const agent = createMockAgent("test-1");

    const result = await provider.attach(agent);
    expect(result.components.size).toBe(0);
    expect(result.skipped).toHaveLength(0);
  });

  test("detach removes agent from Nexus", async () => {
    const { config, agents } = createMockConfig();
    const provider = createNexusRegistryProvider(config);
    const agent = createMockAgent("test-1");

    await provider.attach(agent);
    expect(agents.has("test-1")).toBe(true);

    await provider.detach?.(agent);
    expect(agents.has("test-1")).toBe(false);
  });
});
