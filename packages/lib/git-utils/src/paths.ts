/**
 * Path resolution utilities for git worktrees.
 */

/** Resolve the base path for worktrees relative to the repo. */
export function resolveWorktreeBasePath(repoPath: string, explicit?: string): string {
  if (explicit) return explicit;
  const repoName = repoPath.split("/").pop() || "repo";
  return `${repoPath}/../${repoName}-workspaces`;
}
