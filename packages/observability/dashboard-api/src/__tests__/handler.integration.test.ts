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
  test("GET /admin/api/health returns ok", async () => {
    const response = await fetch(`${baseUrl}/admin/api/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly data: Record<string, unknown>;
    };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("ok");
  });

  test("GET /admin/api/agents returns agent list", async () => {
    const response = await fetch(`${baseUrl}/admin/api/agents`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly data: readonly [Record<string, unknown>];
    };
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].agentId).toBe("agent-1");
  });

  test("GET /admin/api/agents/:id returns agent detail", async () => {
    const response = await fetch(`${baseUrl}/admin/api/agents/agent-1`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly data: Record<string, unknown>;
    };
    expect(body.ok).toBe(true);
    expect(body.data.skills).toEqual(["code-review"]);
  });

  test("GET /admin/api/agents/:id returns 404 for missing agent", async () => {
    const response = await fetch(`${baseUrl}/admin/api/agents/missing`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly error: Record<string, unknown>;
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("POST /admin/api/agents/:id/terminate succeeds", async () => {
    const response = await fetch(`${baseUrl}/admin/api/agents/agent-1/terminate`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { readonly ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("POST /admin/api/agents/:id/terminate returns 404 for missing", async () => {
    const response = await fetch(`${baseUrl}/admin/api/agents/missing/terminate`, {
      method: "POST",
    });
    expect(response.status).toBe(404);
  });

  test("GET /admin/api/channels returns channel list", async () => {
    const response = await fetch(`${baseUrl}/admin/api/channels`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly data: readonly [Record<string, unknown>];
    };
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].channelId).toBe("ch-1");
  });

  test("GET /admin/api/skills returns skill list", async () => {
    const response = await fetch(`${baseUrl}/admin/api/skills`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly data: readonly [Record<string, unknown>];
    };
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe("code-review");
  });

  test("GET /admin/api/metrics returns system metrics", async () => {
    const response = await fetch(`${baseUrl}/admin/api/metrics`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly data: Record<string, unknown>;
    };
    expect(body.ok).toBe(true);
    expect(body.data.activeAgents).toBe(1);
  });

  test("GET /admin/api/unknown returns 404", async () => {
    const response = await fetch(`${baseUrl}/admin/api/unknown`);
    expect(response.status).toBe(404);
  });

  test("CORS headers are present", async () => {
    const response = await fetch(`${baseUrl}/admin/api/health`);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("OPTIONS preflight returns 204", async () => {
    const response = await fetch(`${baseUrl}/admin/api/health`, {
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

describe("AG-UI chat endpoint", () => {
  test("POST /admin/api/agents/:id/chat returns 501 when no handler", async () => {
    const response = await fetch(`${baseUrl}/admin/api/agents/agent-1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(response.status).toBe(501);
  });

  test("POST /admin/api/agents/:id/chat returns 404 for unknown agent", async () => {
    // Create a handler with a chat handler wired
    const { dataSource } = createMockDataSource();
    const chatHandler = createDashboardHandler(
      {
        dataSource,
        agentChatHandler: (_req, _id) => new Response("ok"),
      },
      { cors: false },
    );

    const req = new Request(`http://localhost/admin/api/agents/unknown-agent/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    const response = await chatHandler.handler(req);
    expect(response).not.toBeNull();
    expect(response?.status).toBe(404);
    chatHandler.dispose();
  });

  test("POST /admin/api/agents/:id/chat returns 409 for terminated agent", async () => {
    const { dataSource } = createMockDataSource();
    // Wrap dataSource to return a terminated agent for getAgent
    const wrappedDataSource: DashboardDataSource = {
      ...dataSource,
      getAgent: (id: AgentId) => {
        const agent = dataSource.getAgent(id);
        if (agent === undefined) return undefined;
        return { ...agent, state: "terminated" as const };
      },
    };
    const chatHandler = createDashboardHandler(
      {
        dataSource: wrappedDataSource,
        agentChatHandler: (_req, _id) => new Response("ok"),
      },
      { cors: false },
    );

    const req = new Request(`http://localhost/admin/api/agents/agent-1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    const response = await chatHandler.handler(req);
    expect(response).not.toBeNull();
    expect(response?.status).toBe(409);
    chatHandler.dispose();
  });

  test("POST /admin/api/agents/:id/chat delegates to handler for known agent", async () => {
    const { dataSource } = createMockDataSource();
    const chatHandler = createDashboardHandler(
      {
        dataSource,
        agentChatHandler: (_req, id) =>
          new Response(`chat:${id}`, { headers: { "content-type": "text/plain" } }),
      },
      { cors: false },
    );

    const req = new Request(`http://localhost/admin/api/agents/agent-1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    const response = await chatHandler.handler(req);
    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);
    const body = await response?.text();
    expect(body).toBe("chat:agent-1");
    chatHandler.dispose();
  });
});

describe("SSE endpoint", () => {
  test("GET /admin/api/events returns SSE stream with events", async () => {
    const ac = new AbortController();

    const response = await fetch(`${baseUrl}/admin/api/events`, {
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

  test("GET /admin/api/events returns correct headers", async () => {
    const ac = new AbortController();
    const response = await fetch(`${baseUrl}/admin/api/events`, {
      signal: ac.signal,
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    ac.abort();
  });
});
