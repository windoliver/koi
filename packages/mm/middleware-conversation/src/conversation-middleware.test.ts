import { describe, expect, test } from "bun:test";
import type {
  InboundMessage,
  KoiError,
  ModelResponse,
  Result,
  ThreadMessage,
  ThreadStore,
} from "@koi/core";
import { threadMessageId } from "@koi/core";
import {
  createMockSessionContext,
  createMockTurnContext,
  createSpyModelHandler,
} from "@koi/test-utils";
import { createConversationMiddleware } from "./conversation-middleware.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeThreadMessage(
  id: string,
  role: "user" | "assistant",
  content: string,
  createdAt = Date.now(),
): ThreadMessage {
  return {
    id: threadMessageId(id),
    role,
    content,
    createdAt,
  };
}

function createMockThreadStore(
  messages: readonly ThreadMessage[] = [],
): ThreadStore & { readonly appended: ThreadMessage[][] } {
  const appended: ThreadMessage[][] = [];
  // let justified: mutable internal store state for test verification
  let stored = [...messages];

  return {
    appended,
    listMessages(_tid, limit?): Result<readonly ThreadMessage[], KoiError> {
      const result = limit !== undefined ? stored.slice(-limit) : [...stored];
      return { ok: true, value: result };
    },
    appendAndCheckpoint(_tid, msgs): Result<void, KoiError> {
      appended.push([...msgs]);
      stored = [...stored, ...msgs];
      return { ok: true, value: undefined };
    },
    loadThread() {
      return { ok: true, value: undefined };
    },
    close() {},
  };
}

