/**
 * Runtime view routes unit tests.
 */

import { describe, expect, test } from "bun:test";
import type { AgentId } from "@koi/core";
import { agentId } from "@koi/core";
import type { RuntimeViewDataSource } from "@koi/dashboard-types";
import {
  handleAgentProcfs,
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
