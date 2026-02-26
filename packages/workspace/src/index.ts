/**
 * @koi/workspace — Backend-agnostic workspace isolation for agents.
 *
 * Provides a ComponentProvider that attaches isolated workspaces to agents
 * via a pluggable WorkspaceBackend strategy (git worktrees, temp dirs, etc.).
 */

export type { GitWorktreeBackendConfig } from "./git-backend.js";
export { createGitWorktreeBackend } from "./git-backend.js";
export { createWorkspaceProvider } from "./provider.js";
export type { PruneOptions, PruneResult } from "./prune.js";
export { pruneStaleWorkspaces } from "./prune.js";
export { createShellSetup } from "./shell-setup.js";
export type {
  CleanupPolicy,
  ResolvedWorkspaceConfig,
  WorkspaceBackend,
  WorkspaceInfo,
  WorkspaceProviderConfig,
} from "./types.js";
export { DEFAULT_CLEANUP_POLICY, DEFAULT_CLEANUP_TIMEOUT_MS } from "./types.js";
export type { ValidatedWorkspaceConfig } from "./validate-config.js";
export { validateWorkspaceConfig } from "./validate-config.js";
