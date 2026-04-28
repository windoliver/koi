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
  /**
   * Optional: scan for workspaces previously created for this agent (e.g. after process restart).
   * Returns all survivors sorted newest-first so callers can try them in order and fall back to
   * older candidates when the newest is unhealthy or setup-incomplete.
   * Empty array (or absent method) means no survivors found.
   */
  readonly findByAgentId?: (agentId: AgentId) => Promise<ReadonlyArray<WorkspaceInfo>>;
  /**
   * Optional: durably record that setup (postCreate) completed for this workspace.
   * Backends should use storage that workspace-process code cannot spoof (e.g. git refs).
   * If absent, callers fall back to a filesystem marker which may be writable by the agent process.
   */
  readonly attestSetupComplete?: (wsId: WorkspaceId) => Promise<void>;
  /**
   * Optional: verify that setup attestation exists for this workspace.
   * Pair with attestSetupComplete — if one is absent, both are absent.
   */
  readonly verifySetupComplete?: (wsId: WorkspaceId) => Promise<boolean>;
  /**
   * Optional: remove any existing setup attestation for this workspace.
   * Must be implemented alongside attestSetupComplete/verifySetupComplete.
   * Called before re-running postCreate on a crash survivor so that a mid-repair crash
   * leaves the workspace unattested (preventing stale "setup complete" resurrection).
   */
  readonly invalidateSetupComplete?: (wsId: WorkspaceId) => Promise<void>;
  /**
   * Optional: check whether a workspace resource still exists as a physical entity, independent
   * of whether it is healthy or in the expected state. Distinct from isHealthy — a workspace
   * can exist (worktree on disk, container present) while being unhealthy (branch drifted,
   * process crashed). Used as a post-disposal liveness oracle: if disposal fails, a backend
   * with exists() can confirm the resource is truly gone before the caller proceeds to create
   * a fresh workspace. When absent, callers fall back to isHealthy() which may produce false
   * negatives for unhealthy-but-present resources on unsandboxed backends.
   */
  readonly exists?: (wsId: WorkspaceId) => boolean | Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CLEANUP_POLICY: CleanupPolicy = "on_success";
export const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
