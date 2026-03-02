/**
 * @koi/workspace — Backend-agnostic workspace isolation for agents.
 *
 * Provides a ComponentProvider that attaches isolated workspaces to agents
 * via a pluggable WorkspaceBackend strategy (git worktrees, temp dirs, etc.).
 */

// Contract types re-exported from @koi/core for backward compat
export type {
  CleanupPolicy,
  ResolvedWorkspaceConfig,
  WorkspaceBackend,
  WorkspaceId,
  WorkspaceInfo,
} from "@koi/core";
export { DEFAULT_CLEANUP_POLICY, DEFAULT_CLEANUP_TIMEOUT_MS, workspaceId } from "@koi/core";
export type { ContainerScope, DockerWorkspaceBackendConfig, MountMode } from "./docker-backend.js";
export { createDockerWorkspaceBackend, createFilesystemPolicy } from "./docker-backend.js";
export type { GitWorktreeBackendConfig } from "./git-backend.js";
export { createGitWorktreeBackend } from "./git-backend.js";
export { createWorkspaceProvider } from "./provider.js";
export type { PruneOptions, PruneResult } from "./prune.js";
export { pruneStaleWorkspaces } from "./prune.js";
export { createShellSetup } from "./shell-setup.js";
// Provider-specific types (not in L0)
export type { WorkspaceProviderConfig } from "./types.js";
export type { ValidatedWorkspaceConfig } from "./validate-config.js";
export { validateWorkspaceConfig } from "./validate-config.js";
