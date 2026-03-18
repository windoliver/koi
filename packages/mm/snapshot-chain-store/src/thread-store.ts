/**
 * ThreadStore facade — thin adapter over SnapshotChainStore<ThreadSnapshot>.
 *
 * Maps ThreadId → ChainId (identity), provides idempotent append-and-checkpoint,
 * and deduplicates messages by ThreadMessageId (Decision 6A).
 */

import type {
  ChainId,
  KoiError,
  Result,
  ThreadId,
  ThreadMessage,
  ThreadMessageId,
  ThreadSnapshot,
  ThreadSnapshotStore,
  ThreadStore,
} from "@koi/core";
import { conflict } from "@koi/core";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Default maximum retained snapshots per thread before pruning. */
const DEFAULT_MAX_RETAINED = 500;

export interface CreateThreadStoreConfig {
  readonly store: ThreadSnapshotStore;
  /**
   * Maximum snapshots to retain per thread. Older snapshots are pruned
   * after each append to bound disk/memory growth.
   * Default: 500 (~2.5 MB per thread at 5 KB/snapshot).
   */
  readonly maxRetained?: number;
}

/**
 * Create a ThreadStore backed by a SnapshotChainStore<ThreadSnapshot>.
 *
 * Idempotency: duplicate ThreadMessageId values produce a CONFLICT error
 * (Decision 6A). The idempotency set is maintained in-memory per thread.
 */
export function createThreadStore(config: CreateThreadStoreConfig): ThreadStore {
  const { store } = config;
  const maxRetained = config.maxRetained ?? DEFAULT_MAX_RETAINED;

  // Per-thread idempotency tracking: ThreadId → Set<ThreadMessageId>
  const seenMessages = new Map<string, Set<string>>();

  /** Get or create the idempotency set for a thread. */
  function getSeenSet(tid: ThreadId): Set<string> {
    const existing = seenMessages.get(tid);
    if (existing !== undefined) return existing;
    const fresh = new Set<string>();
    seenMessages.set(tid, fresh);
    return fresh;
  }

  const appendAndCheckpoint: ThreadStore["appendAndCheckpoint"] = async (
    tid: ThreadId,
    messages: readonly ThreadMessage[],
    snapshot: ThreadSnapshot,
  ): Promise<Result<void, KoiError>> => {
    const seen = getSeenSet(tid);

    // Check idempotency — reject duplicate message IDs
    for (const msg of messages) {
      if (seen.has(msg.id)) {
        return {
          ok: false,
          error: conflict(msg.id, `Duplicate message ID: ${msg.id}`),
        };
      }
    }

    // Determine parent: current head or empty for first node
    const chainId = tid as unknown as ChainId;
    const headResult = await store.head(chainId);
    if (!headResult.ok) return { ok: false, error: headResult.error };

    const parentIds = headResult.value !== undefined ? [headResult.value.nodeId] : [];

    // Persist snapshot
    const putResult = await store.put(chainId, snapshot, parentIds, {
      messageCount: messages.length,
    });
    if (!putResult.ok) return { ok: false, error: putResult.error };

    // Mark message IDs as seen (only after successful persistence)
    for (const msg of messages) {
      seen.add(msg.id);
    }

    // Prune old snapshots to bound storage growth (best-effort, non-fatal)
    if (maxRetained > 0) {
      try {
        await store.prune(chainId, { retainCount: maxRetained });
      } catch {
        // Pruning failure should never block message persistence
      }
    }

    return { ok: true, value: undefined };
  };

  const loadThread: ThreadStore["loadThread"] = async (
    tid: ThreadId,
  ): Promise<Result<ThreadSnapshot | undefined, KoiError>> => {
    const chainId = tid as unknown as ChainId;
    const headResult = await store.head(chainId);
    if (!headResult.ok) return { ok: false, error: headResult.error };
    return { ok: true, value: headResult.value?.data };
  };

  const listMessages: ThreadStore["listMessages"] = async (
    tid: ThreadId,
    limit?: number,
  ): Promise<Result<readonly ThreadMessage[], KoiError>> => {
    const chainId = tid as unknown as ChainId;
    const listResult = await store.list(chainId);
    if (!listResult.ok) return { ok: false, error: listResult.error };

    // Extract messages from message-kind snapshots, deduplicate by ID
    const seenIds = new Set<ThreadMessageId>();
    const allMessages: ThreadMessage[] = [];

    for (const node of listResult.value) {
      if (node.data.kind === "message") {
        for (const msg of node.data.messages) {
          if (!seenIds.has(msg.id)) {
            seenIds.add(msg.id);
            allMessages.push(msg);
          }
        }
      }
    }

    // Sort by createdAt ascending
    allMessages.sort((a, b) => a.createdAt - b.createdAt);

    // Apply limit (return newest messages)
    if (limit !== undefined && limit > 0 && allMessages.length > limit) {
      return { ok: true, value: allMessages.slice(allMessages.length - limit) };
    }

    return { ok: true, value: allMessages };
  };

  const close: ThreadStore["close"] = (): void | Promise<void> => {
    seenMessages.clear();
    return store.close();
  };

  return { appendAndCheckpoint, loadThread, listMessages, close };
}
