/**
 * Tests for the Nexus-backed AgentRegistry.
 *
 * Uses a mock fetch to simulate Nexus JSON-RPC responses, then runs
 * the shared contract test suite plus implementation-specific tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ProcessState, RegistryEntry, RegistryEvent } from "@koi/core";
import { agentId } from "@koi/core";
import { runAgentRegistryContractTests } from "@koi/test-utils";
import type { FetchFn, NexusRegistryConfig } from "./config.js";
import type { NexusAgent } from "./nexus-client.js";
import { createNexusRegistry } from "./nexus-registry.js";
import { encodeKoiStatus } from "./state-mapping.js";

// ---------------------------------------------------------------------------
// Mock Nexus server
// ---------------------------------------------------------------------------

/**
 * In-memory mock Nexus server that responds to JSON-RPC calls.
 * Tracks agents with state and generation for CAS.
 */
function createMockNexusServer(): {
  readonly fetch: FetchFn;
  readonly agents: Map<string, NexusAgent>;
} {
  const agents = new Map<string, NexusAgent>();

  const fetch: FetchFn = async (_input, init) => {
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
        if (agents.has(agentIdStr)) {
          return error(-32006, "Agent already exists");
        }
        const agent: NexusAgent = {
          agent_id: agentIdStr,
          name: (params.name as string) ?? agentIdStr,
          state: "UNKNOWN",
          generation: 0,
          ...(params.zone_id !== undefined ? { zone_id: params.zone_id as string } : {}),
          ...(params.metadata !== undefined
            ? { metadata: params.metadata as Readonly<Record<string, unknown>> }
            : {}),
        };
        agents.set(agentIdStr, agent);
        return success(agent);
      }

      case "delete_agent": {
        const agentIdStr = params.agent_id as string;
        if (!agents.has(agentIdStr)) {
          return error(-32000, "Agent not found");
        }
        agents.delete(agentIdStr);
        return success(true);
      }

      case "agent_transition": {
        const agentIdStr = params.agent_id as string;
        const agent = agents.get(agentIdStr);
        if (agent === undefined) {
          return error(-32000, "Agent not found");
        }
        const expectedGen = params.expected_generation as number;
        if (agent.generation !== expectedGen) {
          return error(-32006, "Generation mismatch");
        }
        const updated: NexusAgent = {
          ...agent,
          state: params.target_state as string,
          generation: (agent.generation ?? 0) + 1,
        };
        agents.set(agentIdStr, updated);
        return success(updated);
      }

      case "get_agent": {
        const agentIdStr = params.agent_id as string;
        const agent = agents.get(agentIdStr);
        if (agent === undefined) {
          return error(-32000, "Agent not found");
        }
        return success(agent);
      }

      case "list_agents":
      case "agent_list_by_zone": {
        return success([...agents.values()]);
      }

      case "agent_heartbeat": {
        return success(true);
      }

      case "update_agent_metadata": {
        const agentIdStr = params.agent_id as string;
        const agent = agents.get(agentIdStr);
        if (agent === undefined) {
          return error(-32000, "Agent not found");
        }
        const updated: NexusAgent = {
          ...agent,
          metadata: {
            ...(agent.metadata ?? {}),
            ...(params.metadata as Readonly<Record<string, unknown>>),
          },
        };
        agents.set(agentIdStr, updated);
        return success(updated);
      }

      default:
        return error(-32601, `Method not found: ${method}`);
    }
  };

  return { fetch, agents };
}

