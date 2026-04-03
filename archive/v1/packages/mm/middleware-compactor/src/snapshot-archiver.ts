/**
 * Snapshot-chain compaction archiver.
 *
 * Bridges SnapshotChainStore<readonly InboundMessage[]> → CompactionArchiver
 * so that automatic compaction durably stores original messages before they
 * are replaced by a summary. Chain ID is namespace-separated from squash
 * ("compact:{sessionId}" vs "squash:{sessionId}").
 */

import type { ChainId, SessionId, SnapshotChainStore } from "@koi/core";
import { chainId } from "@koi/core";
import type { InboundMessage } from "@koi/core/message";
import type { CompactionArchiver } from "./types.js";

export interface SnapshotArchiverOptions {
  readonly sessionId: SessionId;
}

/**
 * Creates a CompactionArchiver that persists compacted messages to a
 * SnapshotChainStore, building a linear chain of compaction snapshots.
 *
 * Archive is best-effort — the caller (compact.ts) wraps in try/catch.
 */
export function createSnapshotArchiver(
  store: SnapshotChainStore<readonly InboundMessage[]>,
  options: SnapshotArchiverOptions,
): CompactionArchiver {
  const archiveChainId: ChainId = chainId(`compact:${options.sessionId}`);

  return {
    async archive(messages: readonly InboundMessage[], summary: string): Promise<void> {
      const headResult = await store.head(archiveChainId);
      if (!headResult.ok) {
        throw new Error(`Failed to read archive chain head: ${headResult.error.message}`, {
          cause: headResult.error,
        });
      }
      const parentIds = headResult.value !== undefined ? [headResult.value.nodeId] : [];

      const putResult = await store.put(
        archiveChainId,
        messages,
        parentIds,
        { trigger: "compaction", summary, timestamp: Date.now() },
        { skipIfUnchanged: true },
      );
      if (!putResult.ok) {
        throw new Error(`Failed to archive compaction snapshot: ${putResult.error.message}`, {
          cause: putResult.error,
        });
      }
    },
  };
}
