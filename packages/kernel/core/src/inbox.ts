/**
 * Inbox types — message steering queue for autonomous agents (Decision 3C).
 *
 * The inbox sits between the mailbox (agent-to-agent messaging) and the engine,
 * routing incoming messages by mode: collect (batch for next turn), followup
 * (queue for future turns), or steer (inject immediately via EngineAdapter).
 *
 * Exception: DEFAULT_INBOX_POLICY is a pure readonly data constant derived
 * from L0 type definitions.
 */

import type { AgentId } from "./ecs.js";

// ---------------------------------------------------------------------------
// Inbox mode
// ---------------------------------------------------------------------------

/**
 * How an inbox item should be processed (Decision 3C):
 * - `collect`: batch into next turn's context (cap: 20)
 * - `followup`: queue for future turns (cap: 50)
 * - `steer`: inject immediately via `EngineAdapter.inject?()` (cap: 1)
 */
export type InboxMode = "collect" | "followup" | "steer";

// ---------------------------------------------------------------------------
// Per-mode capacity policy (Decision 14B)
// ---------------------------------------------------------------------------

/** Per-mode capacity limits to bound inbox memory growth. */
export interface InboxPolicy {
  /** Maximum items in collect mode. Default: 20. */
  readonly collectCap: number;
  /** Maximum items in followup mode. Default: 50. */
  readonly followupCap: number;
  /** Maximum items in steer mode. Default: 1. */
  readonly steerCap: number;
}

/** Sensible defaults for inbox capacity (Decision 14B). */
export const DEFAULT_INBOX_POLICY: InboxPolicy = Object.freeze({
  collectCap: 20,
  followupCap: 50,
  steerCap: 1,
});

// ---------------------------------------------------------------------------
// Inbox item
// ---------------------------------------------------------------------------

/** A single item queued in the inbox for processing at the next turn boundary. */
export interface InboxItem {
  readonly id: string;
  readonly from: AgentId;
  readonly mode: InboxMode;
  readonly content: string;
  readonly priority: number;
  readonly createdAt: number;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

// ---------------------------------------------------------------------------
// InboxComponent (ECS component)
// ---------------------------------------------------------------------------

/**
 * ECS component providing inbox queue operations.
 * Attached to agents via the INBOX SubsystemToken.
 *
 * Operations are synchronous (in-memory FIFO queue per mode).
 * The engine drains the inbox at turn boundaries.
 */
export interface InboxComponent {
  /**
   * Drain all queued items, clearing the inbox.
   * Returns items in insertion order.
   */
  readonly drain: () => readonly InboxItem[];

  /**
   * Non-destructive peek at all queued items.
   * Returns items in insertion order without removing them.
   */
  readonly peek: () => readonly InboxItem[];

  /** Current number of items across all modes. */
  readonly depth: () => number;

  /**
   * Push an item into the inbox.
   * Returns `true` if accepted, `false` if the per-mode capacity is exceeded.
   */
  readonly push: (item: InboxItem) => boolean;
}
