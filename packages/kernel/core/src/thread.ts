/**
 * Thread types — unified execution model with persistent threads and checkpoints.
 *
 * Combines single-shot `koi.run()`, multi-session harness, and harness-scheduler
 * into one thread primitive. A thread is a persistent, resumable conversation
 * with checkpoint support and an inbox queue for message steering.
 *
 * Exception: branded type constructors (threadId, threadMessageId) are permitted
 * in L0 as zero-logic identity casts for type safety.
 * Exception: DEFAULT_CHECKPOINT_POLICY and DEFAULT_THREAD_PRUNING_POLICY are pure
 * readonly data constants derived from L0 type definitions.
 * Exception: isMessageSnapshot and isHarnessSnapshot are pure type guards operating
 * only on L0 types.
 */

import type { AgentId, SessionId } from "./ecs.js";
import type { KoiError, Result } from "./errors.js";
import type { SnapshotChainStore } from "./snapshot-chain.js";
import type { TaskBoardSnapshot } from "./task-board.js";

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

declare const __threadIdBrand: unique symbol;

/** Branded string type for thread identifiers. */
export type ThreadId = string & { readonly [__threadIdBrand]: "ThreadId" };

/** Create a branded ThreadId from a plain string. */
export function threadId(raw: string): ThreadId {
  return raw as ThreadId;
}

declare const __threadMessageIdBrand: unique symbol;

/** Branded string type for thread message identifiers. Used as idempotency key (Decision 6A). */
export type ThreadMessageId = string & {
  readonly [__threadMessageIdBrand]: "ThreadMessageId";
};

/** Create a branded ThreadMessageId from a plain string. */
export function threadMessageId(raw: string): ThreadMessageId {
  return raw as ThreadMessageId;
}

// ---------------------------------------------------------------------------
// Thread message
// ---------------------------------------------------------------------------

/** Allowed roles for thread messages. */
export type ThreadMessageRole = "user" | "assistant" | "system" | "tool";

/**
 * A single message within a thread.
 * `id` serves as the idempotency key (Decision 6A) — duplicate IDs are
 * rejected by the ThreadStore to prevent double-appends.
 */
