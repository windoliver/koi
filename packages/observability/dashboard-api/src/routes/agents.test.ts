import { describe, expect, test } from "bun:test";
import type { AgentId } from "@koi/core";
import type {
  DashboardAgentDetail,
  DashboardAgentSummary,
  DashboardDataSource,
} from "@koi/dashboard-types";
import { handleGetAgent, handleListAgents, handleTerminateAgent } from "./agents.js";

const AGENT_ID = "agent-1" as AgentId;

function createMockSummary(overrides?: Partial<DashboardAgentSummary>): DashboardAgentSummary {
  return {
    agentId: AGENT_ID,
    name: "test-agent",
    agentType: "copilot",
    state: "running",
    model: "claude-sonnet",
    channels: ["cli"],
    turns: 5,
    startedAt: Date.now() - 60_000,
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

function createMockDetail(overrides?: Partial<DashboardAgentDetail>): DashboardAgentDetail {
  return {
    ...createMockSummary(),
    skills: ["code-review"],
    tokenCount: 1000,
    metadata: {},
    ...overrides,
  };
}

function createMockDataSource(overrides?: Partial<DashboardDataSource>): DashboardDataSource {
  return {
    listAgents: () => [createMockSummary()],
    getAgent: () => createMockDetail(),
    terminateAgent: () => ({ ok: true, value: undefined }),
    listChannels: () => [],
    listSkills: () => [],
    getSystemMetrics: () => ({
      uptimeMs: 1000,
      heapUsedMb: 100,
      heapTotalMb: 512,
      activeAgents: 1,
      totalAgents: 1,
      activeChannels: 1,
    }),
    subscribe: () => () => {},
    ...overrides,
  };
}

describe("handleListAgents", () => {
  test("returns list of agents", async () => {
    const ds = createMockDataSource();
    const response = await handleListAgents(new Request("http://localhost/agents"), {}, ds);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly data: readonly [Record<string, unknown>];
    };
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].agentId).toBe("agent-1");
  });
});

describe("handleGetAgent", () => {
  test("returns agent detail when found", async () => {
    const ds = createMockDataSource();
    const response = await handleGetAgent(
      new Request("http://localhost/agents/agent-1"),
      { id: "agent-1" },
      ds,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly data: Record<string, unknown>;
    };
    expect(body.ok).toBe(true);
    expect(body.data.agentId).toBe("agent-1");
    expect(body.data.skills).toEqual(["code-review"]);
  });

  test("returns 404 when agent not found", async () => {
    const ds = createMockDataSource({
      getAgent: () => undefined,
    });
    const response = await handleGetAgent(
      new Request("http://localhost/agents/missing"),
      { id: "missing" },
      ds,
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly error: Record<string, unknown>;
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("returns 400 when id param missing", async () => {
    const ds = createMockDataSource();
    const response = await handleGetAgent(new Request("http://localhost/agents/"), {}, ds);
    expect(response.status).toBe(400);
  });
});

describe("handleTerminateAgent", () => {
  test("returns success when agent terminated", async () => {
    const ds = createMockDataSource();
    const response = await handleTerminateAgent(
      new Request("http://localhost/agents/agent-1/terminate", { method: "POST" }),
      { id: "agent-1" },
      ds,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { readonly ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("returns 404 when agent not found for terminate", async () => {
    const ds = createMockDataSource({
      terminateAgent: () => ({
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "Agent not found",
          retryable: false,
        },
      }),
    });
    const response = await handleTerminateAgent(
      new Request("http://localhost/agents/missing/terminate", { method: "POST" }),
      { id: "missing" },
      ds,
    );
    expect(response.status).toBe(404);
  });

  test("returns 409 when agent already terminated", async () => {
    const ds = createMockDataSource({
      terminateAgent: () => ({
        ok: false,
        error: {
          code: "CONFLICT",
          message: "Agent already terminated",
          retryable: false,
        },
      }),
    });
    const response = await handleTerminateAgent(
      new Request("http://localhost/agents/agent-1/terminate", { method: "POST" }),
      { id: "agent-1" },
      ds,
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly error: { readonly code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("CONFLICT");
  });

  test("returns 400 when id param missing", async () => {
    const ds = createMockDataSource();
    const response = await handleTerminateAgent(
      new Request("http://localhost/agents//terminate", { method: "POST" }),
      {},
      ds,
    );
    expect(response.status).toBe(400);
  });
});