function userInbound(text: string): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "user",
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createConversationMiddleware", () => {
  describe("token budget", () => {
    test("single message exceeds budget — still included (newest-always policy)", async () => {
      const store = createMockThreadStore([makeThreadMessage("m1", "user", "a".repeat(100))]);
      const mw = createConversationMiddleware({
        store,
        maxHistoryTokens: 1, // way below any message
      });

      const sessionCtx = createMockSessionContext({
        metadata: { threadId: "t1" },
      });
      await mw.onSessionStart?.(sessionCtx);

      const spy = createSpyModelHandler();
      const request = { messages: [userInbound("new message")] };
      await mw.wrapModelCall?.(
        createMockTurnContext({ session: sessionCtx }),
        request,
        spy.handler,
      );

      // History message should still be injected (newest-always)
      const passed = spy.calls[0];
      expect(passed).toBeDefined();
      // At least 2 messages: 1 history + 1 current
      expect(passed?.messages.length).toBeGreaterThanOrEqual(2);
    });

    test("zero budget — only newest history message included", async () => {
      const store = createMockThreadStore([
        makeThreadMessage("m1", "user", "old"),
        makeThreadMessage("m2", "assistant", "reply"),
      ]);
      const mw = createConversationMiddleware({
        store,
        maxHistoryTokens: 0,
      });

      const sessionCtx = createMockSessionContext({
        metadata: { threadId: "t1" },
      });
      await mw.onSessionStart?.(sessionCtx);

      const spy = createSpyModelHandler();
      await mw.wrapModelCall?.(
        createMockTurnContext({ session: sessionCtx }),
        { messages: [userInbound("now")] },
        spy.handler,
      );

      const passed = spy.calls[0];
      expect(passed).toBeDefined();
      // The newest history message + current message
      expect(passed?.messages.length).toBe(2);
      // First message is the newest history (assistant reply)
      expect(
        (passed?.messages[0]?.metadata as Record<string, unknown> | undefined)?.fromHistory,
      ).toBe(true);
    });

    test("default estimator uses chars/4", async () => {
      // 16 chars = 4 tokens per message
      const store = createMockThreadStore([
        makeThreadMessage("m1", "user", "a".repeat(16)), // 4 tokens
        makeThreadMessage("m2", "assistant", "b".repeat(16)), // 4 tokens
        makeThreadMessage("m3", "user", "c".repeat(16)), // 4 tokens
      ]);
      const mw = createConversationMiddleware({
        store,
        maxHistoryTokens: 8, // room for 2 messages
      });

      const sessionCtx = createMockSessionContext({
        metadata: { threadId: "t1" },
      });
      await mw.onSessionStart?.(sessionCtx);

      const spy = createSpyModelHandler();
      await mw.wrapModelCall?.(
        createMockTurnContext({ session: sessionCtx }),
        { messages: [userInbound("now")] },
        spy.handler,
      );

      const passed = spy.calls[0];
      expect(passed).toBeDefined();
      // 2 history + 1 current = 3
      expect(passed?.messages.length).toBe(3);
    });
  });

  describe("session lifecycle", () => {
    test("onSessionStart loads history", async () => {
      const store = createMockThreadStore([makeThreadMessage("m1", "user", "hello")]);
      const mw = createConversationMiddleware({ store });

      const sessionCtx = createMockSessionContext({
        metadata: { threadId: "t1" },
      });
      await mw.onSessionStart?.(sessionCtx);

      // Verify by checking describeCapabilities
      const cap = mw.describeCapabilities(createMockTurnContext({ session: sessionCtx }));
      expect(cap).toBeDefined();
      expect(cap?.description).toContain("1 turns loaded");
    });

    test("wrapModelCall injects history", async () => {
      const store = createMockThreadStore([makeThreadMessage("m1", "user", "prior")]);
      const mw = createConversationMiddleware({ store });

      const sessionCtx = createMockSessionContext({
        metadata: { threadId: "t1" },
      });
      await mw.onSessionStart?.(sessionCtx);

      const spy = createSpyModelHandler();
      await mw.wrapModelCall?.(
        createMockTurnContext({ session: sessionCtx }),
        { messages: [userInbound("current")] },
        spy.handler,
      );

      const passed = spy.calls[0];
      expect(passed).toBeDefined();
      expect(passed?.messages.length).toBe(2);
      // First is history
      expect(
        (passed?.messages[0]?.metadata as Record<string, unknown> | undefined)?.fromHistory,
      ).toBe(true);
    });

    test("wrapModelStream injects history", async () => {
      const store = createMockThreadStore([makeThreadMessage("m1", "user", "prior")]);
      const mw = createConversationMiddleware({ store });

      const sessionCtx = createMockSessionContext({
        metadata: { threadId: "t1" },
      });
      await mw.onSessionStart?.(sessionCtx);

      const response: ModelResponse = {
        content: "streamed reply",
        model: "test",
      };
      // let justified: captures request passed to handler
      let capturedMessages: readonly InboundMessage[] = [];
      const streamHandler = async function* (req: {
        readonly messages: readonly InboundMessage[];
      }) {
        capturedMessages = req.messages;
        yield { kind: "done" as const, response };
      };

      if (mw.wrapModelStream !== undefined) {
        for await (const _chunk of mw.wrapModelStream(
          createMockTurnContext({ session: sessionCtx }),
          { messages: [userInbound("current")] },
          streamHandler,
        )) {
          /* drain */
        }
      }

      expect(capturedMessages.length).toBe(2);
      expect(
        (capturedMessages[0]?.metadata as Record<string, unknown> | undefined)?.fromHistory,
      ).toBe(true);
    });

    test("onSessionEnd persists new turns", async () => {
      const store = createMockThreadStore();
      const mw = createConversationMiddleware({ store });

      const sessionCtx = createMockSessionContext({
        metadata: { threadId: "t1" },
      });
      await mw.onSessionStart?.(sessionCtx);

      // Simulate a model call
      const spy = createSpyModelHandler();
      await mw.wrapModelCall?.(
        createMockTurnContext({ session: sessionCtx }),
        { messages: [userInbound("hello")] },
        spy.handler,
      );

      await mw.onSessionEnd?.(sessionCtx);

      // Verify messages were persisted
      expect(store.appended.length).toBe(1);
      const persisted = store.appended[0];
      expect(persisted).toBeDefined();
      // User message + assistant response
      expect(persisted?.length).toBe(2);
      expect(persisted?.[0]?.role).toBe("user");
      expect(persisted?.[1]?.role).toBe("assistant");
    });
  });

  describe("role derivation", () => {
    test("derives 'assistant' role for messages with agentId as senderId", async () => {
      const store = createMockThreadStore();
      const mw = createConversationMiddleware({ store });

      const sessionCtx = createMockSessionContext({
        metadata: { threadId: "t1" },
        agentId: "agent-007",
      });
      await mw.onSessionStart?.(sessionCtx);

      const agentMsg: InboundMessage = {
        content: [{ kind: "text", text: "I am the agent" }],
        senderId: "agent-007",
        timestamp: Date.now(),
      };
      const spy = createSpyModelHandler();
      await mw.wrapModelCall?.(
        createMockTurnContext({ session: sessionCtx }),
        { messages: [agentMsg] },
        spy.handler,
      );

      await mw.onSessionEnd?.(sessionCtx);

      // The user message captured should have role "assistant" since senderId === agentId
      const persisted = store.appended[0];
      expect(persisted?.[0]?.role).toBe("assistant");
    });

    test("derives 'system' role for system:* senderIds", async () => {
      const store = createMockThreadStore();
      const mw = createConversationMiddleware({ store });

      const sessionCtx = createMockSessionContext({
        metadata: { threadId: "t1" },
      });
      await mw.onSessionStart?.(sessionCtx);

      const sysMsg: InboundMessage = {
        content: [{ kind: "text", text: "system notice" }],
        senderId: "system:compactor",
        timestamp: Date.now(),
      };
      const spy = createSpyModelHandler();
      await mw.wrapModelCall?.(
        createMockTurnContext({ session: sessionCtx }),
        { messages: [sysMsg] },
        spy.handler,
      );

      await mw.onSessionEnd?.(sessionCtx);

      const persisted = store.appended[0];
      expect(persisted?.[0]?.role).toBe("system");
    });

    test("derives 'tool' role for tool:* senderIds", async () => {
      const store = createMockThreadStore();
      const mw = createConversationMiddleware({ store });

      const sessionCtx = createMockSessionContext({
        metadata: { threadId: "t1" },
      });
      await mw.onSessionStart?.(sessionCtx);

      const toolMsg: InboundMessage = {
        content: [{ kind: "text", text: "tool output" }],
        senderId: "tool:search",
        timestamp: Date.now(),
      };
      const spy = createSpyModelHandler();
      await mw.wrapModelCall?.(
        createMockTurnContext({ session: sessionCtx }),
        { messages: [toolMsg] },
        spy.handler,
      );

      await mw.onSessionEnd?.(sessionCtx);

      const persisted = store.appended[0];
      expect(persisted?.[0]?.role).toBe("tool");
    });
  });

  describe("message deduplication", () => {
    test("same messages across multiple model calls are not duplicated", async () => {
      const store = createMockThreadStore();
      const mw = createConversationMiddleware({ store });

      const sessionCtx = createMockSessionContext({
        metadata: { threadId: "t1" },
      });
      await mw.onSessionStart?.(sessionCtx);

      const msg = userInbound("hello");
      const spy = createSpyModelHandler();

      // First model call with the same message
      await mw.wrapModelCall?.(
        createMockTurnContext({ session: sessionCtx }),
        { messages: [msg] },
        spy.handler,
      );

      // Second model call with the same message (same timestamp)
      await mw.wrapModelCall?.(
        createMockTurnContext({ session: sessionCtx }),
        { messages: [msg] },
        spy.handler,
      );

      await mw.onSessionEnd?.(sessionCtx);

      // Should only persist 1 user message + 2 assistant responses = 3 total
      const persisted = store.appended[0];
      expect(persisted).toBeDefined();
      const userMsgs = persisted?.filter((m) => m.role === "user") ?? [];
      expect(userMsgs).toHaveLength(1);
    });
  });

  describe("thread ID resolution", () => {
    test("uses metadata.threadId", async () => {
      const store = createMockThreadStore();
      const mw = createConversationMiddleware({ store });

      const sessionCtx = createMockSessionContext({
        metadata: { threadId: "from-metadata" },
        channelId: "fallback",
      });
      await mw.onSessionStart?.(sessionCtx);

      const cap = mw.describeCapabilities(createMockTurnContext({ session: sessionCtx }));
      // No history loaded but threadId was resolved
      // With no messages, describeCapabilities returns undefined
      expect(cap).toBeUndefined();
    });

    test("falls back to channelId", async () => {
      const store = createMockThreadStore([makeThreadMessage("m1", "user", "hi")]);
      const mw = createConversationMiddleware({ store });

      const sessionCtx = createMockSessionContext({
        metadata: {},
        channelId: "channel-42",
      });
      await mw.onSessionStart?.(sessionCtx);

      const cap = mw.describeCapabilities(createMockTurnContext({ session: sessionCtx }));
      expect(cap).toBeDefined();
      expect(cap?.description).toContain("channel-42");
    });

    test("uses custom resolver", async () => {
      const store = createMockThreadStore([makeThreadMessage("m1", "user", "hi")]);
      const mw = createConversationMiddleware({
        store,
        resolveThreadId: () => "custom-thread",
      });

      const sessionCtx = createMockSessionContext({
        metadata: { threadId: "ignored" },
      });
      await mw.onSessionStart?.(sessionCtx);

      const cap = mw.describeCapabilities(createMockTurnContext({ session: sessionCtx }));
      expect(cap).toBeDefined();
      expect(cap?.description).toContain("custom-thread");
    });

    test("no threadId — no history loaded", async () => {
      const store = createMockThreadStore([makeThreadMessage("m1", "user", "hi")]);
      const mw = createConversationMiddleware({ store });

      // No threadId in metadata, no channelId
      const sessionCtx = createMockSessionContext({
        metadata: {},
      });
      await mw.onSessionStart?.(sessionCtx);

      const cap = mw.describeCapabilities(createMockTurnContext({ session: sessionCtx }));
      expect(cap).toBeUndefined();
    });
  });

  describe("describeCapabilities", () => {
    test("returns undefined when no history loaded", () => {
      const store = createMockThreadStore();
      const mw = createConversationMiddleware({ store });

      const cap = mw.describeCapabilities(createMockTurnContext());
      expect(cap).toBeUndefined();
    });

    test("reports count and threadId when loaded", async () => {
      const store = createMockThreadStore([
        makeThreadMessage("m1", "user", "a"),
        makeThreadMessage("m2", "assistant", "b"),
        makeThreadMessage("m3", "user", "c"),
      ]);
      const mw = createConversationMiddleware({ store });

      const sessionCtx = createMockSessionContext({
        metadata: { threadId: "t1" },
      });
      await mw.onSessionStart?.(sessionCtx);

      const cap = mw.describeCapabilities(createMockTurnContext({ session: sessionCtx }));
      expect(cap).toBeDefined();
      expect(cap?.label).toBe("conversation");
      expect(cap?.description).toBe("3 turns loaded for thread t1");
    });
  });

  describe("store errors", () => {
    test("listMessages error — continues without history", async () => {
      const store: ThreadStore = {
        listMessages() {
          return {
            ok: false,
            error: {
              code: "INTERNAL",
              message: "db down",
              retryable: false,
            },
          };
        },
        appendAndCheckpoint() {
          return { ok: true, value: undefined };
        },
        loadThread() {
          return { ok: true, value: undefined };
        },
        close() {},
      };

      const mw = createConversationMiddleware({ store });
      const sessionCtx = createMockSessionContext({
        metadata: { threadId: "t1" },
      });
      await mw.onSessionStart?.(sessionCtx);

      const cap = mw.describeCapabilities(createMockTurnContext({ session: sessionCtx }));
      expect(cap).toBeUndefined();
    });
  });

  describe("store write errors", () => {
    test("appendAndCheckpoint error propagates from onSessionEnd", async () => {
      const store: ThreadStore = {
        listMessages() {
          return { ok: true, value: [] };
        },
        appendAndCheckpoint() {
          return {
            ok: false,
            error: {
              code: "INTERNAL",
              message: "disk full",
              retryable: false,
            },
          };
        },
        loadThread() {
          return { ok: true, value: undefined };
        },
        close() {},
      };

      const mw = createConversationMiddleware({ store });
      const sessionCtx = createMockSessionContext({
        metadata: { threadId: "t1" },
      });
      await mw.onSessionStart?.(sessionCtx);

      const spy = createSpyModelHandler();
      await mw.wrapModelCall?.(
        createMockTurnContext({ session: sessionCtx }),
        { messages: [userInbound("hello")] },
        spy.handler,
      );

      await expect(mw.onSessionEnd?.(sessionCtx)).rejects.toThrow("Failed to persist conversation");
    });

    test("appendAndCheckpoint error includes thread ID and cause", async () => {
      const store: ThreadStore = {
        listMessages() {
          return { ok: true, value: [] };
        },
        appendAndCheckpoint() {
          return {
            ok: false,
            error: {
              code: "INTERNAL",
              message: "disk full",
              retryable: false,
            },
          };
        },
        loadThread() {
          return { ok: true, value: undefined };
        },
        close() {},
      };

      const mw = createConversationMiddleware({ store });
      const sessionCtx = createMockSessionContext({
        metadata: { threadId: "t1" },
      });
      await mw.onSessionStart?.(sessionCtx);

      const spy = createSpyModelHandler();
      await mw.wrapModelCall?.(
        createMockTurnContext({ session: sessionCtx }),
        { messages: [userInbound("hello")] },
        spy.handler,
      );

      try {
        await mw.onSessionEnd?.(sessionCtx);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(Error);
        const err = e as Error;
        expect(err.message).toContain("t1");
        expect(err.cause).toBeDefined();
      }
    });

    test("pendingWrites cleaned up after write failure — subsequent writes succeed", async () => {
      // let justified: track call count to fail first, succeed second
      let callCount = 0;
      const store: ThreadStore = {
        listMessages() {
          return { ok: true, value: [] };
        },
        appendAndCheckpoint() {
          callCount++;
          if (callCount === 1) {
            return {
              ok: false,
              error: {
                code: "INTERNAL",
                message: "disk full",
                retryable: false,
              },
            };
          }
          return { ok: true, value: undefined };
        },
        loadThread() {
          return { ok: true, value: undefined };
        },
        close() {},
      };

      const mw = createConversationMiddleware({ store });

      // First session — write fails
      const ctx1 = createMockSessionContext({ metadata: { threadId: "t1" } });
      await mw.onSessionStart?.(ctx1);
      const spy1 = createSpyModelHandler();
      await mw.wrapModelCall?.(
        createMockTurnContext({ session: ctx1 }),
        { messages: [userInbound("hello")] },
        spy1.handler,
      );
      try {
        await mw.onSessionEnd?.(ctx1);
      } catch {
        // Expected
      }

      // Second session — write should succeed (not blocked by first failure)
      const ctx2 = createMockSessionContext({ metadata: { threadId: "t1" } });
      await mw.onSessionStart?.(ctx2);
      const spy2 = createSpyModelHandler();
      await mw.wrapModelCall?.(
        createMockTurnContext({ session: ctx2 }),
        { messages: [userInbound("world")] },
        spy2.handler,
      );
      // Should not throw — pendingWrites was cleaned up by .finally()
      await mw.onSessionEnd?.(ctx2);
      expect(callCount).toBe(2);
    });
  });

  describe("no history — passthrough", () => {
    test("wrapModelCall passes request unchanged when no history", async () => {
      const store = createMockThreadStore();
      const mw = createConversationMiddleware({ store });

      const sessionCtx = createMockSessionContext({
        metadata: { threadId: "t1" },
      });
      await mw.onSessionStart?.(sessionCtx);

      const spy = createSpyModelHandler();
      const messages = [userInbound("hello")];
      await mw.wrapModelCall?.(
        createMockTurnContext({ session: sessionCtx }),
        { messages },
        spy.handler,
      );

      // Only the original message
      expect(spy.calls[0]?.messages.length).toBe(1);
    });
  });
});
