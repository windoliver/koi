import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createNexusClient } from "./nexus-client.js";

const BASE_URL = "http://localhost:9999";

// Save and restore global fetch
const originalFetch = globalThis.fetch;

let mockFetch: ReturnType<typeof mock>;

beforeEach(() => {
  mockFetch = mock(() => Promise.resolve(new Response(JSON.stringify({}), { status: 200 })));
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createNexusClient", () => {
  describe("sendMessage", () => {
    test("sends POST to /api/v2/ipc/send with correct body", async () => {
      const envelope = {
        id: "msg-1",
        from: "a",
        to: "b",
        kind: "task",
        createdAt: "2026-01-01T00:00:00Z",
        type: "test",
        payload: { x: 1 },
      };
      mockFetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(envelope), { status: 200 })),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = createNexusClient({ baseUrl: BASE_URL });
      const body = { from: "a", to: "b", kind: "task", type: "test", payload: { x: 1 } };
      const result = await client.sendMessage(body);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe("msg-1");
      }

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}/api/v2/ipc/send`);
      expect(opts.method).toBe("POST");
      expect(JSON.parse(opts.body as string)).toEqual(body);
    });

    test("includes authorization header when authToken provided", async () => {
      mockFetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ id: "x" }), { status: 200 })),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = createNexusClient({ baseUrl: BASE_URL, authToken: "secret-token" });
      await client.sendMessage({ from: "a", to: "b", kind: "task", type: "t", payload: {} });

      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer secret-token");
    });

    test("returns error on HTTP 404", async () => {
      mockFetch = mock(() => Promise.resolve(new Response("not found", { status: 404 })));
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = createNexusClient({ baseUrl: BASE_URL });
      const result = await client.sendMessage({
        from: "a",
        to: "b",
        kind: "task",
        type: "t",
        payload: {},
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    test("returns error on HTTP 429", async () => {
      mockFetch = mock(() => Promise.resolve(new Response("rate limited", { status: 429 })));
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = createNexusClient({ baseUrl: BASE_URL });
      const result = await client.sendMessage({
        from: "a",
        to: "b",
        kind: "task",
        type: "t",
        payload: {},
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("RATE_LIMIT");
        expect(result.error.retryable).toBe(true);
      }
    });

    test("returns error on HTTP 500", async () => {
      mockFetch = mock(() => Promise.resolve(new Response("internal error", { status: 500 })));
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = createNexusClient({ baseUrl: BASE_URL });
      const result = await client.sendMessage({
        from: "a",
        to: "b",
        kind: "task",
        type: "t",
        payload: {},
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("EXTERNAL");
        expect(result.error.retryable).toBe(true);
      }
    });

    test("returns error on fetch failure", async () => {
      mockFetch = mock(() => Promise.reject(new Error("connection refused")));
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = createNexusClient({ baseUrl: BASE_URL });
      const result = await client.sendMessage({
        from: "a",
        to: "b",
        kind: "task",
        type: "t",
        payload: {},
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("EXTERNAL");
        expect(result.error.message).toContain("connection refused");
      }
    });
  });

  describe("listInbox", () => {
    test("sends GET to /api/v2/ipc/inbox/{agentId}", async () => {
      const response = {
        messages: [
          {
            id: "m1",
            from: "a",
            to: "b",
            kind: "task",
            createdAt: "2026-01-01T00:00:00Z",
            type: "t",
            payload: {},
          },
        ],
      };
      mockFetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(response), { status: 200 })),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = createNexusClient({ baseUrl: BASE_URL });
      const result = await client.listInbox("agent-b", 50);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0]?.id).toBe("m1");
      }

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe(`${BASE_URL}/api/v2/ipc/inbox/agent-b?limit=50`);
    });

    test("URL-encodes agentId", async () => {
      mockFetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ messages: [] }), { status: 200 })),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = createNexusClient({ baseUrl: BASE_URL });
      await client.listInbox("agent/special");

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("agent%2Fspecial");
    });
  });

  describe("inboxCount", () => {
    test("returns count from API", async () => {
      mockFetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ count: 42 }), { status: 200 })),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = createNexusClient({ baseUrl: BASE_URL });
      const result = await client.inboxCount("agent-b");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(42);
      }
    });
  });

  describe("provision", () => {
    test("sends POST to /api/v2/ipc/provision/{agentId}", async () => {
      mockFetch = mock(() => Promise.resolve(new Response(null, { status: 204 })));
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = createNexusClient({ baseUrl: BASE_URL });
      const result = await client.provision("agent-x");

      expect(result.ok).toBe(true);

      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}/api/v2/ipc/provision/agent-x`);
      expect(opts.method).toBe("POST");
    });
  });
});
