/**
 * Reusable contract test suite for ThreadStore implementations (Decision 10C).
 *
 * Validates: round-trip, idempotency (CONFLICT on duplicate ID),
 * missing thread, listMessages ordering/limit, and close idempotency.
 */

import { describe, expect, test } from "bun:test";
import type { MessageThreadSnapshot, ThreadMessage, ThreadStore } from "@koi/core";
import { agentId, threadId, threadMessageId } from "@koi/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMessage(id: string, content: string, createdAt: number): ThreadMessage {
  return {
    id: threadMessageId(id),
    role: "user",
    content,
    createdAt,
  };
}

function createMessageSnapshot(
  tid: string,
  messages: readonly ThreadMessage[],
  turnIndex: number,
): MessageThreadSnapshot {
  return {
    kind: "message",
    threadId: threadId(tid),
    agentId: agentId("test-agent"),
    messages,
    turnIndex,
    createdAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Contract test suite
// ---------------------------------------------------------------------------

export function runThreadStoreContractTests(
  createStore: () => ThreadStore | Promise<ThreadStore>,
): void {
  describe("ThreadStore contract", () => {
    test("round-trip: append and load returns latest snapshot", async () => {
      const store = await createStore();
      const tid = threadId("thread-1");
      const msg = createMessage("msg-1", "hello", Date.now());
      const snapshot = createMessageSnapshot("thread-1", [msg], 0);

      const appendResult = await store.appendAndCheckpoint(tid, [msg], snapshot);
      expect(appendResult.ok).toBe(true);

      const loadResult = await store.loadThread(tid);
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value).toBeDefined();
        expect(loadResult.value?.kind).toBe("message");
        if (loadResult.value?.kind === "message") {
          expect(loadResult.value.messages).toHaveLength(1);
          expect(loadResult.value.messages[0]?.content).toBe("hello");
        }
      }

      await store.close();
    });

    test("CONFLICT on duplicate message ID", async () => {
      const store = await createStore();
      const tid = threadId("thread-2");
      const msg = createMessage("msg-dup", "first", Date.now());
      const snapshot1 = createMessageSnapshot("thread-2", [msg], 0);

      const first = await store.appendAndCheckpoint(tid, [msg], snapshot1);
      expect(first.ok).toBe(true);

      const snapshot2 = createMessageSnapshot("thread-2", [msg], 1);
      const second = await store.appendAndCheckpoint(tid, [msg], snapshot2);
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error.code).toBe("CONFLICT");
      }

      await store.close();
    });

    test("loadThread returns undefined for missing thread", async () => {
      const store = await createStore();
      const result = await store.loadThread(threadId("nonexistent"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeUndefined();
      }

      await store.close();
    });

    test("listMessages returns messages sorted by createdAt", async () => {
      const store = await createStore();
      const tid = threadId("thread-3");

      const msg1 = createMessage("msg-a", "first", 1000);
      const msg2 = createMessage("msg-b", "second", 2000);
      const snap1 = createMessageSnapshot("thread-3", [msg1, msg2], 0);
      await store.appendAndCheckpoint(tid, [msg1, msg2], snap1);

      const msg3 = createMessage("msg-c", "third", 3000);
      const snap2 = createMessageSnapshot("thread-3", [msg3], 1);
      await store.appendAndCheckpoint(tid, [msg3], snap2);

      const result = await store.listMessages(tid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(3);
        expect(result.value[0]?.content).toBe("first");
        expect(result.value[1]?.content).toBe("second");
        expect(result.value[2]?.content).toBe("third");
      }

      await store.close();
    });

    test("listMessages respects limit", async () => {
      const store = await createStore();
      const tid = threadId("thread-4");

      const messages: ThreadMessage[] = [];
      for (let i = 0; i < 5; i++) {
        messages.push(createMessage(`msg-${i}`, `content-${i}`, i * 1000));
      }
      const snap = createMessageSnapshot("thread-4", messages, 0);
      await store.appendAndCheckpoint(tid, messages, snap);

      const result = await store.listMessages(tid, 2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        // Returns newest messages
        expect(result.value[0]?.content).toBe("content-3");
        expect(result.value[1]?.content).toBe("content-4");
      }

      await store.close();
    });

    test("close is idempotent", async () => {
      const store = await createStore();
      await store.close();
      await store.close(); // Second close should not throw
    });
  });
}
