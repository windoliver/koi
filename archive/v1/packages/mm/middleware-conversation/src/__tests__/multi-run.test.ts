import { describe, expect, test } from "bun:test";
import type { InboundMessage, ThreadSnapshot } from "@koi/core";
import { sessionId } from "@koi/core";
import { createInMemorySnapshotChainStore, createThreadStore } from "@koi/snapshot-chain-store";
import {
  createMockSessionContext,
  createMockTurnContext,
  createSpyModelHandler,
} from "@koi/test-utils";
import { createConversationMiddleware } from "../conversation-middleware.js";

function userInbound(text: string): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "user",
    timestamp: Date.now(),
  };
}

describe("multi-run integration", () => {
  test("conversation history accumulates across 3 sessions", async () => {
    const chainStore = createInMemorySnapshotChainStore<ThreadSnapshot>();
    const threadStore = createThreadStore({ store: chainStore });

    // Session 1: user says "hello" — no history loaded
    {
      const mw = createConversationMiddleware({
        store: threadStore,
        maxHistoryTokens: 10_000,
      });

      const ctx = createMockSessionContext({
        sessionId: sessionId("session-1"),
        metadata: { threadId: "thread-1" },
      });
      await mw.onSessionStart?.(ctx);

      // No prior history
      const cap = mw.describeCapabilities(createMockTurnContext({ session: ctx }));
      expect(cap).toBeUndefined();

      const spy = createSpyModelHandler({
        content: "hi there!",
        model: "test",
      });
      await mw.wrapModelCall?.(
        createMockTurnContext({ session: ctx }),
        { messages: [userInbound("hello")] },
        spy.handler,
      );

      await mw.onSessionEnd?.(ctx);
    }

    // Session 2: user says "what did I say?" — should see "hello" in history
    {
      const mw = createConversationMiddleware({
        store: threadStore,
        maxHistoryTokens: 10_000,
      });

      const ctx = createMockSessionContext({
        sessionId: sessionId("session-2"),
        metadata: { threadId: "thread-1" },
      });
      await mw.onSessionStart?.(ctx);

      // Should have loaded prior history
      const cap = mw.describeCapabilities(createMockTurnContext({ session: ctx }));
      expect(cap).toBeDefined();
      expect(cap?.description).toContain("2 turns loaded");

      const spy = createSpyModelHandler({
        content: "you said hello",
        model: "test",
      });
      await mw.wrapModelCall?.(
        createMockTurnContext({ session: ctx }),
        { messages: [userInbound("what did I say?")] },
        spy.handler,
      );

      // Verify history was injected
      const passed = spy.calls[0];
      expect(passed).toBeDefined();
      // 2 history messages + 1 current
      expect(passed?.messages.length).toBe(3);
      // First two should be from history
      expect(
        (passed?.messages[0]?.metadata as Record<string, unknown> | undefined)?.fromHistory,
      ).toBe(true);
      expect(
        (passed?.messages[1]?.metadata as Record<string, unknown> | undefined)?.fromHistory,
      ).toBe(true);
      // Last is the current message (not from history)
      expect(
        (passed?.messages[2]?.metadata as Record<string, unknown> | undefined)?.fromHistory,
      ).not.toBe(true);

      await mw.onSessionEnd?.(ctx);
    }

    // Session 3: should see all 4 prior messages
    {
      const mw = createConversationMiddleware({
        store: threadStore,
        maxHistoryTokens: 10_000,
      });

      const ctx = createMockSessionContext({
        sessionId: sessionId("session-3"),
        metadata: { threadId: "thread-1" },
      });
      await mw.onSessionStart?.(ctx);

      const cap = mw.describeCapabilities(createMockTurnContext({ session: ctx }));
      expect(cap).toBeDefined();
      // 4 messages from 2 prior sessions: user "hello", assistant "hi there!",
      // user "what did I say?", assistant "you said hello"
      expect(cap?.description).toContain("4 turns loaded");

      const spy = createSpyModelHandler({
        content: "and then the end",
        model: "test",
      });
      await mw.wrapModelCall?.(
        createMockTurnContext({ session: ctx }),
        { messages: [userInbound("and then?")] },
        spy.handler,
      );

      const passed = spy.calls[0];
      expect(passed).toBeDefined();
      // 4 history + 1 current = 5
      expect(passed?.messages.length).toBe(5);

      await mw.onSessionEnd?.(ctx);
    }

    threadStore.close();
  });

  test("messages are in chronological order", async () => {
    const chainStore = createInMemorySnapshotChainStore<ThreadSnapshot>();
    const threadStore = createThreadStore({ store: chainStore });

    // Session 1
    const mw1 = createConversationMiddleware({
      store: threadStore,
      maxHistoryTokens: 10_000,
    });
    const ctx1 = createMockSessionContext({
      sessionId: sessionId("order-session-1"),
      metadata: { threadId: "thread-order" },
    });
    await mw1.onSessionStart?.(ctx1);

    const spy1 = createSpyModelHandler({
      content: "response-1",
      model: "test",
    });
    await mw1.wrapModelCall?.(
      createMockTurnContext({ session: ctx1 }),
      { messages: [userInbound("first")] },
      spy1.handler,
    );
    await mw1.onSessionEnd?.(ctx1);

    // Session 2
    const mw2 = createConversationMiddleware({
      store: threadStore,
      maxHistoryTokens: 10_000,
    });
    const ctx2 = createMockSessionContext({
      sessionId: sessionId("order-session-2"),
      metadata: { threadId: "thread-order" },
    });
    await mw2.onSessionStart?.(ctx2);

    const spy2 = createSpyModelHandler();
    await mw2.wrapModelCall?.(
      createMockTurnContext({ session: ctx2 }),
      { messages: [userInbound("second")] },
      spy2.handler,
    );

    // Verify chronological order
    const passed = spy2.calls[0];
    expect(passed).toBeDefined();
    expect(passed?.messages.length).toBe(3); // 2 history + 1 current

    // Extract text from each message
    const texts = (passed?.messages ?? []).map((m) => {
      const block = m.content[0];
      return block?.kind === "text" ? block.text : "";
    });

    expect(texts[0]).toBe("first");
    expect(texts[1]).toBe("response-1");
    expect(texts[2]).toBe("second");

    await mw2.onSessionEnd?.(ctx2);
    threadStore.close();
  });
});
