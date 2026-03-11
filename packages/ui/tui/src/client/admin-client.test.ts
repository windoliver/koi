import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type AdminClient, createAdminClient } from "./admin-client.js";

// ─── Mock fetch ──────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

let lastRequest: CapturedRequest | undefined;

function mockFetch(responseFactory: () => Response | Promise<Response>): void {
  lastRequest = undefined;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const hdrs: Record<string, string> = {};
    if (init?.headers !== undefined) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => {
        hdrs[k] = v;
      });
    }
    lastRequest = { url, method, headers: hdrs };
    if (typeof init?.body === "string") {
      lastRequest.body = JSON.parse(init.body);
    }
    return responseFactory();
  }) as typeof fetch;
}

function jsonResponse<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(code: string, message: string, status = 500): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let client: AdminClient;

beforeEach(() => {
  client = createAdminClient({
    baseUrl: "http://localhost:3100/admin/api",
    authToken: "test-token",
    timeoutMs: 5000,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  lastRequest = undefined;
});

describe("createAdminClient", () => {
  describe("listAgents", () => {
    test("returns agent list on success", async () => {
      const agents = [
        {
          agentId: "a1",
          name: "test",
          agentType: "copilot",
          state: "running",
          channels: [],
          turns: 5,
          startedAt: 1000,
          lastActivityAt: 2000,
        },
      ];
      mockFetch(() => jsonResponse(agents));

      const result = await client.listAgents();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0]?.name).toBe("test");
      }
    });

    test("sends correct URL and method", async () => {
      mockFetch(() => jsonResponse([]));
      await client.listAgents();
      expect(lastRequest?.url).toBe("http://localhost:3100/admin/api/agents");
      expect(lastRequest?.method).toBe("GET");
    });

    test("sends auth header", async () => {
      mockFetch(() => jsonResponse([]));
      await client.listAgents();
      expect(lastRequest?.headers.authorization).toBe("Bearer test-token");
    });
  });

  describe("getAgent", () => {
    test("interpolates agent ID in path", async () => {
      mockFetch(() => jsonResponse({ agentId: "agent-123", name: "test" }));
      await client.getAgent("agent-123");
      expect(lastRequest?.url).toBe("http://localhost:3100/admin/api/agents/agent-123");
    });

    test("returns agent detail on success", async () => {
      const detail = {
        agentId: "a1",
        name: "test",
        agentType: "copilot",
        state: "running",
        channels: [],
        turns: 5,
        startedAt: 1000,
        lastActivityAt: 2000,
        skills: ["search"],
        tokenCount: 1000,
        metadata: {},
      };
      mockFetch(() => jsonResponse(detail));

      const result = await client.getAgent("a1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe("test");
        expect(result.value.skills).toEqual(["search"]);
      }
    });
  });

  describe("suspendAgent", () => {
    test("sends POST to correct path", async () => {
      mockFetch(() => jsonResponse(null));
      const result = await client.suspendAgent("a1");
      expect(result.ok).toBe(true);
      expect(lastRequest?.url).toContain("/cmd/agents/a1/suspend");
      expect(lastRequest?.method).toBe("POST");
    });
  });

  describe("resumeAgent", () => {
    test("sends POST to correct path", async () => {
      mockFetch(() => jsonResponse(null));
      const result = await client.resumeAgent("a1");
      expect(result.ok).toBe(true);
      expect(lastRequest?.url).toContain("/cmd/agents/a1/resume");
      expect(lastRequest?.method).toBe("POST");
    });
  });

  describe("terminateAgent", () => {
    test("sends POST to correct path", async () => {
      mockFetch(() => jsonResponse(null));
      const result = await client.terminateAgent("a1");
      expect(result.ok).toBe(true);
      expect(lastRequest?.url).toContain("/cmd/agents/a1/terminate");
      expect(lastRequest?.method).toBe("POST");
    });
  });

  describe("error handling", () => {
    test("maps 401 to auth_failed", async () => {
      mockFetch(
        () =>
          new Response(
            JSON.stringify({ ok: false, error: { code: "FORBIDDEN", message: "Nope" } }),
            { status: 401 },
          ),
      );

      const result = await client.listAgents();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("auth_failed");
      }
    });

    test("maps 403 to auth_failed", async () => {
      mockFetch(
        () =>
          new Response(
            JSON.stringify({ ok: false, error: { code: "FORBIDDEN", message: "Nope" } }),
            { status: 403 },
          ),
      );

      const result = await client.listAgents();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("auth_failed");
      }
    });

    test("maps 500 with ApiResult to api_error", async () => {
      mockFetch(() => errorResponse("INTERNAL", "Something broke", 500));

      const result = await client.listAgents();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("api_error");
        if (result.error.kind === "api_error") {
          expect(result.error.code).toBe("INTERNAL");
          expect(result.error.message).toBe("Something broke");
        }
      }
    });

    test("maps invalid JSON response to unexpected", async () => {
      mockFetch(() => new Response("not json", { status: 200 }));

      const result = await client.listAgents();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("unexpected");
      }
    });

    test("maps non-ApiResult JSON to api_error", async () => {
      mockFetch(
        () =>
          new Response(JSON.stringify({ wrong: "shape" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );

      const result = await client.listAgents();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("api_error");
        if (result.error.kind === "api_error") {
          expect(result.error.code).toBe("INVALID_RESPONSE");
        }
      }
    });

    test("maps network error to connection_refused", async () => {
      globalThis.fetch = (() => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch;

      const result = await client.listAgents();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("connection_refused");
      }
    });

    test("maps unknown error to unexpected", async () => {
      globalThis.fetch = (() => {
        throw new Error("something weird");
      }) as unknown as typeof fetch;

      const result = await client.listAgents();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("unexpected");
      }
    });
  });

  describe("checkHealth", () => {
    test("returns health status", async () => {
      mockFetch(() => jsonResponse({ status: "ok" }));

      const result = await client.checkHealth();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe("ok");
      }
    });
  });

  describe("getProcessTree", () => {
    test("returns process tree", async () => {
      const tree = {
        roots: [
          {
            agentId: "a1",
            name: "root",
            state: "running",
            agentType: "copilot",
            depth: 0,
            children: [],
          },
        ],
        totalAgents: 1,
        timestamp: Date.now(),
      };
      mockFetch(() => jsonResponse(tree));

      const result = await client.getProcessTree();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.roots).toHaveLength(1);
      }
    });
  });

  describe("dispatchAgent", () => {
    test("sends POST with dispatch body", async () => {
      mockFetch(() => jsonResponse({ agentId: "new-1", name: "my-agent" }));

      const result = await client.dispatchAgent({ name: "my-agent" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.agentId).toBe("new-1");
        expect(result.value.name).toBe("my-agent");
      }
      expect(lastRequest?.method).toBe("POST");
      expect(lastRequest?.url).toContain("/cmd/agents/dispatch");
      expect(lastRequest?.body).toEqual({ name: "my-agent" });
    });
  });

  describe("fsList", () => {
    test("sends GET with path query param", async () => {
      const entries = [
        { name: "session-1", path: "/agents/a1/session/session-1", isDirectory: true },
      ];
      mockFetch(() => jsonResponse(entries));

      const result = await client.fsList("/agents/a1/session");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0]?.name).toBe("session-1");
      }
      expect(lastRequest?.url).toContain("/fs/list?path=");
    });
  });

  describe("fsRead", () => {
    test("returns file content", async () => {
      mockFetch(() => jsonResponse("file content here"));

      const result = await client.fsRead("/agents/a1/events/log.json");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("file content here");
      }
      expect(lastRequest?.url).toContain("/fs/read?path=");
    });
  });

  describe("eventsUrl", () => {
    test("builds correct events URL", () => {
      const url = client.eventsUrl();
      expect(url).toBe("http://localhost:3100/admin/api/events");
    });
  });
});
