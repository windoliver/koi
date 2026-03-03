import { describe, expect, test } from "bun:test";
import type { MessageThreadSnapshot, SnapshotNode, ThreadSnapshot } from "@koi/core";
import { agentId, nodeId, threadId, threadMessageId } from "@koi/core";
import { createThreadCompactor } from "./thread-compactor.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMessageSnapshot(
  msgCount: number,
  turnIndex: number,
  createdAt?: number,
): MessageThreadSnapshot {
  return {
    kind: "message",
    threadId: threadId("thread-1"),
    agentId: agentId("agent-1"),
    messages: Array.from({ length: msgCount }, (_, i) => ({
      id: threadMessageId(`msg-${turnIndex}-${i}`),
      role: "user" as const,
      content: `Message ${i}`,
      createdAt: (createdAt ?? 1000) + i,
    })),
    turnIndex,
    createdAt: createdAt ?? 1000 + turnIndex,
  };
}

function wrapAsNode(data: ThreadSnapshot, id: string): SnapshotNode<ThreadSnapshot> {
  return {
    nodeId: nodeId(id),
    chainId: "thread-1" as never,
    parentIds: [],
    contentHash: `hash-${id}`,
    data,
    createdAt: data.createdAt,
    metadata: {},
  };
}

/** Extract node data with assertion — avoids `T | undefined` mismatch in toBe(). */
function nodeData(nodes: readonly SnapshotNode<ThreadSnapshot>[], index: number): ThreadSnapshot {
  const node = nodes[index];
  if (node === undefined) throw new Error(`Node at index ${index} is undefined`);
  return node.data;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createThreadCompactor", () => {
  test("returns last node when within retention window", () => {
    const compactor = createThreadCompactor({ retainMessageSnapshots: 50, compactOlder: true });

    const nodes: SnapshotNode<ThreadSnapshot>[] = Array.from({ length: 10 }, (_, i) =>
      wrapAsNode(createMessageSnapshot(2, i, 1000 + i * 100), `n${i}`),
    );

    const result = compactor.compact(nodes);
    expect(result.kind).toBe("message");
    expect(result).toBe(nodeData(nodes, 9));
  });

  test("compacts older message snapshots when exceeding window", () => {
    const compactor = createThreadCompactor({ retainMessageSnapshots: 3, compactOlder: true });

    const nodes: SnapshotNode<ThreadSnapshot>[] = Array.from({ length: 5 }, (_, i) =>
      wrapAsNode(createMessageSnapshot(2, i, 1000 + i * 100), `n${i}`),
    );

    const result = compactor.compact(nodes);
    // Should return a harness-kind summary of the 2 older nodes
    expect(result.kind).toBe("harness");
    if (result.kind === "harness") {
      expect(result.summaries).toHaveLength(2);
      expect(result.metrics.totalMessages).toBe(4); // 2 messages × 2 older nodes
    }
  });

  test("preserves thread identity in compacted result", () => {
    const compactor = createThreadCompactor({ retainMessageSnapshots: 1, compactOlder: true });

    const nodes: SnapshotNode<ThreadSnapshot>[] = Array.from({ length: 3 }, (_, i) =>
      wrapAsNode(createMessageSnapshot(1, i, 1000 + i * 100), `n${i}`),
    );

    const result = compactor.compact(nodes);
    expect(result.threadId).toBe(threadId("thread-1"));
    expect(result.agentId).toBe(agentId("agent-1"));
  });

  test("does not compact when compactOlder is false", () => {
    const compactor = createThreadCompactor({ retainMessageSnapshots: 2, compactOlder: false });

    const nodes: SnapshotNode<ThreadSnapshot>[] = Array.from({ length: 5 }, (_, i) =>
      wrapAsNode(createMessageSnapshot(1, i, 1000 + i * 100), `n${i}`),
    );

    const result = compactor.compact(nodes);
    // Returns last node unchanged when compaction disabled
    expect(result).toBe(nodeData(nodes, 4));
    expect(result.kind).toBe("message");
  });

  test("uses default policy when none provided", () => {
    const compactor = createThreadCompactor();

    // With default retainMessageSnapshots = 50, 10 nodes should not trigger compaction
    const nodes: SnapshotNode<ThreadSnapshot>[] = Array.from({ length: 10 }, (_, i) =>
      wrapAsNode(createMessageSnapshot(1, i, 1000 + i * 100), `n${i}`),
    );

    const result = compactor.compact(nodes);
    expect(result.kind).toBe("message");
    expect(result).toBe(nodeData(nodes, 9));
  });

  test("throws on empty node sequence", () => {
    const compactor = createThreadCompactor();
    expect(() => compactor.compact([])).toThrow("Cannot compact empty node sequence");
  });

  test("handles harness-only nodes without compaction", () => {
    const compactor = createThreadCompactor({ retainMessageSnapshots: 2, compactOlder: true });

    const harnessData: ThreadSnapshot = {
      kind: "harness",
      threadId: threadId("thread-1"),
      agentId: agentId("agent-1"),
      taskBoard: { items: [], results: [] },
      summaries: [],
      metrics: { totalMessages: 0, totalTurns: 0, totalTokens: 0, lastActivityAt: 0 },
      createdAt: 1000,
    };

    const nodes = [wrapAsNode(harnessData, "h1")];
    const result = compactor.compact(nodes);
    expect(result).toBe(harnessData);
  });

  test("aggregates metrics correctly across older nodes", () => {
    const compactor = createThreadCompactor({ retainMessageSnapshots: 1, compactOlder: true });

    const nodes: SnapshotNode<ThreadSnapshot>[] = [
      wrapAsNode(createMessageSnapshot(3, 0, 1000), "n0"),
      wrapAsNode(createMessageSnapshot(5, 1, 2000), "n1"),
      wrapAsNode(createMessageSnapshot(2, 2, 3000), "n2"),
    ];

    // 2 older nodes (n0, n1), 1 retained (n2)
    const result = compactor.compact(nodes);
    expect(result.kind).toBe("harness");
    if (result.kind === "harness") {
      expect(result.metrics.totalMessages).toBe(8); // 3 + 5
      expect(result.metrics.totalTurns).toBe(1); // 0 + 1
      expect(result.metrics.lastActivityAt).toBe(2000);
    }
  });
});
