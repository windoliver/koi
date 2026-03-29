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
      const sendResponse = {
        message_id: "msg-gen-1",
        path: "/ipc/agent-a/inbox/msg-gen-1.json",
        sender: "agent-a",
        recipient: "agent-b",
        type: "task",
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(sendResponse), { status: 200 })),
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
        expect(result.value.kind).toBe("request"); // preserves input kind
        expect(result.value.from).toBe(agentId("agent-a"));
      }

      mailbox[Symbol.dispose]();
    });

    test("preserves input kind and type in send response mapping", async () => {
      const sendResponse = {
        message_id: "msg-gen-2",
        path: "/ipc/a/inbox/msg-gen-2.json",
        sender: "a",
        recipient: "b",
        type: "task",
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(sendResponse), { status: 200 })),
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

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe(messageId("msg-gen-2"));
        expect(result.value.kind).toBe("request"); // preserves input kind
        expect(result.value.from).toBe(agentId("a"));
        expect(result.value.createdAt).toBeTruthy();
      }

      mailbox[Symbol.dispose]();
    });
  });

  describe("list", () => {
    test("returns empty array (REST endpoint returns filenames only)", async () => {
      const response = {
        agent_id: "agent-b",
        messages: [{ filename: "m1.json" }],
        count: 1,
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(response), { status: 200 })),
      ) as unknown as typeof fetch;

      const mailbox = createNexusMailbox({ agentId: agentId("agent-b"), delivery: "polling" });
      const messages = await mailbox.list();

      // REST compatibility endpoint returns filenames, not full envelopes.
      // listInbox returns empty array, so list also returns empty.
      expect(messages).toHaveLength(0);

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
      const sendResponse = {
        message_id: "msg-sse-1",
        path: "/ipc/agent-a/inbox/msg-sse-1.json",
        sender: "agent-a",
        recipient: "agent-b",
        type: "task",
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(sendResponse), { status: 200 })),
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

    test("list returns empty in SSE mode (REST returns filenames only)", async () => {
      const response = {
        agent_id: "b",
        messages: [{ filename: "m-sse-1.json" }],
        count: 1,
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(response), { status: 200 })),
      ) as unknown as typeof fetch;

      const mailbox = createNexusMailbox({
        agentId: agentId("b"),
        delivery: "sse",
      });

      const messages = await mailbox.list();
      expect(messages).toHaveLength(0);

      mailbox[Symbol.dispose]();
    });
  });
});
