/**
 * Workspace isolation contract types.
 *
 * Defines the WorkspaceBackend strategy interface, configuration types,
 * and branded WorkspaceId type for backend-agnostic workspace management.
 *
 * Moved from @koi/workspace to @koi/core (L0) to enable multiple L2
 * workspace backend implementations without peer-L2 imports.
 */

import type { AgentId } from "./ecs.js";
import type { KoiError, Result } from "./errors.js";

// ---------------------------------------------------------------------------
// Branded type
// ---------------------------------------------------------------------------

declare const __workspaceBrand: unique symbol;

/** Branded string type for workspace identifiers. */
export type WorkspaceId = string & { readonly [__workspaceBrand]: "WorkspaceId" };

/** Create a branded WorkspaceId from a plain string. */
export function workspaceId(id: string): WorkspaceId {
  return id as WorkspaceId;
}

// ---------------------------------------------------------------------------
// Cleanup policy
// ---------------------------------------------------------------------------

/** Cleanup policy for workspaces when detaching from an agent. */
export type CleanupPolicy = "always" | "on_success" | "never";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Validated configuration with defaults applied. */
export interface ResolvedWorkspaceConfig {
  readonly cleanupPolicy: CleanupPolicy;
  readonly cleanupTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// Backend strategy
// ---------------------------------------------------------------------------

/** Information about a created workspace, returned by backends. */
export interface WorkspaceInfo {
  readonly id: WorkspaceId;
  readonly path: string;
  readonly createdAt: number;
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * Strategy interface for workspace isolation backends.
 *
 * Implementations include git worktrees, temp directories, containers,
 * Nexus-backed remote workspaces, etc.
 * All methods return Result to signal expected failures without throwing.
 */
export interface WorkspaceBackend {
  readonly name: string;
  /** Whether this backend provides OS-level container isolation. */
  readonly isSandboxed: boolean;
  readonly create: (
    agentId: AgentId,
    config: ResolvedWorkspaceConfig,
  ) => Promise<Result<WorkspaceInfo, KoiError>>;
  readonly dispose: (workspaceId: WorkspaceId) => Promise<Result<void, KoiError>>;
  readonly isHealthy: (workspaceId: WorkspaceId) => boolean | Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CLEANUP_POLICY: CleanupPolicy = "on_success";
export const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
