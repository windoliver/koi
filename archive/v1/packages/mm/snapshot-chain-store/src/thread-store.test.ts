import { describe, expect, test } from "bun:test";
import type { MessageThreadSnapshot, ThreadMessage } from "@koi/core";
import { agentId, threadId, threadMessageId } from "@koi/core";
import { runThreadStoreContractTests } from "@koi/test-utils";
import { createInMemorySnapshotChainStore } from "./memory-store.js";
import { createThreadStore } from "./thread-store.js";

// ---------------------------------------------------------------------------
// Contract test suite (Decision 10C)
// ---------------------------------------------------------------------------

runThreadStoreContractTests(() => createThreadStore({ store: createInMemorySnapshotChainStore() }));

// ---------------------------------------------------------------------------
// Additional implementation-specific tests
// ---------------------------------------------------------------------------

describe("createThreadStore", () => {
  test("second append builds on head of first", async () => {
    const store = createThreadStore({ store: createInMemorySnapshotChainStore() });
    const tid = threadId("thread-chain");

    const msg1: ThreadMessage = {
      id: threadMessageId("m1"),
      role: "user",
      content: "hello",
      createdAt: 1000,
    };
    const snap1: MessageThreadSnapshot = {
      kind: "message",
      threadId: tid,
      agentId: agentId("agent-1"),
      messages: [msg1],
      turnIndex: 0,
      createdAt: 1000,
    };
    await store.appendAndCheckpoint(tid, [msg1], snap1);

    const msg2: ThreadMessage = {
      id: threadMessageId("m2"),
      role: "assistant",
      content: "hi there",
      createdAt: 2000,
    };
    const snap2: MessageThreadSnapshot = {
      kind: "message",
      threadId: tid,
      agentId: agentId("agent-1"),
      messages: [msg2],
      turnIndex: 1,
      createdAt: 2000,
    };
    const result = await store.appendAndCheckpoint(tid, [msg2], snap2);
    expect(result.ok).toBe(true);

    // Latest snapshot should be the second one
    const loaded = await store.loadThread(tid);
    expect(loaded.ok).toBe(true);
    if (loaded.ok && loaded.value?.kind === "message") {
      expect(loaded.value.turnIndex).toBe(1);
    }
  });

  test("listMessages deduplicates across snapshots", async () => {
    const store = createThreadStore({ store: createInMemorySnapshotChainStore() });
    const tid = threadId("thread-dedup");

    const msg1: ThreadMessage = {
      id: threadMessageId("dup-test-1"),
      role: "user",
      content: "first",
      createdAt: 1000,
    };
    const snap1: MessageThreadSnapshot = {
      kind: "message",
      threadId: tid,
      agentId: agentId("a"),
      messages: [msg1],
      turnIndex: 0,
      createdAt: 1000,
    };
    await store.appendAndCheckpoint(tid, [msg1], snap1);

    // Second snapshot also includes msg1 in its messages array
    const msg2: ThreadMessage = {
      id: threadMessageId("dup-test-2"),
      role: "assistant",
      content: "second",
      createdAt: 2000,
    };
    const snap2: MessageThreadSnapshot = {
      kind: "message",
      threadId: tid,
      agentId: agentId("a"),
      messages: [msg1, msg2], // msg1 repeated
      turnIndex: 1,
      createdAt: 2000,
    };
    await store.appendAndCheckpoint(tid, [msg2], snap2);

    const result = await store.listMessages(tid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should deduplicate msg1
      expect(result.value).toHaveLength(2);
    }
  });
});
