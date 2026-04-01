/**
 * Unit tests for squash tool logic.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { KoiError, NodeId, SnapshotChainStore } from "@koi/core";
import { chainId, nodeId } from "@koi/core";
import type { MemoryComponent, MemoryStoreOptions } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import { heuristicTokenEstimator } from "./estimator.js";
import { createSquashTool } from "./squash-tool.js";
import type { PendingQueue, ResolvedSquashConfig } from "./types.js";
import { createPendingQueue, SQUASH_DEFAULTS } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(text: string, opts?: { readonly pinned?: boolean }): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "user",
    timestamp: Date.now(),
    ...(opts?.pinned === true ? { pinned: true } : {}),
  };
}

function createMockArchiver(): SnapshotChainStore<readonly InboundMessage[]> & {
  readonly putMock: ReturnType<typeof mock>;
  readonly headMock: ReturnType<typeof mock>;
} {
  const mockNodeId = nodeId("node-123");
  const mockChainId = chainId("test-chain");

  const putMock = mock(() => ({
    ok: true as const,
    value: {
      nodeId: mockNodeId,
      chainId: mockChainId,
      parentIds: [] as readonly NodeId[],
      contentHash: "abc",
      data: [] as readonly InboundMessage[],
      createdAt: Date.now(),
      metadata: {} as Readonly<Record<string, unknown>>,
    },
  }));

  const headMock = mock(() => ({ ok: true as const, value: undefined }));

  const notFoundError: KoiError = {
    code: "NOT_FOUND",
    message: "not found",
    retryable: false,
  };

  return {
    put: putMock,
    get: mock(() => ({ ok: false as const, error: notFoundError })),
    head: headMock,
    list: mock(() => ({ ok: true as const, value: [] as readonly never[] })),
    ancestors: mock(() => ({ ok: true as const, value: [] as readonly never[] })),
    fork: mock(() => ({ ok: true as const, value: { parentNodeId: nodeId("n"), label: "l" } })),
    prune: mock(() => ({ ok: true as const, value: 0 })),
    close: mock(() => undefined),
    putMock,
    headMock,
  };
}

function createMockMemory(): MemoryComponent & {
  readonly storeMock: ReturnType<typeof mock>;
} {
  const storeMock = mock(() => Promise.resolve());
  return {
    recall: mock(() => Promise.resolve([])),
    store: storeMock,
    storeMock,
  };
}

function makeConfig(overrides?: Partial<ResolvedSquashConfig>): ResolvedSquashConfig {
  const archiver = createMockArchiver();
  return {
    archiver,
    memory: undefined,
    tokenEstimator: heuristicTokenEstimator,
    preserveRecent: SQUASH_DEFAULTS.preserveRecent,
    maxPendingSquashes: SQUASH_DEFAULTS.maxPendingSquashes,
    sessionId: "session-1" as ResolvedSquashConfig["sessionId"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSquashTool", () => {
  // let justified: reset per test
  let pendingQueue: PendingQueue;

  beforeEach(() => {
    pendingQueue = createPendingQueue();
  });

  test("happy path: squash with summary", async () => {
    const archiver = createMockArchiver();
    const config = makeConfig({ archiver });
    const messages = [
      makeMessage("msg1"),
      makeMessage("msg2"),
      makeMessage("msg3"),
      makeMessage("msg4"),
      makeMessage("msg5"),
      makeMessage("msg6"),
    ];
    const tool = createSquashTool(config, pendingQueue, () => messages);

    const result = await tool.execute({ phase: "planning", summary: "We planned stuff." });

    expect(result).toMatchObject({
      ok: true,
      phase: "planning",
      originalMessages: 2,
      archivedNodeId: "node-123",
      factsStored: 0,
    });
    expect(archiver.putMock).toHaveBeenCalledTimes(1);
    expect(pendingQueue.length).toBe(1);
    const drained = pendingQueue.drain();
    expect(drained[0]?.result.strategy).toBe("squash");
  });

  test("with facts: stores to memory", async () => {
    const memory = createMockMemory();
    const config = makeConfig({ memory });
    const messages = Array.from({ length: 6 }, (_, i) => makeMessage(`msg${String(i)}`));
    const tool = createSquashTool(config, pendingQueue, () => messages);

    const result = await tool.execute({
      phase: "research",
      summary: "Research complete.",
      facts: ["fact1", "fact2"],
    });

    expect(result).toMatchObject({ ok: true, factsStored: 2 });
    expect(memory.storeMock).toHaveBeenCalledTimes(2);
    // Verify category is the phase
    const firstCallArgs = memory.storeMock.mock.calls[0] as [string, MemoryStoreOptions];
    expect(firstCallArgs[0]).toBe("fact1");
    expect(firstCallArgs[1]).toMatchObject({ category: "research" });
  });

  test("empty message history: noop result", async () => {
    const config = makeConfig();
    const tool = createSquashTool(config, pendingQueue, () => []);

    const result = await tool.execute({ phase: "test", summary: "No messages." });

    expect(result).toMatchObject({
      ok: true,
      originalMessages: 0,
      originalTokens: 0,
      compactedTokens: 0,
    });
    expect(pendingQueue.length).toBe(0);
  });

  test("fewer than preserveRecent messages: noop result", async () => {
    const config = makeConfig({ preserveRecent: 4 });
    const messages = [makeMessage("msg1"), makeMessage("msg2"), makeMessage("msg3")];
    const tool = createSquashTool(config, pendingQueue, () => messages);

    const result = await tool.execute({ phase: "test", summary: "Too few." });

    expect(result).toMatchObject({ ok: true, originalMessages: 0 });
    expect(pendingQueue.length).toBe(0);
  });

  test("all messages pinned: noop result", async () => {
    const config = makeConfig({ preserveRecent: 2 });
    const messages = Array.from({ length: 5 }, (_, i) =>
      makeMessage(`pinned${String(i)}`, { pinned: true }),
    );
    const tool = createSquashTool(config, pendingQueue, () => messages);

    const result = await tool.execute({ phase: "test", summary: "All pinned." });

    expect(result).toMatchObject({ ok: true, originalMessages: 0 });
    expect(pendingQueue.length).toBe(0);
  });

  test("mixed pinned + normal: pinned preserved in output", async () => {
    const config = makeConfig({ preserveRecent: 2 });
    const messages = [
      makeMessage("pinned1", { pinned: true }),
      makeMessage("normal1"),
      makeMessage("normal2"),
      makeMessage("normal3"),
      makeMessage("normal4"),
    ];
    const tool = createSquashTool(config, pendingQueue, () => messages);

    const result = await tool.execute({ phase: "impl", summary: "Implementation done." });

    expect(result).toMatchObject({ ok: true, originalMessages: 2 });
    expect(pendingQueue.length).toBe(1);
    // Verify pinned message is preserved in the compacted messages
    const drained = pendingQueue.drain();
    const compactedMessages = drained[0]?.result.messages;
    expect(compactedMessages?.[0]?.pinned).toBe(true);
    // Summary message is second
    expect(compactedMessages?.[1]?.senderId).toBe("system:squash");
  });

  test("archive failure: returns ARCHIVE_FAILED", async () => {
    const archiver = createMockArchiver();
    (archiver as { put: unknown }).put = mock(() => ({
      ok: false,
      error: { code: "STORAGE", message: "disk full", retryable: false },
    }));
    const config = makeConfig({ archiver });
    const messages = Array.from({ length: 6 }, (_, i) => makeMessage(`msg${String(i)}`));
    const tool = createSquashTool(config, pendingQueue, () => messages);

    const result = await tool.execute({ phase: "test", summary: "Will fail." });

    expect(result).toMatchObject({ ok: false, code: "ARCHIVE_FAILED" });
    expect(pendingQueue.length).toBe(0);
  });

  test("memory not provided, facts given: facts silently dropped", async () => {
    const config = makeConfig({ memory: undefined });
    const messages = Array.from({ length: 6 }, (_, i) => makeMessage(`msg${String(i)}`));
    const tool = createSquashTool(config, pendingQueue, () => messages);

    const result = await tool.execute({
      phase: "test",
      summary: "Summary.",
      facts: ["fact1"],
    });

    expect(result).toMatchObject({ ok: true, factsStored: 0 });
  });

  test("memory store throws: squash still succeeds (best-effort)", async () => {
    const memory = createMockMemory();
    (memory as { store: unknown }).store = mock(() => Promise.reject(new Error("store boom")));
    const config = makeConfig({ memory });
    const messages = Array.from({ length: 6 }, (_, i) => makeMessage(`msg${String(i)}`));
    const tool = createSquashTool(config, pendingQueue, () => messages);

    const result = await tool.execute({
      phase: "test",
      summary: "Summary.",
      facts: ["fact1", "fact2"],
    });

    expect(result).toMatchObject({ ok: true, factsStored: 0 });
    expect(pendingQueue.length).toBe(1);
  });

  test("abort signal already aborted: returns ABORTED", async () => {
    const config = makeConfig();
    const tool = createSquashTool(config, pendingQueue, () => []);

    const result = await tool.execute(
      { phase: "test", summary: "Aborted." },
      { signal: AbortSignal.abort() },
    );

    expect(result).toMatchObject({ ok: false, code: "ABORTED" });
  });

  test("invalid args: missing phase", async () => {
    const config = makeConfig();
    const tool = createSquashTool(config, pendingQueue, () => []);

    const result = await tool.execute({ summary: "No phase." });

    expect(result).toMatchObject({ ok: false, code: "VALIDATION" });
  });

  test("invalid args: missing summary", async () => {
    const config = makeConfig();
    const tool = createSquashTool(config, pendingQueue, () => []);

    const result = await tool.execute({ phase: "test" });

    expect(result).toMatchObject({ ok: false, code: "VALIDATION" });
  });

  test("summary with special characters: stored verbatim", async () => {
    const config = makeConfig();
    const specialSummary = 'Special chars: <script>alert("xss")</script> & "quotes" \n newlines';
    const messages = Array.from({ length: 6 }, (_, i) => makeMessage(`msg${String(i)}`));
    const tool = createSquashTool(config, pendingQueue, () => messages);

    const result = await tool.execute({ phase: "test", summary: specialSummary });

    expect(result).toMatchObject({ ok: true });
    const drained = pendingQueue.drain();
    const summaryMsg = drained[0]?.result.messages.find((m) => m.senderId === "system:squash");
    expect(summaryMsg?.content[0]).toMatchObject({ kind: "text", text: specialSummary });
  });
});
