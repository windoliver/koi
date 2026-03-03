import { describe, expect, test } from "bun:test";
import type {
  InboundMessage,
  KoiError,
  Result,
  ThreadId,
  ThreadMessage,
  ThreadSnapshot,
  ThreadStore,
} from "@koi/core";
import { sessionId, threadId } from "@koi/core";
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

/**
 * Wrap a ThreadStore to add a configurable delay to appendAndCheckpoint.
 * This allows us to test the per-thread write mutex under concurrency.
 */
function createDelayedStore(
  inner: ThreadStore,
  delayMs: number,
): ThreadStore & { readonly writeOrder: string[] } {
  const writeOrder: string[] = [];

  return {
    writeOrder,
    listMessages(tid, limit?) {
      return inner.listMessages(tid, limit);
    },
    loadThread(tid) {
      return inner.loadThread(tid);
    },
    async appendAndCheckpoint(
      tid: ThreadId,
      messages: readonly ThreadMessage[],
      snapshot: ThreadSnapshot,
    ): Promise<Result<void, KoiError>> {
      // Record which messages are being written (by content of first msg)
      const label = messages[0]?.content ?? "unknown";
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      writeOrder.push(label);
      return inner.appendAndCheckpoint(tid, messages, snapshot);
    },
    close() {
      return inner.close();
    },
  };
}

describe("concurrency", () => {
  test("concurrent onSessionEnd calls are serialized per threadId", async () => {
    const chainStore = createInMemorySnapshotChainStore<ThreadSnapshot>();
    const baseStore = createThreadStore({ store: chainStore });
    const store = createDelayedStore(baseStore, 50);

    // Create 3 middleware instances sharing the same store
    // Each simulates a concurrent session on the same thread
    const instances = [1, 2, 3].map((i) => {
      const mw = createConversationMiddleware({
        store,
        maxHistoryTokens: 10_000,
      });
      return { mw, label: `session-${i}` };
    });

    // Start all sessions with unique sessionIds
    const contexts = await Promise.all(
      instances.map(async ({ mw, label }) => {
        const ctx = createMockSessionContext({
          sessionId: sessionId(`concurrent-${label}`),
          metadata: { threadId: "shared-thread" },
        });
        await mw.onSessionStart?.(ctx);

        // Simulate model call
        const spy = createSpyModelHandler({
          content: `reply-${label}`,
          model: "test",
        });
        await mw.wrapModelCall?.(
          createMockTurnContext({ session: ctx }),
          { messages: [userInbound(label)] },
          spy.handler,
        );

        return { mw, ctx };
      }),
    );

    // Fire all onSessionEnd concurrently
    await Promise.all(contexts.map(({ mw, ctx }) => mw.onSessionEnd?.(ctx)));

    // All 3 writes should have completed
    expect(store.writeOrder.length).toBe(3);

    // The final store should have all messages
    const result = await baseStore.listMessages(threadId("shared-thread"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Each session writes 2 messages (user + assistant)
      expect(result.value.length).toBe(6);
    }

    baseStore.close();
  });
});
