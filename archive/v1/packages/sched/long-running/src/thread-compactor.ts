/**
 * Thread compactor — prunes old message snapshots into context summaries (Decision 13A).
 *
 * Implements `ChainCompactor<ThreadSnapshot>` for integration with
 * `SnapshotChainStore.prune()`. Keeps the last N message snapshots
 * and folds older message nodes into a single harness-kind summary snapshot.
 */

import type {
  ChainCompactor,
  ContextSummaryRef,
  HarnessThreadSnapshot,
  SnapshotNode,
  ThreadPruningPolicy,
  ThreadSnapshot,
} from "@koi/core";
import { DEFAULT_THREAD_PRUNING_POLICY, isMessageSnapshot } from "@koi/core";
import { CHARS_PER_TOKEN } from "@koi/token-estimator";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a compactor that retains recent message snapshots and
 * folds older ones into a summary snapshot.
 *
 * The compactor processes a sequence of SnapshotNodes:
 * 1. Identifies message-kind snapshots vs harness-kind snapshots
 * 2. Keeps the most recent `retainMessageSnapshots` message nodes
 * 3. Summarizes older message nodes into a single HarnessThreadSnapshot
 *    with aggregated metrics and context summary references
 * 4. Harness-kind snapshots always pass through unchanged
 */
export function createThreadCompactor(
  policy?: ThreadPruningPolicy,
): ChainCompactor<ThreadSnapshot> {
  const resolved = policy ?? DEFAULT_THREAD_PRUNING_POLICY;

  return {
    compact: (nodes: readonly SnapshotNode<ThreadSnapshot>[]): ThreadSnapshot => {
      // Separate message snapshots from harness snapshots
      const messageNodes: readonly SnapshotNode<ThreadSnapshot>[] = nodes.filter((n) =>
        isMessageSnapshot(n.data),
      );

      if (messageNodes.length === 0) {
        // Nothing to compact — return the last node's data as-is
        const last = nodes[nodes.length - 1];
        if (last === undefined) {
          throw new Error("Cannot compact empty node sequence");
        }
        return last.data;
      }

      // If we're within the retention window, no compaction needed
      if (messageNodes.length <= resolved.retainMessageSnapshots) {
        const last = nodes[nodes.length - 1];
        if (last === undefined) {
          throw new Error("Cannot compact empty node sequence");
        }
        return last.data;
      }

      if (!resolved.compactOlder) {
        // Compaction disabled — return last node
        const last = nodes[nodes.length - 1];
        if (last === undefined) {
          throw new Error("Cannot compact empty node sequence");
        }
        return last.data;
      }

      // Compact older message snapshots into a summary
      const olderCount = messageNodes.length - resolved.retainMessageSnapshots;
      const olderNodes = messageNodes.slice(0, olderCount);

      // Aggregate metrics from older snapshots
      // let justified: mutable counter for aggregation
      let totalMessages = 0;
      // let justified: mutable counter for aggregation
      let totalTurns = 0;
      // let justified: mutable counter for tracking latest activity
      let lastActivityAt = 0;

      const summaries: ContextSummaryRef[] = [];

      for (const node of olderNodes) {
        const data = node.data;
        if (isMessageSnapshot(data)) {
          totalMessages += data.messages.length;
          totalTurns += data.turnIndex;
          if (data.createdAt > lastActivityAt) {
            lastActivityAt = data.createdAt;
          }

          summaries.push({
            sessionSeq: summaries.length,
            estimatedTokens: estimateTokens(data.messages.length),
            generatedAt: data.createdAt,
          });
        }
      }

      // Use the first message snapshot for thread/agent identity
      const firstNode = olderNodes[0];
      if (firstNode === undefined) {
        throw new Error("Cannot compact: older nodes unexpectedly empty");
      }
      const firstMessage = firstNode.data;

      const compacted: HarnessThreadSnapshot = {
        kind: "harness",
        threadId: firstMessage.threadId,
        agentId: firstMessage.agentId,
        sessionId: firstMessage.sessionId,
        taskBoard: { items: [], results: [] },
        summaries,
        metrics: {
          totalMessages,
          totalTurns,
          totalTokens: estimateTokens(totalMessages),
          lastActivityAt,
        },
        createdAt: Date.now(),
      };

      return compacted;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rough token estimate: ~50 chars per message, using canonical chars-per-token. */
function estimateTokens(messageCount: number): number {
  return Math.ceil((messageCount * 50) / CHARS_PER_TOKEN);
}
