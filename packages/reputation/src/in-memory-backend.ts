/**
 * In-memory reputation backend with ring-buffer storage.
 *
 * Closure-private Map<AgentId, feedback[]> with configurable per-agent
 * capacity. Idempotent record (duplicate sourceId+targetId+kind+timestamp
 * tuples are silently accepted). All operations are synchronous.
 */

import type {
  AgentId,
  FeedbackKind,
  ReputationBackend,
  ReputationFeedback,
  ReputationQuery,
  ReputationQueryResult,
  ReputationScore,
  Result,
} from "@koi/core";
import { DEFAULT_REPUTATION_QUERY_LIMIT } from "@koi/core";

import { computeScore, DEFAULT_FEEDBACK_WEIGHTS } from "./compute-score.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default maximum feedback entries stored per agent. */
const DEFAULT_MAX_ENTRIES_PER_AGENT = 1000;

export interface InMemoryReputationConfig {
  /** Maximum feedback entries per agent (ring buffer cap). Defaults to 1000. */
  readonly maxEntriesPerAgent?: number | undefined;
  /** Custom weights for score computation. */
  readonly weights?: Readonly<Record<FeedbackKind, number>> | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an in-memory ReputationBackend.
 *
 * All data lives in a closure-private Map. Entries are stored in
 * insertion order per agent, with a ring buffer that evicts the oldest
 * entry when capacity is reached.
 */
export function createInMemoryReputationBackend(
  config?: InMemoryReputationConfig,
): ReputationBackend {
  const maxPerAgent = config?.maxEntriesPerAgent ?? DEFAULT_MAX_ENTRIES_PER_AGENT;
  const weights = config?.weights ?? DEFAULT_FEEDBACK_WEIGHTS;

  // Mutable internal state — hidden behind closure
  const store = new Map<AgentId, ReputationFeedback[]>();
  let disposed = false;

  // -- helpers ---------------------------------------------------------------

  function getOrCreateBucket(targetId: AgentId): ReputationFeedback[] {
    let bucket = store.get(targetId);
    if (bucket === undefined) {
      bucket = [];
      store.set(targetId, bucket);
    }
    return bucket;
  }

  function isDuplicate(
    bucket: readonly ReputationFeedback[],
    feedback: ReputationFeedback,
  ): boolean {
    return bucket.some(
      (existing) =>
        existing.sourceId === feedback.sourceId &&
        existing.targetId === feedback.targetId &&
        existing.kind === feedback.kind &&
        existing.timestamp === feedback.timestamp,
    );
  }

  function matchesFilter(entry: ReputationFeedback, filter: ReputationQuery): boolean {
    if (filter.targetId !== undefined && entry.targetId !== filter.targetId) {
      return false;
    }
    if (filter.sourceId !== undefined && entry.sourceId !== filter.sourceId) {
      return false;
    }
    if (
      filter.kinds !== undefined &&
      filter.kinds.length > 0 &&
      !filter.kinds.includes(entry.kind)
    ) {
      return false;
    }
    if (filter.after !== undefined && entry.timestamp < filter.after) {
      return false;
    }
    if (filter.before !== undefined && entry.timestamp >= filter.before) {
      return false;
    }
    return true;
  }

  // -- backend methods -------------------------------------------------------

  const record: ReputationBackend["record"] = (feedback) => {
    if (disposed) {
      return {
        ok: false,
        error: { code: "INTERNAL", message: "Backend is disposed", retryable: false },
      };
    }

    const bucket = getOrCreateBucket(feedback.targetId);

    // Idempotent: silently accept duplicates
    if (isDuplicate(bucket, feedback)) {
      return { ok: true, value: undefined };
    }

    // Ring buffer: evict oldest when at capacity
    if (bucket.length >= maxPerAgent) {
      bucket.shift();
    }
    bucket.push(feedback);

    return { ok: true, value: undefined };
  };

  const getScore: ReputationBackend["getScore"] = (targetId) => {
    if (disposed) {
      return {
        ok: false,
        error: { code: "INTERNAL", message: "Backend is disposed", retryable: false },
      };
    }

    const bucket = store.get(targetId);
    if (bucket === undefined || bucket.length === 0) {
      return { ok: true, value: undefined };
    }

    return { ok: true, value: computeScore(targetId, bucket, weights) };
  };

  const getScores: ReputationBackend["getScores"] = (targetIds) => {
    if (disposed) {
      return {
        ok: false,
        error: { code: "INTERNAL", message: "Backend is disposed", retryable: false },
      };
    }

    const results = new Map<AgentId, ReputationScore | undefined>();
    for (const id of targetIds) {
      const bucket = store.get(id);
      if (bucket === undefined || bucket.length === 0) {
        results.set(id, undefined);
      } else {
        results.set(id, computeScore(id, bucket, weights));
      }
    }

    return { ok: true, value: results } satisfies Result<
      ReadonlyMap<AgentId, ReputationScore | undefined>
    >;
  };

  const query: ReputationBackend["query"] = (filter) => {
    if (disposed) {
      return {
        ok: false,
        error: { code: "INTERNAL", message: "Backend is disposed", retryable: false },
      };
    }

    const limit = filter.limit ?? DEFAULT_REPUTATION_QUERY_LIMIT;

    // Collect matching entries from all buckets, sort descending by timestamp
    const matched = [...store.values()]
      .flatMap((bucket) => bucket.filter((entry) => matchesFilter(entry, filter)))
      .toSorted((a, b) => b.timestamp - a.timestamp);

    // Apply limit + hasMore
    const hasMore = matched.length > limit;
    const entries = matched.slice(0, limit);

    return { ok: true, value: { entries, hasMore } satisfies ReputationQueryResult };
  };

  const dispose: ReputationBackend["dispose"] = () => {
    disposed = true;
    store.clear();
  };

  return { record, getScore, getScores, query, dispose };
}