export interface ThreadMessage {
  readonly id: ThreadMessageId;
  readonly role: ThreadMessageRole;
  readonly content: string;
  readonly createdAt: number;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

// ---------------------------------------------------------------------------
// Context summary reference (lightweight pointer into context summaries)
// ---------------------------------------------------------------------------

/** Lightweight reference to a per-session context summary for thread snapshots. */
export interface ContextSummaryRef {
  readonly sessionSeq: number;
  readonly estimatedTokens: number;
  readonly generatedAt: number;
}

// ---------------------------------------------------------------------------
// Thread metrics
// ---------------------------------------------------------------------------

/** Accumulated metrics across all sessions within a thread. */
export interface ThreadMetrics {
  readonly totalMessages: number;
  readonly totalTurns: number;
  readonly totalTokens: number;
  readonly lastActivityAt: number;
}

// ---------------------------------------------------------------------------
// Thread snapshot — discriminated union (Decision 8C)
// ---------------------------------------------------------------------------

/**
 * A message-type snapshot capturing conversation history within a thread.
 * Used for standard chat-style interactions.
 */
export interface MessageThreadSnapshot {
  readonly kind: "message";
  readonly threadId: ThreadId;
  readonly agentId: AgentId;
  readonly sessionId?: SessionId | undefined;
  readonly messages: readonly ThreadMessage[];
  readonly turnIndex: number;
  readonly createdAt: number;
}

/**
 * A harness-type snapshot capturing autonomous task execution state.
 * Used for long-running, multi-session agent workflows.
 */
export interface HarnessThreadSnapshot {
  readonly kind: "harness";
  readonly threadId: ThreadId;
  readonly agentId: AgentId;
  readonly sessionId?: SessionId | undefined;
  readonly taskBoard: TaskBoardSnapshot;
  readonly summaries: readonly ContextSummaryRef[];
  readonly metrics: ThreadMetrics;
  readonly createdAt: number;
}

/**
 * Discriminated union of thread snapshot types (Decision 8C).
 * Both message-style and harness-style snapshots coexist in the same chain,
 * enabling unified persistence for chat and autonomous workflows.
 */
export type ThreadSnapshot = MessageThreadSnapshot | HarnessThreadSnapshot;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Type guard for message-kind thread snapshots. */
export function isMessageSnapshot(snapshot: ThreadSnapshot): snapshot is MessageThreadSnapshot {
  return snapshot.kind === "message";
}

/** Type guard for harness-kind thread snapshots. */
export function isHarnessSnapshot(snapshot: ThreadSnapshot): snapshot is HarnessThreadSnapshot {
  return snapshot.kind === "harness";
}

// ---------------------------------------------------------------------------
// Checkpoint policy (Decision 15B)
// ---------------------------------------------------------------------------

/**
 * Configurable checkpoint frequency and triggers.
 * Controls when the ThreadStore persists snapshots during execution.
 */
export interface CheckpointPolicy {
  /** Fire a checkpoint every N turns. Default: 5. */
  readonly intervalTurns: number;
  /** Fire a checkpoint when a session ends cleanly. Default: true. */
  readonly onSessionEnd: boolean;
  /** Fire a checkpoint when the agent suspends. Default: true. */
  readonly onSuspend: boolean;
}

/** Sensible defaults for checkpoint policy. */
export const DEFAULT_CHECKPOINT_POLICY: CheckpointPolicy = Object.freeze({
  intervalTurns: 5,
  onSessionEnd: true,
  onSuspend: true,
});

// ---------------------------------------------------------------------------
// Thread pruning policy (Decision 13A)
// ---------------------------------------------------------------------------

/**
 * Controls how old thread snapshots are pruned to bound storage growth.
 * Keeps the last N message snapshots and optionally compacts older ones
 * into context summaries.
 */
export interface ThreadPruningPolicy {
  /** Number of recent message snapshots to retain. Default: 50. */
  readonly retainMessageSnapshots: number;
  /** Whether to compact older snapshots into summaries. Default: true. */
  readonly compactOlder: boolean;
}

/** Sensible defaults for thread pruning. */
export const DEFAULT_THREAD_PRUNING_POLICY: ThreadPruningPolicy = Object.freeze({
  retainMessageSnapshots: 50,
  compactOlder: true,
});

// ---------------------------------------------------------------------------
// ThreadStore facade (Decision 1C)
// ---------------------------------------------------------------------------

/**
 * Type alias for the underlying snapshot chain specialized for ThreadSnapshot.
 * ThreadStore delegates persistence to this store.
 */
export type ThreadSnapshotStore = SnapshotChainStore<ThreadSnapshot>;

/**
 * High-level thread persistence API (Decision 1C).
 *
 * A thin facade over `SnapshotChainStore<ThreadSnapshot>` that provides
 * idempotent append-and-checkpoint, thread loading, and message listing.
 *
 * All fallible operations return `Result<T, KoiError> | Promise<Result<T, KoiError>>`
 * so implementations can be sync (in-memory) or async (SQLite/network).
 */
export interface ThreadStore {
  /**
   * Atomically append messages and persist a snapshot checkpoint.
   * Duplicate message IDs (idempotency key) produce a CONFLICT error.
   */
  readonly appendAndCheckpoint: (
    threadId: ThreadId,
    messages: readonly ThreadMessage[],
    snapshot: ThreadSnapshot,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  /**
   * Load the latest snapshot for a thread.
   * Returns undefined if the thread does not exist.
   */
  readonly loadThread: (
    threadId: ThreadId,
  ) =>
    | Result<ThreadSnapshot | undefined, KoiError>
    | Promise<Result<ThreadSnapshot | undefined, KoiError>>;

  /**
   * List messages for a thread, ordered by createdAt ascending.
   * Optional limit caps the number of messages returned (newest first before limiting).
   */
  readonly listMessages: (
    threadId: ThreadId,
    limit?: number,
  ) =>
    | Result<readonly ThreadMessage[], KoiError>
    | Promise<Result<readonly ThreadMessage[], KoiError>>;

  /** Close the store and release resources. Idempotent. */
  readonly close: () => void | Promise<void>;
}
