/**
 * Types for team memory sync.
 *
 * Establishes the safety boundary contract for cross-agent memory sharing.
 * Transport layer is deferred — only type filtering and secret scanning are implemented.
 */

import type { MemoryRecord, MemoryType } from "@koi/core";

/** Configuration for team memory sync. */
export interface TeamSyncConfig {
  /** Lists all local memory records. */
  readonly listMemories: () => Promise<readonly MemoryRecord[]>;
  /** Remote endpoint for sync. undefined = sync disabled. */
  readonly remoteEndpoint?: string | undefined;
  /**
   * Memory types allowed to leave the local store.
   * Default: ["feedback", "project", "reference"] — "user" is always excluded.
   */
  readonly allowedTypes?: readonly MemoryType[] | undefined;
  /** Agent ID for sync attribution. */
  readonly agentId: string;
  /** Team ID for group scoping. */
  readonly teamId?: string | undefined;
}

/** A memory that was blocked from sync. */
export interface SyncBlockedEntry {
  /** ID of the blocked memory. */
  readonly memoryId: string;
  /** Reason it was blocked. */
  readonly reason: "type_denied" | "secret_detected" | "scan_error";
  /** Detail string (e.g., secret kind or error message). */
  readonly detail?: string | undefined;
}

/** Result of a team sync operation. */
export interface TeamSyncResult {
  /** Number of memories that passed filters and would be pushed. */
  readonly eligible: number;
  /** Number of memories blocked from sync. */
  readonly blocked: number;
  /** Details of each blocked entry. */
  readonly blockedEntries: readonly SyncBlockedEntry[];
  /** Errors from the transport layer. */
  readonly errors: readonly string[];
  /** Whether sync was skipped (no remote endpoint). */
  readonly skipped: boolean;
}

/**
 * Default allowed types for team sync.
 * "user" is always excluded — it contains private role/preference information.
 */
export const DEFAULT_ALLOWED_TYPES: readonly MemoryType[] = ["feedback", "project", "reference"];
