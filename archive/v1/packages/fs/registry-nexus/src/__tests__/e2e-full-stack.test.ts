/**
 * Full-stack E2E: createKoi + createPiAdapter + NexusRegistry + real Anthropic LLM.
 *
 * Validates the entire registry-nexus integration through the full L1 runtime:
 *   - NexusRegistryProvider attaches during agent assembly
 *   - Agent lifecycle: created → running → terminated tracked in Nexus
 *   - NexusRegistry watch events fire for register/transition/deregister
 *   - Real LLM streams text_delta events through middleware chain
 *   - Tool calls routed through middleware + resolved from entity
 *   - CAS generation tracking works end-to-end
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1.
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-full-stack.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  RegistryEntry,
  RegistryEvent,
  Tool,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { agentId, DEFAULT_SANDBOXED_POLICY, toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createNexusRegistryProvider } from "../component-provider.js";
import type { FetchFn, NexusRegistryConfig } from "../config.js";
import type { NexusAgent } from "../nexus-client.js";
import { createNexusRegistry } from "../nexus-registry.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Mock Nexus server (same pattern as unit tests, reused here)
// ---------------------------------------------------------------------------

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
    pollIntervalMs: 0,
    fetch: fetchFn,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

function testManifest(overrides?: Partial<AgentManifest>): AgentManifest {
  return {
    name: "E2E Registry-Nexus Agent",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const MULTIPLY_TOOL: Tool = {
  descriptor: {
    name: "multiply",
    description: "Multiplies two numbers together and returns the product.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
  },
  origin: "primordial",
  policy: DEFAULT_SANDBOXED_POLICY,
  execute: async (input: Readonly<Record<string, unknown>>) => {
    const a = Number(input.a ?? 0);
    const b = Number(input.b ?? 0);
    return String(a * b);
  },
};

const LOOKUP_TOOL: Tool = {
  descriptor: {
    name: "lookup_fact",
    description: "Looks up a fact about a topic. Always returns a test string.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic to look up" },
      },
      required: ["topic"],
    },
  },
  origin: "primordial",
  policy: DEFAULT_SANDBOXED_POLICY,
  execute: async (input: Readonly<Record<string, unknown>>) => {
    const topic = String(input.topic ?? "unknown");
    return JSON.stringify({ topic, fact: `${topic} is a well-known test topic.` });
  },
};

function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-tool-provider",
    attach: async () => new Map(tools.map((t) => [toolToken(t.descriptor.name) as string, t])),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: createKoi + createPiAdapter + NexusRegistry full stack", () => {
  // ── Test 1: Agent lifecycle tracked through Nexus registry ──────────

  test(
    "agent lifecycle: assembly registers in Nexus, run transitions, dispose cleans up",
    async () => {
      const server = createMockNexusServer();
      const config = createTestConfig(server.fetch);
      const registry = await createNexusRegistry(config);
      const nexusProvider = createNexusRegistryProvider(config);

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are concise. Reply with one word.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [nexusProvider],
        loopDetection: false,
      });

      // After assembly, agent should be registered in the mock Nexus server
      const agentPid = runtime.agent.pid;
      expect(server.agents.has(agentPid.id)).toBe(true);

      // Nexus agent should be in CONNECTED state after registration
      const nexusAgent = server.agents.get(agentPid.id);
      expect(nexusAgent?.state).toBe("CONNECTED");
      expect(nexusAgent?.metadata?.manifestName).toBe("E2E Registry-Nexus Agent");

      // Agent entity should start in "created" state
      expect(runtime.agent.state).toBe("created");

      // Run the agent with a real LLM call
      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly: pong" }),
      );

      // After run, agent transitions to terminated
      expect(runtime.agent.state).toBe("terminated");

      // LLM should have responded
      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");
      expect(output?.metrics.inputTokens).toBeGreaterThan(0);

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("pong");

      // Cleanup
      await runtime.dispose();
      await registry[Symbol.asyncDispose]();
    },
    TIMEOUT_MS,
  );

  // ── Test 2: NexusRegistry tracks multiple agents with watch events ──

  test(
    "NexusRegistry tracks agent and emits watch events during full runtime",
    async () => {
      const server = createMockNexusServer();
      const config = createTestConfig(server.fetch);
      const registry = await createNexusRegistry(config);

      // Collect registry events
      const registryEvents: RegistryEvent[] = [];
      registry.watch((event) => registryEvents.push(event));

      // Register an agent via the registry (simulating a peer agent on another node)
      const peerEntry: RegistryEntry = {
        agentId: agentId("peer-agent-1"),
        status: {
          phase: "running",
          generation: 0,
          conditions: ["Ready"],
          lastTransitionAt: Date.now(),
        },
        agentType: "worker",
        metadata: { skills: ["math", "lookup"] },
        registeredAt: Date.now(),
        priority: 10,
      };
      await registry.register(peerEntry);

      // Verify registered event was emitted
      expect(registryEvents.some((e) => e.kind === "registered")).toBe(true);

      // Lookup the peer agent
      const found = await registry.lookup(agentId("peer-agent-1"));
      expect(found).toBeDefined();
      expect(found?.status.phase).toBe("running");

      // Now run our own agent through the full createKoi path
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with one word only.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest({ name: "Registry-Aware Agent" }),
        adapter,
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "Say: hello" }));

      expect(findDoneOutput(events)?.stopReason).toBe("completed");

      // Transition the peer agent via registry
      const transitionResult = await registry.transition(agentId("peer-agent-1"), "terminated", 0, {
        kind: "completed",
      });
      expect(transitionResult.ok).toBe(true);

      // Verify transitioned event was emitted
      expect(registryEvents.some((e) => e.kind === "transitioned")).toBe(true);

      // Deregister peer
      await registry.deregister(agentId("peer-agent-1"));
      expect(registryEvents.some((e) => e.kind === "deregistered")).toBe(true);

      // Cleanup
      await runtime.dispose();
      await registry[Symbol.asyncDispose]();
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Tool call through middleware chain with registry context ──

  test(
    "tool call flows through middleware chain with Nexus provider attached",
    async () => {
      const server = createMockNexusServer();
      const config = createTestConfig(server.fetch);
      const nexusProvider = createNexusRegistryProvider(config);

      // let justified: capture tool call metadata for assertions
      let toolCallObserved = false;
      let observedToolId: string | undefined;

      const observerMiddleware: KoiMiddleware = {
        name: "tool-call-observer",
        describeCapabilities: () => undefined,
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCallObserved = true;
          observedToolId = request.toolId;
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the multiply tool to answer math questions. Do not compute in your head. Always use the tool.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [observerMiddleware],
        providers: [nexusProvider, createToolProvider([MULTIPLY_TOOL])],
        loopDetection: false,
      });

      // Agent should be registered in Nexus
      expect(server.agents.has(runtime.agent.pid.id)).toBe(true);

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the multiply tool to compute 7 * 8. Report the result.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Middleware must have intercepted the tool call
      expect(toolCallObserved).toBe(true);
      expect(observedToolId).toBe("multiply");

      // tool_call_start and tool_call_end events should exist
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      const toolEnds = events.filter((e) => e.kind === "tool_call_end");
      expect(toolStarts.length).toBeGreaterThanOrEqual(1);
      expect(toolEnds.length).toBeGreaterThanOrEqual(1);

      // Response should mention 56
      const text = extractText(events);
      expect(text).toContain("56");

      // Cleanup
      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Session lifecycle hooks fire with Nexus provider ─────────

  test(
    "session and turn lifecycle hooks fire alongside Nexus provider",
    async () => {
      const server = createMockNexusServer();
      const config = createTestConfig(server.fetch);
      const nexusProvider = createNexusRegistryProvider(config);

      const hookOrder: string[] = [];

      const lifecycleObserver: KoiMiddleware = {
        name: "lifecycle-observer",
        describeCapabilities: () => undefined,
        onSessionStart: async () => {
          hookOrder.push("session_start");
        },
        onSessionEnd: async () => {
          hookOrder.push("session_end");
        },
        onAfterTurn: async () => {
          hookOrder.push("after_turn");
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with one word only.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [lifecycleObserver],
        providers: [nexusProvider],
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Say: OK" }));

      // Session lifecycle must be correct
      expect(hookOrder[0]).toBe("session_start");
      expect(hookOrder[hookOrder.length - 1]).toBe("session_end");
      expect(hookOrder).toContain("after_turn");

      // Agent registered in Nexus
      expect(server.agents.has(runtime.agent.pid.id)).toBe(true);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 5: Multi-tool agent with registry and middleware ────────────

  test(
    "multi-tool agent with Nexus registration and middleware observing all calls",
    async () => {
      const server = createMockNexusServer();
      const config = createTestConfig(server.fetch);
      const nexusProvider = createNexusRegistryProvider(config);

      const toolCalls: string[] = [];

      const toolLogger: KoiMiddleware = {
        name: "tool-logger",
        describeCapabilities: () => undefined,
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCalls.push(request.toolId);
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You have access to multiply and lookup_fact tools. Always use tools when asked. Never compute yourself.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [toolLogger],
        providers: [nexusProvider, createToolProvider([MULTIPLY_TOOL, LOOKUP_TOOL])],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the multiply tool to compute 9 * 11. Then use lookup_fact for 'gravity'. Report both results.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // At least one tool should have been called
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);

      // Nexus should have the agent registered
      expect(server.agents.has(runtime.agent.pid.id)).toBe(true);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 6: Registry CAS transitions work with real runtime ─────────

  test(
    "registry CAS transitions track correctly through agent lifecycle",
    async () => {
      const server = createMockNexusServer();
      const config = createTestConfig(server.fetch);
      const registry = await createNexusRegistry(config);

      // Register agent manually to test CAS
      const entry: RegistryEntry = {
        agentId: agentId("cas-test-agent"),
        status: {
          phase: "created",
          generation: 0,
          conditions: [],
          lastTransitionAt: Date.now(),
        },
        agentType: "worker",
        metadata: {},
        registeredAt: Date.now(),
        priority: 10,
      };
      await registry.register(entry);

      // Transition: created → running (generation 0 → 1)
      const r1 = await registry.transition(agentId("cas-test-agent"), "running", 0, {
        kind: "assembly_complete",
      });
      expect(r1.ok).toBe(true);
      if (r1.ok) {
        expect(r1.value.status.phase).toBe("running");
        expect(r1.value.status.generation).toBe(1);
      }

      // CAS with stale generation should fail
      const r2 = await registry.transition(
        agentId("cas-test-agent"),
        "waiting",
        0, // stale — should be 1
        { kind: "assembly_complete" },
      );
      expect(r2.ok).toBe(false);
      if (!r2.ok) {
        expect(r2.error.code).toBe("CONFLICT");
      }

      // Transition with correct generation should succeed
      const r3 = await registry.transition(agentId("cas-test-agent"), "waiting", 1, {
        kind: "assembly_complete",
      });
      expect(r3.ok).toBe(true);
      if (r3.ok) {
        expect(r3.value.status.phase).toBe("waiting");
        expect(r3.value.status.generation).toBe(2);
      }

      // Nexus should reflect the current state
      const nexusAgent = server.agents.get("cas-test-agent");
      expect(nexusAgent).toBeDefined();
      expect(nexusAgent?.state).toBe("IDLE"); // waiting maps to IDLE

      await registry[Symbol.asyncDispose]();
    },
    TIMEOUT_MS,
  );

  // ── Test 7: Provider detach removes agent from Nexus ────────────────

  test(
    "ComponentProvider detach removes agent from Nexus on dispose",
    async () => {
      const server = createMockNexusServer();
      const config = createTestConfig(server.fetch);
      const nexusProvider = createNexusRegistryProvider(config);

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with one word.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [nexusProvider],
        loopDetection: false,
      });

      const agentPidId = runtime.agent.pid.id;

      // Registered during assembly
      expect(server.agents.has(agentPidId)).toBe(true);

      const events = await collectEvents(runtime.run({ kind: "text", text: "Say: done" }));

      expect(findDoneOutput(events)?.stopReason).toBe("completed");

      // Detach the provider manually (simulates agent teardown)
      await nexusProvider.detach?.(runtime.agent);

      // Agent should be removed from Nexus
      expect(server.agents.has(agentPidId)).toBe(false);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 8: Full round-trip — registry + agent + LLM + tool + event stream ──

  test(
    "full round-trip: registry watches while agent runs LLM + tools through createKoi",
    async () => {
      const server = createMockNexusServer();
      const config = createTestConfig(server.fetch);
      const registry = await createNexusRegistry(config);
      const nexusProvider = createNexusRegistryProvider(config);

      const registryEvents: RegistryEvent[] = [];
      registry.watch((event) => registryEvents.push(event));

      // Middleware that logs everything
      const hookLog: string[] = [];
      const fullObserver: KoiMiddleware = {
        name: "full-observer",
        describeCapabilities: () => undefined,
        onSessionStart: async () => {
          hookLog.push("session_start");
        },
        onSessionEnd: async () => {
          hookLog.push("session_end");
        },
        onAfterTurn: async () => {
          hookLog.push("after_turn");
        },
        wrapToolCall: async (_ctx, request, next) => {
          hookLog.push(`tool:${request.toolId}`);
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the multiply tool to answer math questions. Always use the tool.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest({ name: "Full Round-Trip Agent" }),
        adapter,
        middleware: [fullObserver],
        providers: [nexusProvider, createToolProvider([MULTIPLY_TOOL])],
        loopDetection: false,
      });

      const agentPidId = runtime.agent.pid.id;

      // Verify assembly registered agent in Nexus mock
      expect(server.agents.has(agentPidId)).toBe(true);
      const nexusBefore = server.agents.get(agentPidId);
      expect(nexusBefore?.state).toBe("CONNECTED");
      expect(nexusBefore?.metadata?.manifestName).toBe("Full Round-Trip Agent");

      // Run the agent
      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the multiply tool to compute 6 * 7. Tell me the answer.",
        }),
      );

      // Verify completion
      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");
      expect(output?.metrics.inputTokens).toBeGreaterThan(0);
      expect(output?.metrics.outputTokens).toBeGreaterThan(0);
      expect(output?.metrics.turns).toBeGreaterThan(0);

      // Text should contain 42
      const text = extractText(events);
      expect(text).toContain("42");

      // Middleware hooks should have fired correctly
      expect(hookLog[0]).toBe("session_start");
      expect(hookLog[hookLog.length - 1]).toBe("session_end");
      expect(hookLog.some((h) => h === "tool:multiply")).toBe(true);
      expect(hookLog.some((h) => h === "after_turn")).toBe(true);

      // EngineEvent stream should contain the full lifecycle
      expect(events.some((e) => e.kind === "text_delta")).toBe(true);
      expect(events.some((e) => e.kind === "tool_call_start")).toBe(true);
      expect(events.some((e) => e.kind === "tool_call_end")).toBe(true);
      expect(events.some((e) => e.kind === "turn_end")).toBe(true);
      expect(events.some((e) => e.kind === "done")).toBe(true);

      // Agent entity state should be terminated after run
      expect(runtime.agent.state).toBe("terminated");

      // Cleanup
      await nexusProvider.detach?.(runtime.agent);
      expect(server.agents.has(agentPidId)).toBe(false);

      await runtime.dispose();
      await registry[Symbol.asyncDispose]();
    },
    TIMEOUT_MS,
  );
});
