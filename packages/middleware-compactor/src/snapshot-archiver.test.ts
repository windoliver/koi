import { describe, expect, test } from "bun:test";
import type {
  ChainId,
  KoiError,
  NodeId,
  PutOptions,
  Result,
  SnapshotChainStore,
  SnapshotNode,
} from "@koi/core";
import { chainId, nodeId, sessionId } from "@koi/core";
import type { InboundMessage } from "@koi/core/message";
import { createSnapshotArchiver } from "./snapshot-archiver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(text: string): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "user",
    timestamp: Date.now(),
  };
}

interface SpyCall {
  readonly chainId: ChainId;
  readonly data: readonly InboundMessage[];
  readonly parentIds: readonly NodeId[];
  readonly metadata: Readonly<Record<string, unknown>> | undefined;
  readonly options: PutOptions | undefined;
}

function createSpyStore(
  headValue?: SnapshotNode<readonly InboundMessage[]>,
  headOk = true,
  putOk = true,
): {
  readonly store: SnapshotChainStore<readonly InboundMessage[]>;
  readonly putCalls: SpyCall[];
} {
  const putCalls: SpyCall[] = [];

  const store: SnapshotChainStore<readonly InboundMessage[]> = {
    put(
      cid: ChainId,
      data: readonly InboundMessage[],
      parentIds: readonly NodeId[],
      metadata?: Readonly<Record<string, unknown>>,
      options?: PutOptions,
    ): Result<SnapshotNode<readonly InboundMessage[]> | undefined, KoiError> {
      putCalls.push({ chainId: cid, data, parentIds, metadata, options });
      if (!putOk) {
        return {
          ok: false,
          error: { code: "INTERNAL", message: "put failed", retryable: false },
        };
      }
      return { ok: true, value: undefined };
    },

    head(_cid: ChainId): Result<SnapshotNode<readonly InboundMessage[]> | undefined, KoiError> {
      if (!headOk) {
        return {
          ok: false,
          error: { code: "INTERNAL", message: "head failed", retryable: false },
        };
      }
      return { ok: true, value: headValue };
    },

    get: () => ({ ok: false, error: { code: "NOT_FOUND", message: "stub", retryable: false } }),
    list: () => ({ ok: true, value: [] }),
    ancestors: () => ({ ok: true, value: [] }),
    fork: () => ({ ok: false, error: { code: "INTERNAL", message: "stub", retryable: false } }),
    prune: () => ({ ok: true, value: 0 }),
    close: () => {},
  };

  return { store, putCalls };
}

/** Get first spy call, throwing if none recorded. */
function firstCall(putCalls: readonly SpyCall[]): SpyCall {
  const call = putCalls[0];
  if (call === undefined) throw new Error("expected at least one put() call");
  return call;
}

const SESSION_ID = sessionId("session-42");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSnapshotArchiver", () => {
  test("archives messages to root node on first call (empty parentIds)", async () => {
    const { store, putCalls } = createSpyStore();
    const archiver = createSnapshotArchiver(store, { sessionId: SESSION_ID });

    await archiver.archive([makeMessage("hello")], "summary-1");

    expect(putCalls).toHaveLength(1);
    expect(firstCall(putCalls).parentIds).toEqual([]);
  });

  test("uses parentIds from previous head on subsequent calls", async () => {
    const headNode = {
      nodeId: nodeId("node-prev"),
      chainId: chainId("compact:session-42"),
      parentIds: [],
      contentHash: "abc",
      data: [],
      createdAt: 1000,
      metadata: {},
    } satisfies SnapshotNode<readonly InboundMessage[]>;

    const { store, putCalls } = createSpyStore(headNode);
    const archiver = createSnapshotArchiver(store, { sessionId: SESSION_ID });

    await archiver.archive([makeMessage("msg")], "sum");

    expect(firstCall(putCalls).parentIds).toEqual([nodeId("node-prev")]);
  });

  test("stores summary string in node metadata", async () => {
    const { store, putCalls } = createSpyStore();
    const archiver = createSnapshotArchiver(store, { sessionId: SESSION_ID });

    await archiver.archive([makeMessage("x")], "my-summary");

    expect(firstCall(putCalls).metadata).toMatchObject({ summary: "my-summary" });
  });

  test("stores timestamp in node metadata", async () => {
    const { store, putCalls } = createSpyStore();
    const archiver = createSnapshotArchiver(store, { sessionId: SESSION_ID });

    const before = Date.now();
    await archiver.archive([makeMessage("x")], "sum");
    const after = Date.now();

    const ts = firstCall(putCalls).metadata?.timestamp;
    expect(typeof ts).toBe("number");
    if (typeof ts !== "number") throw new Error("expected number");
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  test("uses chain ID compact:{sessionId}", async () => {
    const { store, putCalls } = createSpyStore();
    const archiver = createSnapshotArchiver(store, { sessionId: SESSION_ID });

    await archiver.archive([makeMessage("x")], "sum");

    expect(firstCall(putCalls).chainId).toBe(chainId("compact:session-42"));
  });

  test("passes skipIfUnchanged option", async () => {
    const { store, putCalls } = createSpyStore();
    const archiver = createSnapshotArchiver(store, { sessionId: SESSION_ID });

    await archiver.archive([makeMessage("x")], "sum");

    expect(firstCall(putCalls).options).toEqual({ skipIfUnchanged: true });
  });

  test("throws when store.head() returns ok: false", async () => {
    const { store } = createSpyStore(undefined, false);
    const archiver = createSnapshotArchiver(store, { sessionId: SESSION_ID });

    await expect(archiver.archive([makeMessage("x")], "sum")).rejects.toThrow(
      "Failed to read archive chain head: head failed",
    );
  });

  test("throws when store.put() returns ok: false", async () => {
    const { store } = createSpyStore(undefined, true, false);
    const archiver = createSnapshotArchiver(store, { sessionId: SESSION_ID });

    await expect(archiver.archive([makeMessage("x")], "sum")).rejects.toThrow(
      "Failed to archive compaction snapshot: put failed",
    );
  });
});
