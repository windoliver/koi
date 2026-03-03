/**
 * Domain types for tool audit middleware.
 */

import type { KoiMiddleware } from "@koi/core/middleware";

/**
 * External persistence interface — snapshot-based load/save.
 * In-memory fallback used when no store is provided.
 */
export interface ToolAuditStore {
  readonly load: () => ToolAuditSnapshot | Promise<ToolAuditSnapshot>;
  readonly save: (snapshot: ToolAuditSnapshot) => void | Promise<void>;
}

/** Serializable audit state — safe to persist to disk/DB. */
export interface ToolAuditSnapshot {
  readonly tools: Readonly<Record<string, ToolUsageRecord>>;
  readonly totalSessions: number;
  readonly lastUpdatedAt: number;
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

/** Lifecycle signal kinds — 4 per-tool signals (redundancy deferred to v2). */
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
