/**
 * @koi/git-utils — Shared git CLI wrapper for workspace-related packages.
 *
 * Provides typed wrappers around Bun.spawn for running git commands and
 * resolving worktree paths.
 */

export { resolveWorktreeBasePath } from "./paths.js";
export { parseGitError, runGit } from "./run-git.js";
