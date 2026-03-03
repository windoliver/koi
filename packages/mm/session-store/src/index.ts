/**
 * @koi/session-store — Durable session persistence for crash recovery.
 *
 * L2 package. Depends only on @koi/core.
 */

// Re-export L0 types + contract for backward compatibility
export type {
  PendingFrame,
  RecoveryPlan,
  SessionFilter,
  SessionPersistence,
  SessionRecord,
  SkippedRecoveryEntry,
} from "@koi/core";
export { createInMemorySessionPersistence } from "./memory-store.js";
export { createSqliteSessionPersistence } from "./sqlite-store.js";
export type { SessionStoreConfig } from "./types.js";
