/**
 * Domain types for tool audit middleware.
 */

import type { KoiMiddleware } from "@koi/core/middleware";

/**
 * External persistence interface — snapshot-based load/save with optional
 * compare-and-swap (CAS) write for multi-writer correctness.
 *
 * Concurrency contract (#review-round28-F1): plain `save` is
 * last-writer-wins and is safe only under single-writer usage. For
 * multi-writer deployments (multiple processes / hosts sharing the
 * audit store), provide `saveIfVersion` — a conditional write that
 * commits only if the persisted snapshot still has the expected
 * version, returning `{ ok: false, current }` on conflict so the
 * middleware can re-merge against the newer baseline and retry.
 * `version` on the loaded snapshot lets the middleware track the
 * baseline it merged against; bump it on every successful write. The
 * middleware uses `saveIfVersion` when present and falls back to
 * `save` otherwise.
 */
export interface ToolAuditStore {
  readonly load: () => ToolAuditSnapshot | Promise<ToolAuditSnapshot>;
  readonly save: (snapshot: ToolAuditSnapshot) => void | Promise<void>;
  readonly saveIfVersion?: (
    snapshot: ToolAuditSnapshot,
    expectedVersion: number,
  ) =>
    | { readonly ok: true }
    | { readonly ok: false; readonly current: ToolAuditSnapshot }
    | Promise<{ readonly ok: true } | { readonly ok: false; readonly current: ToolAuditSnapshot }>;
}

/** Serializable audit state — safe to persist to disk/DB. */
export interface ToolAuditSnapshot {
  readonly tools: Readonly<Record<string, ToolUsageRecord>>;
  readonly totalSessions: number;
  readonly lastUpdatedAt: number;
  /**
   * Optional monotonic version for CAS writes via `saveIfVersion`.
   * Undefined for stores that don't implement versioned writes; the
   * middleware treats that as single-writer mode.
   */
  readonly version?: number;
}

/** Per-tool cumulative usage statistics. */
export interface ToolUsageRecord {
  readonly toolName: string;
  readonly callCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly lastUsedAt: number;
  readonly avgLatencyMs: number;
  readonly minLatencyMs: number;
  readonly maxLatencyMs: number;
  /** Internal: running total for incremental average computation. */
  readonly totalLatencyMs: number;
  readonly sessionsAvailable: number;
  readonly sessionsUsed: number;
}

/** Lifecycle signal kinds — 4 per-tool signals. */
export type ToolLifecycleSignal = "unused" | "low_adoption" | "high_failure" | "high_value";

/** Per-tool analysis output with signal, confidence, and human-readable explanation. */
export interface ToolAuditResult {
  readonly toolName: string;
  readonly signal: ToolLifecycleSignal;
  readonly confidence: number;
  readonly details: string;
  readonly record: ToolUsageRecord;
}

/** Extended middleware interface — adds on-demand report/snapshot methods. */
export interface ToolAuditMiddleware extends KoiMiddleware {
  readonly generateReport: () => readonly ToolAuditResult[];
  readonly getSnapshot: () => ToolAuditSnapshot;
}
