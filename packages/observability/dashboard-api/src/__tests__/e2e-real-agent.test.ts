/**
 * End-to-end test: Dashboard ↔ Real Agent ↔ Real LLM.
 *
 * Validates the full pipeline:
 *   1. createPiAdapter + createKoi → real Anthropic LLM call
 *   2. AgentHost manages agent lifecycle
 *   3. DashboardDataSource adapter bridges host → dashboard types
 *   4. createDashboardHandler serves REST + SSE
 *   5. HTTP client verifies: agent appears, SSE events stream, terminate works
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-real-agent.test.ts
 *
 * Requires:
 *   - ANTHROPIC_API_KEY in .env (Bun auto-loads)
 *   - E2E_TESTS=1 environment variable
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  AgentId,
  AgentManifest,
  ComponentProvider,
  EngineEvent,
  ProcessId,
  ProcessState,
  Tool,
} from "@koi/core";
import { agentId, DEFAULT_SANDBOXED_POLICY, toolToken } from "@koi/core";
import type {
  DashboardAgentDetail,
  DashboardAgentSummary,
  DashboardChannelSummary,
  DashboardDataSource,
  DashboardEvent,
  DashboardSkillSummary,
  DashboardSystemMetrics,
} from "@koi/dashboard-types";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import type { AgentHost } from "@koi/node";
import { createAgentHost } from "@koi/node";
import { createDashboardHandler } from "../handler.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";
const DASHBOARD_PORT = 19_481; // Unlikely to collide

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testManifest(name: string): AgentManifest {
  return {
    name,
    version: "0.1.0",
    model: { name: "claude-haiku-4-5" },
  };
}

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

function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-tool-provider",
    attach: async () => new Map(tools.map((t) => [toolToken(t.descriptor.name) as string, t])),
  };
}

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// DashboardDataSource adapter — bridges AgentHost to dashboard types
// ---------------------------------------------------------------------------

type EventListener = (event: DashboardEvent) => void;

interface HostBridge {
  readonly dataSource: DashboardDataSource;
  readonly emitDashboardEvent: (event: DashboardEvent) => void;
}

function createHostBridge(host: AgentHost): HostBridge {
  // let justified: mutable listener list for subscribe/unsubscribe
  let listeners: EventListener[] = [];
  const startMs = Date.now();

  function mapAgentToSummary(agent: {
    readonly pid: ProcessId;
    readonly manifest: AgentManifest;
    readonly state: ProcessState;
  }): DashboardAgentSummary {
    return {
      agentId: agent.pid.id,
      name: agent.pid.name,
      agentType: agent.pid.type,
      state: agent.state,
      model: agent.manifest.model?.name,
      channels: [],
      turns: 0,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
    };
  }

  function mapAgentToDetail(agent: {
    readonly pid: ProcessId;
    readonly manifest: AgentManifest;
    readonly state: ProcessState;
  }): DashboardAgentDetail {
    return {
      ...mapAgentToSummary(agent),
      ...(agent.pid.parent !== undefined ? { parentId: agent.pid.parent } : {}),
      skills: [],
      tokenCount: 0,
      metadata: {},
    };
  }

  const dataSource: DashboardDataSource = {
    listAgents: () => host.list().map(mapAgentToSummary),

    getAgent: (id: AgentId) => {
      const agent = host.get(id);
      return agent !== undefined ? mapAgentToDetail(agent) : undefined;
    },

    terminateAgent: (id: AgentId) => host.terminate(id),

    listChannels: (): readonly DashboardChannelSummary[] => [],

    listSkills: (): readonly DashboardSkillSummary[] => [],

    getSystemMetrics: (): DashboardSystemMetrics => ({
      uptimeMs: Date.now() - startMs,
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      activeAgents: host.capacity().current,
      totalAgents: host.capacity().current,
      activeChannels: 0,
    }),

    subscribe: (listener: EventListener) => {
      listeners = [...listeners, listener];
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },
  };

  const emitDashboardEvent = (event: DashboardEvent): void => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  return { dataSource, emitDashboardEvent };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describeE2E("e2e: dashboard + real agent + real LLM", () => {
  // let justified: mutable test-scoped resources
  let host: AgentHost;
  let bridge: HostBridge;
  let server: ReturnType<typeof Bun.serve>;
  let dispose: () => void;
  let baseUrl: string;

  beforeAll(() => {
    host = createAgentHost({
      maxAgents: 10,
      memoryWarningPercent: 85,
      memoryEvictionPercent: 95,
      monitorInterval: 60_000,
    });

    bridge = createHostBridge(host);

    const dashboard = createDashboardHandler(bridge.dataSource, {
      basePath: "/dashboard",
      apiPath: "/dashboard/api",
      sseBatchIntervalMs: 100,
      maxSseConnections: 10,
      cors: true,
    });
    dispose = dashboard.dispose;

    server = Bun.serve({
      port: DASHBOARD_PORT,
      fetch: async (req) =>
        (await dashboard.handler(req)) ?? new Response("Not found", { status: 404 }),
    });
    baseUrl = `http://localhost:${DASHBOARD_PORT}`;
  });

  afterAll(() => {
    host.terminateAll();
    dispose();
    server.stop(true);
  });

  // ── Test 1: Dashboard starts clean ────────────────────────────────────

  test("dashboard serves health and empty agent list", async () => {
    const healthRes = await fetch(`${baseUrl}/dashboard/api/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as {
      readonly ok: boolean;
      readonly data: { readonly status: string };
    };
    expect(health.ok).toBe(true);
    expect(health.data.status).toBe("ok");

    const agentsRes = await fetch(`${baseUrl}/dashboard/api/agents`);
    expect(agentsRes.status).toBe(200);
    const agents = (await agentsRes.json()) as {
      readonly ok: boolean;
      readonly data: readonly unknown[];
    };
    expect(agents.ok).toBe(true);
    expect(agents.data).toHaveLength(0);

    const metricsRes = await fetch(`${baseUrl}/dashboard/api/metrics`);
    expect(metricsRes.status).toBe(200);
    const metrics = (await metricsRes.json()) as {
      readonly ok: boolean;
      readonly data: { readonly activeAgents: number; readonly uptimeMs: number };
    };
    expect(metrics.ok).toBe(true);
    expect(metrics.data.activeAgents).toBe(0);
    expect(metrics.data.uptimeMs).toBeGreaterThan(0);
  });

  // ── Test 2: Dispatch real agent, verify REST shows it ──────────────────

  test(
    "dispatching a real agent makes it visible via REST",
    async () => {
      const manifest = testManifest("E2E Dashboard Agent");
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise assistant. Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const pid: ProcessId = {
        id: agentId("e2e-agent-001"),
        name: "E2E Dashboard Agent",
        type: "copilot",
        depth: 0,
      };

      const result = await host.dispatch(pid, manifest, adapter, [
        createToolProvider([MULTIPLY_TOOL]),
      ]);
      expect(result.ok).toBe(true);

      // REST: agent list should show the agent
      const agentsRes = await fetch(`${baseUrl}/dashboard/api/agents`);
      const agents = (await agentsRes.json()) as {
        readonly ok: boolean;
        readonly data: readonly DashboardAgentSummary[];
      };
      expect(agents.data).toHaveLength(1);
      expect(agents.data[0]?.name).toBe("E2E Dashboard Agent");
      expect(agents.data[0]?.state).toBe("running");
      expect(agents.data[0]?.agentType).toBe("copilot");

      // REST: agent detail
      const detailRes = await fetch(`${baseUrl}/dashboard/api/agents/e2e-agent-001`);
      const detail = (await detailRes.json()) as {
        readonly ok: boolean;
        readonly data: DashboardAgentDetail;
      };
      expect(detail.ok).toBe(true);
      expect(detail.data.name).toBe("E2E Dashboard Agent");
      expect(detail.data.model).toBe("claude-haiku-4-5");

      // REST: metrics should show 1 active agent
      const metricsRes = await fetch(`${baseUrl}/dashboard/api/metrics`);
      const metrics = (await metricsRes.json()) as {
        readonly ok: boolean;
        readonly data: DashboardSystemMetrics;
      };
      expect(metrics.data.activeAgents).toBe(1);
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Run real LLM call through createKoi, verify events stream ──

  test(
    "real LLM call produces engine events while dashboard SSE streams",
    async () => {
      // Connect SSE client
      const ac = new AbortController();
      const sseRes = await fetch(`${baseUrl}/dashboard/api/events`, {
        signal: ac.signal,
      });
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get("content-type")).toBe("text/event-stream");

      const reader = sseRes.body?.getReader();
      expect(reader).toBeDefined();
      if (reader === undefined) return;
      const decoder = new TextDecoder();

      // Read initial keepalive
      const keepalive = await reader.read();
      expect(decoder.decode(keepalive.value)).toContain(":keepalive");

      // Create a separate Koi runtime for the real LLM call
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You MUST use the multiply tool to answer math. Do not compute in your head.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest("E2E Runner Agent"),
        adapter,
        providers: [createToolProvider([MULTIPLY_TOOL])],
        loopDetection: false,
      });

      // Run agent with real LLM call
      const engineEvents = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the multiply tool to compute 6 * 7. Then tell me the result.",
        }),
      );

      // Verify real LLM call worked
      const doneEvent = engineEvents.find((e) => e.kind === "done");
      expect(doneEvent).toBeDefined();

      const textDeltas = engineEvents
        .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
        .map((e) => e.delta)
        .join("");
      expect(textDeltas).toContain("42");

      const toolCalls = engineEvents.filter((e) => e.kind === "tool_call_start");
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);

      // Emit agent status change event through dashboard bridge
      bridge.emitDashboardEvent({
        kind: "agent",
        subKind: "status_changed",
        agentId: agentId("e2e-agent-001"),
        from: "created",
        to: "running",
        timestamp: Date.now(),
      } satisfies DashboardEvent);

      // Wait for SSE batch flush
      await new Promise((resolve) => setTimeout(resolve, 250));

      // Read SSE batch — should contain the event
      const batch = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 3000),
        ),
      ]);

      if (batch.value !== undefined) {
        const text = decoder.decode(batch.value);
        expect(text).toContain("data:");
        expect(text).toContain('"seq":');
      }

      reader.releaseLock();
      ac.abort();
      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Terminate agent via dashboard API ──────────────────────────

  test("terminate agent via dashboard REST API", async () => {
    // Verify agent exists
    const beforeRes = await fetch(`${baseUrl}/dashboard/api/agents/e2e-agent-001`);
    expect(beforeRes.status).toBe(200);

    // Terminate via dashboard
    const terminateRes = await fetch(`${baseUrl}/dashboard/api/agents/e2e-agent-001/terminate`, {
      method: "POST",
    });
    expect(terminateRes.status).toBe(200);
    const terminateBody = (await terminateRes.json()) as { readonly ok: boolean };
    expect(terminateBody.ok).toBe(true);

    // Verify agent is gone from list
    const afterRes = await fetch(`${baseUrl}/dashboard/api/agents`);
    const afterBody = (await afterRes.json()) as {
      readonly ok: boolean;
      readonly data: readonly DashboardAgentSummary[];
    };
    expect(afterBody.data).toHaveLength(0);

    // Verify 404 on detail
    const goneRes = await fetch(`${baseUrl}/dashboard/api/agents/e2e-agent-001`);
    expect(goneRes.status).toBe(404);

    // Metrics should show 0 active
    const metricsRes = await fetch(`${baseUrl}/dashboard/api/metrics`);
    const metricsBody = (await metricsRes.json()) as {
      readonly ok: boolean;
      readonly data: DashboardSystemMetrics;
    };
    expect(metricsBody.data.activeAgents).toBe(0);
  });

  // ── Test 5: Multi-agent dispatch + concurrent SSE ──────────────────────

  test(
    "multiple agents dispatch and appear concurrently",
    async () => {
      const agents = ["agent-a", "agent-b", "agent-c"];
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      for (const name of agents) {
        const pid: ProcessId = {
          id: agentId(`e2e-multi-${name}`),
          name: `Multi ${name}`,
          type: "worker",
          depth: 0,
        };
        const result = await host.dispatch(pid, testManifest(`Multi ${name}`), adapter, []);
        expect(result.ok).toBe(true);
      }

      // REST: all 3 agents visible
      const agentsRes = await fetch(`${baseUrl}/dashboard/api/agents`);
      const agentsBody = (await agentsRes.json()) as {
        readonly ok: boolean;
        readonly data: readonly DashboardAgentSummary[];
      };
      expect(agentsBody.data).toHaveLength(3);

      const names = agentsBody.data.map((a) => a.name).sort();
      expect(names).toEqual(["Multi agent-a", "Multi agent-b", "Multi agent-c"]);

      // All should be "running"
      for (const agent of agentsBody.data) {
        expect(agent.state).toBe("running");
        expect(agent.agentType).toBe("worker");
      }

      // Metrics shows 3 active
      const metricsRes = await fetch(`${baseUrl}/dashboard/api/metrics`);
      const metricsBody = (await metricsRes.json()) as {
        readonly ok: boolean;
        readonly data: DashboardSystemMetrics;
      };
      expect(metricsBody.data.activeAgents).toBe(3);

      // Terminate all
      for (const name of agents) {
        const res = await fetch(`${baseUrl}/dashboard/api/agents/e2e-multi-${name}/terminate`, {
          method: "POST",
        });
        expect(res.status).toBe(200);
      }

      // Verify all gone
      const emptyRes = await fetch(`${baseUrl}/dashboard/api/agents`);
      const emptyBody = (await emptyRes.json()) as {
        readonly ok: boolean;
        readonly data: readonly DashboardAgentSummary[];
      };
      expect(emptyBody.data).toHaveLength(0);
    },
    TIMEOUT_MS,
  );

  // ── Test 6: Full lifecycle — dispatch, run LLM, stream SSE, terminate ──

  test(
    "full lifecycle: dispatch → real LLM tool call → SSE events → terminate",
    async () => {
      // 1. Connect SSE before dispatching
      const ac = new AbortController();
      const sseRes = await fetch(`${baseUrl}/dashboard/api/events`, {
        signal: ac.signal,
      });
      const reader = sseRes.body?.getReader();
      expect(reader).toBeDefined();
      if (reader === undefined) return;
      const decoder = new TextDecoder();

      // Read initial keepalive
      await reader.read();

      // 2. Dispatch agent to host
      const pid: ProcessId = {
        id: agentId("e2e-lifecycle-001"),
        name: "Lifecycle Agent",
        type: "copilot",
        depth: 0,
      };
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are helpful. Use tools when available.",
        getApiKey: async () => ANTHROPIC_KEY,
      });
      const dispatchResult = await host.dispatch(pid, testManifest("Lifecycle Agent"), adapter, [
        createToolProvider([MULTIPLY_TOOL]),
      ]);
      expect(dispatchResult.ok).toBe(true);

      // 3. Emit dashboard event for agent dispatch
      bridge.emitDashboardEvent({
        kind: "agent",
        subKind: "dispatched",
        agentId: agentId("e2e-lifecycle-001"),
        name: "Lifecycle Agent",
        agentType: "copilot",
        timestamp: Date.now(),
      } satisfies DashboardEvent);

      // 4. Run real LLM call through createKoi
      const runtime = await createKoi({
        manifest: testManifest("Lifecycle Runner"),
        adapter: createPiAdapter({
          model: E2E_MODEL,
          systemPrompt: "You MUST use the multiply tool. Never calculate in your head.",
          getApiKey: async () => ANTHROPIC_KEY,
        }),
        providers: [createToolProvider([MULTIPLY_TOOL])],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Use multiply to compute 13 * 7." }),
      );

      // 5. Verify LLM call succeeded
      const done = events.find((e) => e.kind === "done");
      expect(done).toBeDefined();

      const text = events
        .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
        .map((e) => e.delta)
        .join("");
      expect(text).toContain("91");

      // 6. Emit completion event
      bridge.emitDashboardEvent({
        kind: "agent",
        subKind: "status_changed",
        agentId: agentId("e2e-lifecycle-001"),
        from: "running",
        to: "terminated",
        timestamp: Date.now(),
      } satisfies DashboardEvent);

      // 7. Wait for SSE flush + verify batch received
      await new Promise((resolve) => setTimeout(resolve, 250));

      const batch = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 3000),
        ),
      ]);

      // We should have received at least one SSE batch
      if (batch.value !== undefined) {
        const sseText = decoder.decode(batch.value);
        expect(sseText).toContain("data:");
      }

      // 8. Terminate via dashboard REST API
      const terminateRes = await fetch(
        `${baseUrl}/dashboard/api/agents/e2e-lifecycle-001/terminate`,
        { method: "POST" },
      );
      expect(terminateRes.status).toBe(200);

      // 9. Verify agent removed
      const agentsRes = await fetch(`${baseUrl}/dashboard/api/agents`);
      const agentsBody = (await agentsRes.json()) as {
        readonly ok: boolean;
        readonly data: readonly DashboardAgentSummary[];
      };
      expect(agentsBody.data).toHaveLength(0);

      // Cleanup
      reader.releaseLock();
      ac.abort();
      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 7: SSE max connections enforcement ────────────────────────────

  test("SSE enforces max connections from dashboard config", async () => {
    const controllers: AbortController[] = [];
    const responses: Response[] = [];

    // Open maxSseConnections (10) connections
    for (let i = 0; i < 10; i++) {
      const ac = new AbortController();
      controllers.push(ac);
      const res = await fetch(`${baseUrl}/dashboard/api/events`, {
        signal: ac.signal,
      });
      responses.push(res);
      expect(res.status).toBe(200);
    }

    // 11th should get 503
    const overflow = await fetch(`${baseUrl}/dashboard/api/events`);
    expect(overflow.status).toBe(503);

    // Cleanup
    for (const ac of controllers) {
      ac.abort();
    }
  });

  // ── Test 8: Error paths — terminate nonexistent, bad routes ────────────

  test("error paths return proper envelopes", async () => {
    // Terminate nonexistent agent
    const terminateRes = await fetch(`${baseUrl}/dashboard/api/agents/nonexistent/terminate`, {
      method: "POST",
    });
    expect(terminateRes.status).toBe(404);
    const terminateBody = (await terminateRes.json()) as {
      readonly ok: boolean;
      readonly error: { readonly code: string };
    };
    expect(terminateBody.ok).toBe(false);
    expect(terminateBody.error.code).toBe("NOT_FOUND");

    // Get nonexistent agent
    const getRes = await fetch(`${baseUrl}/dashboard/api/agents/nonexistent`);
    expect(getRes.status).toBe(404);

    // Unknown route
    const unknownRes = await fetch(`${baseUrl}/dashboard/api/unknown`);
    expect(unknownRes.status).toBe(404);

    // CORS preflight
    const corsRes = await fetch(`${baseUrl}/dashboard/api/agents`, {
      method: "OPTIONS",
    });
    expect(corsRes.status).toBe(204);
    expect(corsRes.headers.get("access-control-allow-origin")).toBe("*");
  });

  // ── Test 9: Real system metrics reflect actual process state ───────────

  test("system metrics reflect real process memory", async () => {
    const res = await fetch(`${baseUrl}/dashboard/api/metrics`);
    const body = (await res.json()) as {
      readonly ok: boolean;
      readonly data: DashboardSystemMetrics;
    };
    expect(body.ok).toBe(true);

    // Heap should be > 0 and reasonable (Bun may report heapUsed > heapTotal)
    expect(body.data.heapUsedMb).toBeGreaterThan(0);
    expect(body.data.heapTotalMb).toBeGreaterThan(0);

    // Uptime should be positive
    expect(body.data.uptimeMs).toBeGreaterThan(0);
  });
});
