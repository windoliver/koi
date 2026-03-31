/**
 * Runtime view routes unit tests.
 */

import { describe, expect, test } from "bun:test";
import type { AgentId } from "@koi/core";
import { agentId } from "@koi/core";
import type { RuntimeViewDataSource } from "@koi/dashboard-types";
import {
  handleAgentProcfs,
  handleDebugTrace,
  handleGatewayTopology,
  handleMiddlewareChain,
  handleProcessTree,
} from "./views.js";

function createMockViews(overrides?: Partial<RuntimeViewDataSource>): RuntimeViewDataSource {
  return {
    getProcessTree: () => ({
      roots: [
        {
          agentId: agentId("a1"),
          name: "root-agent",
          state: "running" as const,
          agentType: "copilot" as const,
          depth: 0,
          children: [],
        },
      ],
      totalAgents: 1,
      timestamp: Date.now(),
    }),
    getAgentProcfs: (id: AgentId) => ({
      agentId: id,
      name: "test-agent",
      state: "running" as const,
      agentType: "copilot" as const,
      channels: ["cli"],
      turns: 10,
      tokenCount: 500,
      startedAt: Date.now() - 60_000,
      lastActivityAt: Date.now(),
      childCount: 0,
    }),
    getMiddlewareChain: (id: AgentId) => ({
      agentId: id,
      entries: [{ name: "audit", phase: "observe" as const, enabled: true }],
    }),
    getGatewayTopology: () => ({
      connections: [],
      nodeCount: 1,
      timestamp: Date.now(),
    }),
    ...overrides,
  };
}

function makeReq(url: string): Request {
  return new Request(`http://localhost${url}`);
}

describe("handleProcessTree", () => {
  test("returns process tree snapshot", async () => {
    const views = createMockViews();
    const res = await handleProcessTree(makeReq("/view/agents/tree"), {}, views);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.data as Record<string, unknown>).roots as unknown[]).toHaveLength(1);
    expect((body.data as Record<string, unknown>).totalAgents).toBe(1);
  });
});

describe("handleAgentProcfs", () => {
  test("returns agent runtime state", async () => {
    const views = createMockViews();
    const res = await handleAgentProcfs(makeReq("/view/agents/a1/procfs"), { id: "a1" }, views);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.data as Record<string, unknown>).name).toBe("test-agent");
  });

  test("returns 400 when id is missing", async () => {
    const views = createMockViews();
    const res = await handleAgentProcfs(makeReq("/view/agents//procfs"), {}, views);
    expect(res.status).toBe(400);
  });

  test("returns 404 when agent not found", async () => {
    const views = createMockViews({
      getAgentProcfs: () => undefined,
    });
    const res = await handleAgentProcfs(
      makeReq("/view/agents/missing/procfs"),
      { id: "missing" },
      views,
    );
    expect(res.status).toBe(404);
  });
});

describe("handleMiddlewareChain", () => {
  test("returns middleware chain", async () => {
    const views = createMockViews();
    const res = await handleMiddlewareChain(makeReq("/view/middleware/a1"), { id: "a1" }, views);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.data as Record<string, unknown>).entries as unknown[]).toHaveLength(1);
  });
});

describe("handleGatewayTopology", () => {
  test("returns topology", async () => {
    const views = createMockViews();
    const res = await handleGatewayTopology(makeReq("/view/gateway/topology"), {}, views);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.data as Record<string, unknown>).nodeCount).toBe(1);
  });
});

describe("handleDebugTrace", () => {
  const MOCK_TRACE = {
    turnIndex: 0,
    totalDurationMs: 42,
    spans: [
      {
        debugId: "group:wrapModelCall",
        name: "wrapModelCall",
        hook: "wrapModelCall",
        durationMs: 42,
        startOffsetMs: 0,
        source: "static",
        phase: "resolve",
        priority: 0,
        nextCalled: true,
        tier: "critical",
        children: [],
      },
    ],
    timestamp: Date.now(),
  };

  test("returns trace for valid turn", async () => {
    const views = createMockViews({
      debug: {
        getInventory: () => ({ agentId: "a1", items: [], timestamp: Date.now() }),
        getTrace: (_agentId, turnIndex) => (turnIndex === 0 ? MOCK_TRACE : undefined),
      },
    });
    const res = await handleDebugTrace(
      makeReq("/view/debug/a1/trace/0"),
      { id: "a1", turn: "0" },
      views,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.data as Record<string, unknown>).turnIndex).toBe(0);
    expect((body.data as Record<string, unknown>).totalDurationMs).toBe(42);
  });

  test("returns 404 for missing turn", async () => {
    const views = createMockViews({
      debug: {
        getInventory: () => ({ agentId: "a1", items: [], timestamp: Date.now() }),
        getTrace: () => undefined,
      },
    });
    const res = await handleDebugTrace(
      makeReq("/view/debug/a1/trace/99"),
      { id: "a1", turn: "99" },
      views,
    );
    expect(res.status).toBe(404);
  });

  test("returns 400 for negative turn index", async () => {
    const views = createMockViews({
      debug: {
        getInventory: () => ({ agentId: "a1", items: [], timestamp: Date.now() }),
        getTrace: () => undefined,
      },
    });
    const res = await handleDebugTrace(
      makeReq("/view/debug/a1/trace/-1"),
      { id: "a1", turn: "-1" },
      views,
    );
    expect(res.status).toBe(400);
  });

  test("returns 400 for non-numeric turn index", async () => {
    const views = createMockViews({
      debug: {
        getInventory: () => ({ agentId: "a1", items: [], timestamp: Date.now() }),
        getTrace: () => undefined,
      },
    });
    const res = await handleDebugTrace(
      makeReq("/view/debug/a1/trace/abc"),
      { id: "a1", turn: "abc" },
      views,
    );
    expect(res.status).toBe(400);
  });

  test("returns 501 when debug is not enabled", async () => {
    const views = createMockViews();
    // createMockViews has no debug source by default
    const res = await handleDebugTrace(
      makeReq("/view/debug/a1/trace/0"),
      { id: "a1", turn: "0" },
      views,
    );
    expect(res.status).toBe(501);
  });

  test("returns 400 when agent id is missing", async () => {
    const views = createMockViews({
      debug: {
        getInventory: () => ({ agentId: "a1", items: [], timestamp: Date.now() }),
        getTrace: () => undefined,
      },
    });
    const res = await handleDebugTrace(makeReq("/view/debug//trace/0"), { turn: "0" }, views);
    expect(res.status).toBe(400);
  });
});
