/**
 * Tests for the shared context-arena config factory (Decision 12A).
 */

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { InboundMessage } from "@koi/core/message";
import type { ModelHandler } from "@koi/core/middleware";
import { createContextArenaConfigForUp } from "./context-arena-config.js";

/** Minimal stub — never called during config construction. */
const stubSummarizer: ModelHandler = () => {
  throw new Error("stub");
};

const baseInput = {
  summarizer: stubSummarizer,
  manifestName: "test-agent",
  getMessages: (): readonly InboundMessage[] => [],
} as const;

describe("createContextArenaConfigForUp", () => {
  // --- Backend resolution (Decision 2A) ---

  test("memory backend creates a valid config", () => {
    const result = createContextArenaConfigForUp({
      ...baseInput,
      threadStoreBackend: "memory",
    });

    expect(result.config.summarizer).toBe(stubSummarizer);
    expect(result.config.threadStore).toBeDefined();
    expect(result.config.conversation).toBeDefined();
    expect(typeof result.dispose).toBe("function");
  });

  test("sqlite backend creates a valid config", () => {
    // Use tmpdir() directly — SQLite needs parent dir to exist
    const result = createContextArenaConfigForUp({
      ...baseInput,
      threadStoreBackend: "sqlite",
      dataDir: tmpdir(),
    });

    expect(result.config.threadStore).toBeDefined();
    expect(typeof result.dispose).toBe("function");
  });

  test("defaults to memory backend when threadStoreBackend is undefined", () => {
    const result = createContextArenaConfigForUp(baseInput);

    expect(result.config.threadStore).toBeDefined();
    // Should not throw — in-memory store is always available
  });

  test("nexus backend falls back to sqlite when no nexusSnapshotStore", () => {
    const result = createContextArenaConfigForUp({
      ...baseInput,
      threadStoreBackend: "nexus",
      dataDir: tmpdir(),
    });

    // Falls back to SQLite — should still produce a valid config
    expect(result.config.threadStore).toBeDefined();
  });

  test("nexus backend uses provided nexusSnapshotStore", () => {
    const mockStore = createMockSnapshotStore();
    const result = createContextArenaConfigForUp({
      ...baseInput,
      threadStoreBackend: "nexus",
      nexusSnapshotStore: mockStore,
    });

    expect(result.config.threadStore).toBeDefined();
  });

  // --- Config shape ---

  test("sessionId contains manifest name", () => {
    const result = createContextArenaConfigForUp({
      ...baseInput,
      manifestName: "my-agent",
    });

    // SessionId is branded, but the underlying string contains the manifest name
    expect(String(result.sessionId)).toContain("my-agent");
  });

  test("getMessages callback is passed through", () => {
    const messages: readonly InboundMessage[] = [
      { content: [{ kind: "text", text: "hello" }], senderId: "user", timestamp: Date.now() },
    ];
    const getMessages = () => messages;

    const result = createContextArenaConfigForUp({
      ...baseInput,
      getMessages,
    });

    expect(result.config.getMessages()).toBe(messages);
  });

  test("resolveThreadId callback is passed through", () => {
    const resolveThreadId = () => "thread-1";

    const result = createContextArenaConfigForUp({
      ...baseInput,
      resolveThreadId,
    });

    expect(result.config.conversation?.resolveThreadId?.(undefined as never)).toBe("thread-1");
  });

  test("dispose is callable without error", async () => {
    const result = createContextArenaConfigForUp({
      ...baseInput,
      threadStoreBackend: "memory",
    });

    // Should not throw
    await result.dispose();
  });
});

/** Creates a mock ThreadSnapshotStore with no-op methods. */
function createMockSnapshotStore(): import("@koi/core").ThreadSnapshotStore {
  return {
    put: async () => ({ ok: true, value: undefined }) as never,
    get: async () => ({ ok: true, value: undefined }) as never,
    head: async () => ({ ok: true, value: undefined }),
    list: async () => ({ ok: true, value: [] }),
    ancestors: async () => ({ ok: true, value: [] }),
    fork: async () => ({ ok: true, value: undefined }) as never,
    prune: async () => ({ ok: true, value: 0 }),
    close: () => {},
  };
}
