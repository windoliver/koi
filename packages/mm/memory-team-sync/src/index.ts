/**
 * @koi/memory-team-sync — Team memory sync with safety boundaries.
 *
 * Type filtering, secret scanning via @koi/redaction, and fail-closed sync stub.
 * Actual transport deferred until storage and secret-scanning boundaries are explicit.
 */

export type { FilterResult } from "./filter.js";

// Filtering
export { filterMemoriesForSync, filterMemoryForSync } from "./filter.js";
// Sync
export { syncTeamMemories } from "./sync.js";

// Types
export type {
  SyncBlockedEntry,
  TeamSyncConfig,
  TeamSyncResult,
} from "./types.js";
export { DEFAULT_ALLOWED_TYPES } from "./types.js";
