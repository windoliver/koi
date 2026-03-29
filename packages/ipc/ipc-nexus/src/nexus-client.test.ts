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
      const sendResponse = {
        message_id: "msg-1",
        path: "/ipc/a/inbox/msg-1.json",
        sender: "a",
        recipient: "b",
        type: "task",
      };
      mockFetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(sendResponse), { status: 200 })),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = createNexusClient({ baseUrl: BASE_URL });
      const body = { sender: "a", recipient: "b", type: "task", payload: { x: 1 } };
      const result = await client.sendMessage(body);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.message_id).toBe("msg-1");
        expect(result.value.sender).toBe("a");
        expect(result.value.recipient).toBe("b");
        expect(result.value.type).toBe("task");
      }

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}/api/v2/ipc/send`);
      expect(opts.method).toBe("POST");
      expect(JSON.parse(opts.body as string)).toEqual(body);
    });

    test("includes authorization header when authToken provided", async () => {
      mockFetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              message_id: "x",
              path: "/p",
              sender: "a",
              recipient: "b",
              type: "task",
            }),
            { status: 200 },
          ),
        ),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = createNexusClient({ baseUrl: BASE_URL, authToken: "secret-token" });
      await client.sendMessage({
        sender: "a",
        recipient: "b",
        type: "task",
        payload: {},
      });

      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer secret-token");
    });

    test("returns error on HTTP 404", async () => {
      mockFetch = mock(() => Promise.resolve(new Response("not found", { status: 404 })));
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = createNexusClient({ baseUrl: BASE_URL });
      const result = await client.sendMessage({
        sender: "a",
        recipient: "b",
        type: "task",
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
        sender: "a",
        recipient: "b",
        type: "task",
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
        sender: "a",
        recipient: "b",
        type: "task",
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
        sender: "a",
        recipient: "b",
        type: "task",
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
    test("lists inbox filenames then reads each file to return full envelopes", async () => {
      const listResponse = {
        agent_id: "agent-b",
        messages: [{ filename: "msg-1.json" }],
        count: 1,
      };
      const fileEnvelope = {
        id: "msg-1",
        from: "agent-a",
        to: "agent-b",
        type: "event",
        timestamp: "2026-01-01T00:00:00Z",
        payload: { data: "hello" },
      };

      // let justified: call index tracks sequential fetch calls
      let callIdx = 0;
      mockFetch = mock(() => {
        const idx = callIdx++;
        if (idx === 0) {
          return Promise.resolve(new Response(JSON.stringify(listResponse), { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify(fileEnvelope), { status: 200 }));
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = createNexusClient({ baseUrl: BASE_URL });
      const result = await client.listInbox("agent-b", 50);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0]?.id).toBe("msg-1");
        expect(result.value[0]?.from).toBe("agent-a");
      }

      // First call: list inbox, second call: read file
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [listUrl] = mockFetch.mock.calls[0] as [string];
      expect(listUrl).toBe(`${BASE_URL}/api/v2/ipc/inbox/agent-b?limit=50`);
      const [readUrl] = mockFetch.mock.calls[1] as [string];
      expect(readUrl).toContain("/api/v2/fs/read");
      expect(readUrl).toContain("msg-1.json");
    });

    test("URL-encodes agentId", async () => {
      mockFetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ agent_id: "agent/special", messages: [], count: 0 }), {
            status: 200,
          }),
        ),
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

  describe("injectable fetch", () => {
    test("uses injected fetch instead of globalThis.fetch", async () => {
      const injectedFetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              message_id: "injected",
              path: "/p",
              sender: "a",
              recipient: "b",
              type: "task",
            }),
            { status: 200 },
          ),
        ),
      );

      const client = createNexusClient({
        baseUrl: BASE_URL,
        fetch: injectedFetch as unknown as typeof fetch,
      });
      const result = await client.sendMessage({
        sender: "a",
        recipient: "b",
        type: "task",
        payload: {},
      });

      expect(result.ok).toBe(true);
      // Injected fetch was called, not globalThis.fetch
      expect(injectedFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(0);
    });
  });
});