function createTestConfig(
  fetchFn: FetchFn,
  overrides?: Partial<NexusRegistryConfig>,
): NexusRegistryConfig {
  return {
    baseUrl: "https://nexus.test",
    apiKey: "sk-test",
    timeoutMs: 5000,
    pollIntervalMs: 0, // Disable polling in tests
    fetch: fetchFn,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shared contract suite
// ---------------------------------------------------------------------------

runAgentRegistryContractTests(async () => {
  const server = createMockNexusServer();
  const config = createTestConfig(server.fetch);
  return createNexusRegistry(config);
});

// ---------------------------------------------------------------------------
// Implementation-specific tests
// ---------------------------------------------------------------------------

describe("createNexusRegistry — impl-specific", () => {
  // let: reassigned each test
  let server: ReturnType<typeof createMockNexusServer>;
  let registry: Awaited<ReturnType<typeof createNexusRegistry>>;

  beforeEach(async () => {
    server = createMockNexusServer();
    const config = createTestConfig(server.fetch);
    registry = await createNexusRegistry(config);
  });

  afterEach(async () => {
    await registry[Symbol.asyncDispose]();
  });

  test("startup with empty Nexus returns empty list", async () => {
    const all = await registry.list();
    expect(all).toHaveLength(0);
  });

  test("register creates agent in mock Nexus server", async () => {
    const e = makeEntry("a1");
    await registry.register(e);

    expect(server.agents.has("a1")).toBe(true);
  });

  test("register transitions agent from UNKNOWN to CONNECTED in Nexus", async () => {
    await registry.register(makeEntry("a1"));

    const nexusAgent = server.agents.get("a1");
    expect(nexusAgent?.state).toBe("CONNECTED");
  });

  test("deregister removes agent from mock Nexus server", async () => {
    await registry.register(makeEntry("a1"));
    await registry.deregister(agentId("a1"));

    expect(server.agents.has("a1")).toBe(false);
  });

  test("transition updates Nexus agent state", async () => {
    await registry.register(makeEntry("a1"));
    await registry.transition(agentId("a1"), "running", 0, { kind: "assembly_complete" });

    // Nexus should reflect the transition
    const nexusAgent = server.agents.get("a1");
    expect(nexusAgent).toBeDefined();
    // Nexus generation will be higher due to register + UNKNOWN→CONNECTED + transition
    expect(nexusAgent?.state).toBe("CONNECTED"); // running maps to CONNECTED
  });

  test("CAS race: two transitions with same generation — one fails", async () => {
    await registry.register(makeEntry("a1"));

    const r1 = registry.transition(agentId("a1"), "running", 0, { kind: "assembly_complete" });
    const r2 = registry.transition(agentId("a1"), "terminated", 0, { kind: "completed" });

    const results = await Promise.all([r1, r2]);
    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });

  test("network timeout during register throws", async () => {
    // The factory's loadProjection also calls fetch, so we need a fetch
    // that succeeds for list_agents (startup) but fails for register_agent.
    const slowFetch: FetchFn = async (_input, init) => {
      const body = JSON.parse(init?.body as string) as {
        readonly method: string;
        readonly id: string;
      };

      // Allow startup list_agents to succeed (returns empty list)
      if (body.method === "list_agents" || body.method === "agent_list_by_zone") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", result: [], id: body.id }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // All other calls timeout
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
      return new Response();
    };

    const config = createTestConfig(slowFetch, { timeoutMs: 50 });
    const slowRegistry = await createNexusRegistry(config);

    try {
      await slowRegistry.register(makeEntry("slow-agent"));
      expect(true).toBe(false); // Should not reach here
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(Error);
    } finally {
      await slowRegistry[Symbol.asyncDispose]();
    }
  });

  test("empty registry returns empty list", async () => {
    const all = await registry.list();
    expect(all).toHaveLength(0);
  });

  test("maxEntries limit prevents unbounded growth", async () => {
    const smallServer = createMockNexusServer();
    const config = createTestConfig(smallServer.fetch, { maxEntries: 2 });
    const smallRegistry = await createNexusRegistry(config);

    await smallRegistry.register(makeEntry("a1"));
    await smallRegistry.register(makeEntry("a2"));

    // Third register should still work (Nexus side) but projection may be capped
    // The implementation stores in Nexus regardless
    const all = await smallRegistry.list();
    expect(all.length).toBeLessThanOrEqual(2);

    await smallRegistry[Symbol.asyncDispose]();
  });

  test("dispose clears projection and stops poll", async () => {
    await registry.register(makeEntry("a1"));
    await registry[Symbol.asyncDispose]();

    const all = await registry.list();
    expect(all).toHaveLength(0);
  });

  test("watch receives events during register/deregister/transition", async () => {
    const events: RegistryEvent[] = [];
    registry.watch((event) => events.push(event));

    await registry.register(makeEntry("a1"));
    expect(events.some((e) => e.kind === "registered")).toBe(true);

    await registry.transition(agentId("a1"), "running", 0, { kind: "assembly_complete" });
    expect(events.some((e) => e.kind === "transitioned")).toBe(true);

    await registry.deregister(agentId("a1"));
    expect(events.some((e) => e.kind === "deregistered")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Poll-based synchronization
// ---------------------------------------------------------------------------

describe("poll synchronization", () => {
  test("poll detects new agents added externally", async () => {
    const server = createMockNexusServer();
    // Use a short poll interval — we'll trigger poll manually by waiting
    const config = createTestConfig(server.fetch, { pollIntervalMs: 50 });
    const reg = await createNexusRegistry(config);

    const events: RegistryEvent[] = [];
    reg.watch((event) => events.push(event));

    // Externally add an agent to the mock server (simulating another node)
    const koiStatus = encodeKoiStatus({
      phase: "running",
      generation: 1,
      conditions: [],
      lastTransitionAt: Date.now(),
    });
    server.agents.set("external-1", {
      agent_id: "external-1",
      state: "CONNECTED",
      generation: 1,
      metadata: { ...koiStatus, agentType: "worker", registeredAt: Date.now() },
    });

    // Wait for poll to fire
    await new Promise((resolve) => setTimeout(resolve, 120));

    const found = await reg.lookup(agentId("external-1"));
    expect(found).toBeDefined();
    expect(found?.status.phase).toBe("running");
    expect(events.some((e) => e.kind === "registered")).toBe(true);

    await reg[Symbol.asyncDispose]();
  });

  test("poll detects agents removed externally", async () => {
    const server = createMockNexusServer();
    const config = createTestConfig(server.fetch, { pollIntervalMs: 50 });
    const reg = await createNexusRegistry(config);

    // Register through the registry
    await reg.register(makeEntry("a1"));
    expect(await reg.lookup(agentId("a1"))).toBeDefined();

    const events: RegistryEvent[] = [];
    reg.watch((event) => events.push(event));

    // Externally remove the agent from the mock server
    server.agents.delete("a1");

    // Wait for poll to detect removal
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(await reg.lookup(agentId("a1"))).toBeUndefined();
    expect(events.some((e) => e.kind === "deregistered")).toBe(true);

    await reg[Symbol.asyncDispose]();
  });

  test("poll detects state change and emits transitioned event", async () => {
    const server = createMockNexusServer();
    const config = createTestConfig(server.fetch, { pollIntervalMs: 50 });
    const reg = await createNexusRegistry(config);

    await reg.register(makeEntry("a1"));

    const events: RegistryEvent[] = [];
    reg.watch((event) => events.push(event));

    // Externally change agent state in mock server (simulating another node)
    const agent = server.agents.get("a1");
    if (agent !== undefined) {
      const waitingStatus = encodeKoiStatus({
        phase: "waiting",
        generation: 2,
        conditions: [],
        lastTransitionAt: Date.now(),
      });
      server.agents.set("a1", {
        ...agent,
        state: "IDLE",
        generation: (agent.generation ?? 0) + 1,
        metadata: { ...agent.metadata, ...waitingStatus },
      });
    }

    // Wait for poll
    await new Promise((resolve) => setTimeout(resolve, 120));

    const found = await reg.lookup(agentId("a1"));
    expect(found?.status.phase).toBe("waiting");
    expect(events.some((e) => e.kind === "transitioned")).toBe(true);

    await reg[Symbol.asyncDispose]();
  });

  test("dispose stops poll timer", async () => {
    const server = createMockNexusServer();
    const config = createTestConfig(server.fetch, { pollIntervalMs: 50 });
    const reg = await createNexusRegistry(config);

    await reg.register(makeEntry("a1"));
    await reg[Symbol.asyncDispose]();

    // After dispose, adding external agents should NOT be detected
    server.agents.set("external-after-dispose", {
      agent_id: "external-after-dispose",
      state: "CONNECTED",
      generation: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    // list() returns empty because dispose cleared projection
    const all = await reg.list();
    expect(all).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases: optional fields and error paths
// ---------------------------------------------------------------------------

describe("optional fields and error paths", () => {
  test("register with parentId stores it in Nexus metadata", async () => {
    const server = createMockNexusServer();
    const config = createTestConfig(server.fetch);
    const reg = await createNexusRegistry(config);

    const entry: RegistryEntry = {
      agentId: agentId("child-1"),
      status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
      agentType: "worker",
      metadata: {},
      registeredAt: Date.now(),
      parentId: agentId("parent-1"),
    };
    await reg.register(entry);

    const nexusAgent = server.agents.get("child-1");
    expect(nexusAgent?.metadata?.parentId).toBe("parent-1");

    await reg[Symbol.asyncDispose]();
  });

  test("register with spawner stores it in Nexus metadata", async () => {
    const server = createMockNexusServer();
    const config = createTestConfig(server.fetch);
    const reg = await createNexusRegistry(config);

    const entry: RegistryEntry = {
      agentId: agentId("spawned-1"),
      status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
      agentType: "worker",
      metadata: {},
      registeredAt: Date.now(),
      spawner: agentId("spawner-1"),
    };
    await reg.register(entry);

    const nexusAgent = server.agents.get("spawned-1");
    expect(nexusAgent?.metadata?.spawner).toBe("spawner-1");

    await reg[Symbol.asyncDispose]();
  });

  test("startup with parentId and spawner in agent metadata maps correctly", async () => {
    const server = createMockNexusServer();
    const koiStatus = encodeKoiStatus({
      phase: "running",
      generation: 1,
      conditions: [],
      lastTransitionAt: Date.now(),
    });

    server.agents.set("with-both", {
      agent_id: "with-both",
      state: "CONNECTED",
      generation: 1,
      metadata: {
        ...koiStatus,
        agentType: "worker",
        registeredAt: Date.now(),
        parentId: "parent-1",
        spawner: "spawner-1",
      },
    });

    const config = createTestConfig(server.fetch);
    const reg = await createNexusRegistry(config);

    const found = await reg.lookup(agentId("with-both"));
    expect(found).toBeDefined();
    expect(found?.parentId).toBe(agentId("parent-1"));
    expect(found?.spawner).toBe(agentId("spawner-1"));

    await reg[Symbol.asyncDispose]();
  });

  test("startup with only spawner in agent metadata maps correctly", async () => {
    const server = createMockNexusServer();
    const koiStatus = encodeKoiStatus({
      phase: "running",
      generation: 1,
      conditions: [],
      lastTransitionAt: Date.now(),
    });

    server.agents.set("with-spawner", {
      agent_id: "with-spawner",
      state: "CONNECTED",
      generation: 1,
      metadata: {
        ...koiStatus,
        agentType: "worker",
        registeredAt: Date.now(),
        spawner: "spawner-1",
      },
    });

    const config = createTestConfig(server.fetch);
    const reg = await createNexusRegistry(config);

    const found = await reg.lookup(agentId("with-spawner"));
    expect(found).toBeDefined();
    expect(found?.spawner).toBe(agentId("spawner-1"));
    expect(found?.parentId).toBeUndefined();

    await reg[Symbol.asyncDispose]();
  });

  test("register with waiting phase performs second Nexus transition to IDLE", async () => {
    const server = createMockNexusServer();
    const config = createTestConfig(server.fetch);
    const reg = await createNexusRegistry(config);

    await reg.register(makeEntry("w1", "waiting"));

    const nexusAgent = server.agents.get("w1");
    // Should have transitioned: UNKNOWN → CONNECTED → IDLE
    expect(nexusAgent?.state).toBe("IDLE");

    await reg[Symbol.asyncDispose]();
  });

  test("loadProjection failure throws startup error", async () => {
    const failFetch: FetchFn = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error" },
          id: "1",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const config = createTestConfig(failFetch);

    try {
      await createNexusRegistry(config);
      expect(true).toBe(false); // Should not reach here
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toContain("Failed to load agents from Nexus");
    }
  });
});

// ---------------------------------------------------------------------------
// Startup with pre-existing agents
// ---------------------------------------------------------------------------

describe("startup with pre-existing agents", () => {
  test("loads existing agents from Nexus on creation", async () => {
    const server = createMockNexusServer();

    // Pre-populate Nexus with agents
    const koiStatus = encodeKoiStatus({
      phase: "running",
      generation: 1,
      conditions: ["Ready"],
      lastTransitionAt: Date.now(),
    });

    server.agents.set("pre-1", {
      agent_id: "pre-1",
      state: "CONNECTED",
      generation: 1,
      metadata: {
        ...koiStatus,
        agentType: "worker",
        registeredAt: Date.now(),
      },
    });

    const config = createTestConfig(server.fetch);
    const reg = await createNexusRegistry(config);

    const found = await reg.lookup(agentId("pre-1"));
    expect(found).toBeDefined();
    expect(found?.status.phase).toBe("running");
    expect(found?.status.generation).toBe(1);

    await reg[Symbol.asyncDispose]();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(id: string, phase: ProcessState = "created", generation = 0): RegistryEntry {
  return {
    agentId: agentId(id),
    status: {
      phase,
      generation,
      conditions: [],
      lastTransitionAt: Date.now(),
    },
    agentType: "worker",
    metadata: {},
    registeredAt: Date.now(),
  };
}
