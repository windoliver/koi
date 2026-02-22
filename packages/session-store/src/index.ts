/**
 * @koi/session-store — Durable session persistence for crash recovery.
 *
 * L2 package. Depends only on @koi/core.
 */

export type { InMemorySessionStoreConfig } from "./memory-store.js";
export { createInMemorySessionPersistence } from "./memory-store.js";
export type { SessionPersistence } from "./persistence.js";
export { createSqliteSessionPersistence } from "./sqlite-store.js";
export type {
  PendingFrame,
  RecoveryPlan,
  SessionCheckpoint,
  SessionFilter,
  SessionRecord,
  SessionStoreConfig,
} from "./types.js";
