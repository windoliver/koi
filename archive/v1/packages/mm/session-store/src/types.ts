/**
 * Session persistence types for crash recovery on edge devices.
 *
 * Core types (SessionRecord, PendingFrame, RecoveryPlan, SessionFilter,
 * SkippedRecoveryEntry) are defined in @koi/core (L0) and re-exported here
 * for backward compatibility.
 *
 * Implementation-specific config (SessionStoreConfig) stays in this L2 package.
 */

// Re-export L0 types for backward compatibility
export type {
  PendingFrame,
  RecoveryPlan,
  SessionFilter,
  SessionRecord,
  SkippedRecoveryEntry,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Config (L2 — implementation-specific)
// ---------------------------------------------------------------------------

export interface SessionStoreConfig {
  /** Database file path, or ":memory:" for in-memory. */
  readonly dbPath: string;
  /**
   * Durability level:
   * - "process": durable against process crashes (SQLite WAL + synchronous=NORMAL)
   * - "os": durable against OS/power crashes (SQLite WAL + synchronous=FULL)
   * Default: "process"
   */
  readonly durability?: "process" | "os";
}
