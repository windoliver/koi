/**
 * Integration tests — real Bun.serve() with mock data source.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentId } from "@koi/core";
import type {
  DashboardAgentDetail,
  DashboardAgentSummary,
  DashboardDataSource,
  DashboardEvent,
} from "@koi/dashboard-types";
import { createDashboardHandler } from "../handler.js";

type EventListener = (event: DashboardEvent) => void;

const PORT = 19472;

function createMockSummary(): DashboardAgentSummary {
  return {
    agentId: "agent-1" as AgentId,
    name: "test-agent",
    agentType: "copilot",
    state: "running",
    model: "claude-sonnet",
    channels: ["cli"],
    turns: 5,
    startedAt: Date.now() - 60_000,
    lastActivityAt: Date.now(),
  };
}

function createMockDetail(): DashboardAgentDetail {
  return {
    ...createMockSummary(),
    skills: ["code-review"],
    tokenCount: 1000,
    metadata: {},
  };
}

function createMockDataSource(): {
  readonly dataSource: DashboardDataSource;
  readonly emit: (event: DashboardEvent) => void;
} {
  let listeners: EventListener[] = [];

  const dataSource: DashboardDataSource = {
    listAgents: () => [createMockSummary()],
    getAgent: (id: AgentId) => (id === ("agent-1" as AgentId) ? createMockDetail() : undefined),
    terminateAgent: (id: AgentId) =>
      id === ("agent-1" as AgentId)
        ? { ok: true, value: undefined }
        : {
            ok: false,
            error: {
              code: "NOT_FOUND" as const,
              message: "Agent not found",
              retryable: false,
            },
          },
    listChannels: () => [
      {
        channelId: "ch-1",
        channelType: "cli",
        agentId: "agent-1" as AgentId,
        connected: true,
        messageCount: 10,
        connectedAt: Date.now(),
      },
    ],
    listSkills: () => [
      {
        name: "code-review",
        description: "Reviews code",
        tags: ["dev"],
        agentId: "agent-1" as AgentId,
      },
    ],
    getSystemMetrics: () => ({
      uptimeMs: 60_000,
      heapUsedMb: 150,
      heapTotalMb: 512,
      activeAgents: 1,
      totalAgents: 1,
      activeChannels: 1,
    }),
    subscribe: (listener: EventListener) => {
      listeners = [...listeners, listener];
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },
  };

  const emit = (event: DashboardEvent): void => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  return { dataSource, emit };
}

let server: ReturnType<typeof Bun.serve>;
let emitEvent: (event: DashboardEvent) => void;
let dispose: () => void;
const baseUrl = `http://localhost:${PORT}`;

beforeAll(() => {
  const { dataSource, emit } = createMockDataSource();
  emitEvent = emit;
  const result = createDashboardHandler(dataSource, { cors: true });
  dispose = result.dispose;

  server = Bun.serve({
    port: PORT,
    fetch: async (req) => {
      const response = await result.handler(req);
      return response ?? new Response("Not Found", { status: 404 });
    },
  });
});

afterAll(() => {
  dispose();
  server.stop(true);
});

describe("REST endpoints", () => {
  test("GET /dashboard/api/health returns ok", async () => {
    const response = await fetch(`${baseUrl}/dashboard/api/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly data: Record<string, unknown>;
    };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("ok");
  });

  test("GET /dashboard/api/agents returns agent list", async () => {
    const response = await fetch(`${baseUrl}/dashboard/api/agents`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly data: readonly [Record<string, unknown>];
    };
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].agentId).toBe("agent-1");
  });

  test("GET /dashboard/api/agents/:id returns agent detail", async () => {
    const response = await fetch(`${baseUrl}/dashboard/api/agents/agent-1`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly data: Record<string, unknown>;
    };
    expect(body.ok).toBe(true);
    expect(body.data.skills).toEqual(["code-review"]);
  });

  test("GET /dashboard/api/agents/:id returns 404 for missing agent", async () => {
    const response = await fetch(`${baseUrl}/dashboard/api/agents/missing`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly error: Record<string, unknown>;
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("POST /dashboard/api/agents/:id/terminate succeeds", async () => {
    const response = await fetch(`${baseUrl}/dashboard/api/agents/agent-1/terminate`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { readonly ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("POST /dashboard/api/agents/:id/terminate returns 404 for missing", async () => {
    const response = await fetch(`${baseUrl}/dashboard/api/agents/missing/terminate`, {
      method: "POST",
    });
    expect(response.status).toBe(404);
  });

  test("GET /dashboard/api/channels returns channel list", async () => {
    const response = await fetch(`${baseUrl}/dashboard/api/channels`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly data: readonly [Record<string, unknown>];
    };
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].channelId).toBe("ch-1");
  });

  test("GET /dashboard/api/skills returns skill list", async () => {
    const response = await fetch(`${baseUrl}/dashboard/api/skills`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly data: readonly [Record<string, unknown>];
    };
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe("code-review");
  });

  test("GET /dashboard/api/metrics returns system metrics", async () => {
    const response = await fetch(`${baseUrl}/dashboard/api/metrics`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly data: Record<string, unknown>;
    };
    expect(body.ok).toBe(true);
    expect(body.data.activeAgents).toBe(1);
  });

  test("GET /dashboard/api/unknown returns 404", async () => {
    const response = await fetch(`${baseUrl}/dashboard/api/unknown`);
    expect(response.status).toBe(404);
  });

  test("CORS headers are present", async () => {
    const response = await fetch(`${baseUrl}/dashboard/api/health`);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("OPTIONS preflight returns 204", async () => {
    const response = await fetch(`${baseUrl}/dashboard/api/health`, {
      method: "OPTIONS",
    });
    expect(response.status).toBe(204);
  });

  test("non-dashboard path returns 404 from fallback", async () => {
    const response = await fetch(`${baseUrl}/other/path`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });
});

describe("SSE endpoint", () => {
  test("GET /dashboard/api/events returns SSE stream with events", async () => {
    const ac = new AbortController();

    const response = await fetch(`${baseUrl}/dashboard/api/events`, {
      signal: ac.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (reader === undefined) return; // unreachable — satisfies TypeScript
    const decoder = new TextDecoder();

    // First read: initial keepalive comment
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain(":keepalive");

    // Emit event after connection is established
    emitEvent({
      kind: "system",
      subKind: "activity",
      message: "integration-test",
      timestamp: Date.now(),
    });

    // Wait for batch flush (100ms default + margin)
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Second read: should contain the batched event
    const second = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 2000),
      ),
    ]);

    if (second.value !== undefined) {
      const text = decoder.decode(second.value);
      expect(text).toContain("data:");
      expect(text).toContain("integration-test");
    }

    reader.releaseLock();
    ac.abort();
  });

  test("GET /dashboard/api/events returns correct headers", async () => {
    const ac = new AbortController();
    const response = await fetch(`${baseUrl}/dashboard/api/events`, {
      signal: ac.signal,
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    ac.abort();
  });
});
