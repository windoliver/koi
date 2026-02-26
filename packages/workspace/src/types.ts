/**
 * Workspace isolation types.
 *
 * Defines the WorkspaceBackend strategy interface and configuration
 * types for backend-agnostic workspace management.
 */

import type { AgentId, KoiError, Result } from "@koi/core";

// ---------------------------------------------------------------------------
// Backend strategy
// ---------------------------------------------------------------------------

/** Information about a created workspace, returned by backends. */
export interface WorkspaceInfo {
  readonly id: string;
  readonly path: string;
  readonly createdAt: number;
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * Strategy interface for workspace isolation backends.
 *
 * Implementations include git worktrees, temp directories, containers, etc.
 * All methods return Result to signal expected failures without throwing.
 */
export interface WorkspaceBackend {
  readonly name: string;
  readonly create: (
    agentId: AgentId,
    config: ResolvedWorkspaceConfig,
  ) => Promise<Result<WorkspaceInfo, KoiError>>;
  readonly dispose: (workspaceId: string) => Promise<Result<void, KoiError>>;
  readonly isHealthy: (workspaceId: string) => boolean | Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Cleanup policy for workspaces when detaching from an agent. */
export type CleanupPolicy = "always" | "on_success" | "never";

/** User-facing configuration for the workspace provider. */
export interface WorkspaceProviderConfig {
  readonly backend: WorkspaceBackend;
  readonly cleanupPolicy?: "always" | "on_success" | "never";
  readonly postCreate?: (workspace: WorkspaceInfo) => Promise<void>;
  readonly cleanupTimeoutMs?: number;
}

/** Validated configuration with defaults applied. */
export interface ResolvedWorkspaceConfig {
  readonly cleanupPolicy: CleanupPolicy;
  readonly cleanupTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CLEANUP_POLICY: CleanupPolicy = "on_success";
export const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
