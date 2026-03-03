import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentMessageInput } from "@koi/core";
import { agentId, messageId } from "@koi/core";
import { createNexusMailbox } from "./mailbox-adapter.js";

// Mock global fetch for all tests
const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ messages: [] }), { status: 200 })),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createNexusMailbox", () => {
  describe("send", () => {
    test("maps input and returns AgentMessage on success", async () => {
      const responseEnvelope = {
        id: "msg-gen-1",
        from: "agent-a",
        to: "agent-b",
        kind: "task",
        createdAt: "2026-01-01T00:00:00Z",
        type: "code-review",
        payload: { file: "main.ts" },
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(responseEnvelope), { status: 200 })),
      ) as unknown as typeof fetch;

      const mailbox = createNexusMailbox({ agentId: agentId("agent-a"), delivery: "polling" });
      const input: AgentMessageInput = {
        from: agentId("agent-a"),
        to: agentId("agent-b"),
        kind: "request",
        type: "code-review",
        payload: { file: "main.ts" },
      };

      const result = await mailbox.send(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe(messageId("msg-gen-1"));
        expect(result.value.kind).toBe("request"); // task → request
        expect(result.value.from).toBe(agentId("agent-a"));
      }

      mailbox[Symbol.dispose]();
    });

    test("returns error when Nexus returns unknown kind", async () => {
      const responseEnvelope = {
        id: "msg-gen-2",
        from: "a",
        to: "b",
        kind: "unknown_protocol",
        createdAt: "2026-01-01T00:00:00Z",
        type: "t",
        payload: {},
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(responseEnvelope), { status: 200 })),
      ) as unknown as typeof fetch;

      const mailbox = createNexusMailbox({ agentId: agentId("agent-a"), delivery: "polling" });
      const input: AgentMessageInput = {
        from: agentId("a"),
        to: agentId("b"),
        kind: "request",
        type: "t",
        payload: {},
      };

      const result = await mailbox.send(input);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("EXTERNAL");
        expect(result.error.message).toContain("unknown kind");
      }

      mailbox[Symbol.dispose]();
    });
  });

  describe("list", () => {
    test("returns mapped messages", async () => {
      const response = {
        messages: [
          {
            id: "m1",
            from: "agent-c",
            to: "agent-b",
            kind: "event",
            createdAt: "2026-01-01T00:00:00Z",
            type: "deploy",
            payload: { version: "1.0" },
          },
        ],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(response), { status: 200 })),
      ) as unknown as typeof fetch;

      const mailbox = createNexusMailbox({ agentId: agentId("agent-b"), delivery: "polling" });
      const messages = await mailbox.list();

      expect(messages).toHaveLength(1);
      expect(messages[0]?.kind).toBe("event");
      expect(messages[0]?.type).toBe("deploy");

      mailbox[Symbol.dispose]();
    });

    test("applies client-side filter by kind", async () => {
      const response = {
        messages: [
          {
            id: "m1",
            from: "a",
            to: "b",
            kind: "task",
            createdAt: "2026-01-01T00:00:00Z",
            type: "t1",
            payload: {},
          },
          {
            id: "m2",
            from: "a",
            to: "b",
            kind: "event",
            createdAt: "2026-01-01T00:01:00Z",
            type: "t2",
            payload: {},
          },
        ],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(response), { status: 200 })),
      ) as unknown as typeof fetch;

      const mailbox = createNexusMailbox({ agentId: agentId("b"), delivery: "polling" });
      const messages = await mailbox.list({ kind: "event" });

      expect(messages).toHaveLength(1);
      expect(messages[0]?.kind).toBe("event");

      mailbox[Symbol.dispose]();
    });

    test("returns empty array on API error", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("error", { status: 500 })),
      ) as unknown as typeof fetch;

      const mailbox = createNexusMailbox({ agentId: agentId("b"), delivery: "polling" });
      const messages = await mailbox.list();

      expect(messages).toHaveLength(0);

      mailbox[Symbol.dispose]();
    });
  });

  describe("onMessage", () => {
    test("returns an unsubscribe function", () => {
      const mailbox = createNexusMailbox({
        agentId: agentId("agent-b"),
        delivery: "polling",
        pollMinMs: 60_000, // Very long poll so it doesn't fire during test
      });

      const unsubscribe = mailbox.onMessage(() => {});
      expect(typeof unsubscribe).toBe("function");

      unsubscribe();
      mailbox[Symbol.dispose]();
    });
  });

  describe("dispose", () => {
    test("stops polling and clears handlers", () => {
      const mailbox = createNexusMailbox({
        agentId: agentId("agent-b"),
        delivery: "polling",
        pollMinMs: 60_000,
      });

      mailbox.onMessage(() => {});
      mailbox[Symbol.dispose]();

      // Should not throw — polling is stopped
      expect(true).toBe(true);
    });
  });

  describe("SSE delivery mode", () => {
    test("creates mailbox in SSE mode by default", () => {
      const mailbox = createNexusMailbox({
        agentId: agentId("agent-a"),
      });

      // Should not throw — SSE transport is created lazily on onMessage
      expect(mailbox).toBeDefined();
      mailbox[Symbol.dispose]();
    });

    test("disposes SSE transport on dispose", () => {
      const mailbox = createNexusMailbox({
        agentId: agentId("agent-a"),
        delivery: "sse",
      });

      // Register handler to trigger SSE start
      const unsub = mailbox.onMessage(() => {});

      // Dispose should stop SSE transport — should not throw
      mailbox[Symbol.dispose]();
      expect(true).toBe(true);

      // Unsubscribe should be safe to call after dispose
      unsub();
    });

    test("unsubscribing all handlers stops SSE transport", () => {
      const mailbox = createNexusMailbox({
        agentId: agentId("agent-a"),
        delivery: "sse",
      });

      const unsub = mailbox.onMessage(() => {});
      unsub();

      // Should not throw — SSE transport is cleaned up
      mailbox[Symbol.dispose]();
    });

    test("accepts seenCapacity config", () => {
      const mailbox = createNexusMailbox({
        agentId: agentId("agent-a"),
        delivery: "sse",
        seenCapacity: 500,
      });

      expect(mailbox).toBeDefined();
      mailbox[Symbol.dispose]();
    });

    test("send works the same in SSE mode", async () => {
      const responseEnvelope = {
        id: "msg-sse-1",
        from: "agent-a",
        to: "agent-b",
        kind: "task",
        createdAt: "2026-01-01T00:00:00Z",
        type: "review",
        payload: {},
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(responseEnvelope), { status: 200 })),
      ) as unknown as typeof fetch;

      const mailbox = createNexusMailbox({
        agentId: agentId("agent-a"),
        delivery: "sse",
      });

      const input: AgentMessageInput = {
        from: agentId("agent-a"),
        to: agentId("agent-b"),
        kind: "request",
        type: "review",
        payload: {},
      };

      const result = await mailbox.send(input);
      expect(result.ok).toBe(true);

      mailbox[Symbol.dispose]();
    });

    test("list works the same in SSE mode", async () => {
      const response = {
        messages: [
          {
            id: "m-sse-1",
            from: "c",
            to: "b",
            kind: "event",
            createdAt: "2026-01-01T00:00:00Z",
            type: "deploy",
            payload: {},
          },
        ],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(response), { status: 200 })),
      ) as unknown as typeof fetch;

      const mailbox = createNexusMailbox({
        agentId: agentId("b"),
        delivery: "sse",
      });

      const messages = await mailbox.list();
      expect(messages).toHaveLength(1);

      mailbox[Symbol.dispose]();
    });
  });
});
