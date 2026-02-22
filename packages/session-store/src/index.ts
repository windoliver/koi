/**
 * @koi/session-store — Durable session persistence for crash recovery.
 *
 * L2 package. Depends only on @koi/core.
 */

// Re-export L0 types + contract for backward compatibility
export type {
  PendingFrame,
  RecoveryPlan,
  SessionCheckpoint,
  SessionFilter,
  SessionPersistence,
  SessionRecord,
  SkippedRecoveryEntry,
} from "@koi/core";
export type { InMemorySessionStoreConfig } from "./memory-store.js";
export { createInMemorySessionPersistence } from "./memory-store.js";
export { createSqliteSessionPersistence } from "./sqlite-store.js";
export type { SessionStoreConfig } from "./types.js";
