/**
 * Workspace isolation types.
 *
 * Contract types (WorkspaceBackend, WorkspaceInfo, CleanupPolicy,
 * ResolvedWorkspaceConfig) have been promoted to @koi/core (L0).
 * This file retains provider-specific configuration types.
 */

import type { WorkspaceBackend, WorkspaceInfo } from "@koi/core";

// ---------------------------------------------------------------------------
// Provider configuration (L2-specific, not in L0)
// ---------------------------------------------------------------------------

/** User-facing configuration for the workspace provider. */
export interface WorkspaceProviderConfig {
  readonly backend: WorkspaceBackend;
  readonly cleanupPolicy?: "always" | "on_success" | "never";
  readonly postCreate?: (workspace: WorkspaceInfo) => Promise<void>;
  readonly pruneStale?: () => Promise<void>;
  readonly cleanupTimeoutMs?: number;
  /**
   * When `true`, validation rejects backends that are not container-based.
   * Default: `false`.
   */
  readonly requireSandbox?: boolean;
}
