/**
 * Git worktree backend for workspace isolation.
 *
 * Creates isolated git worktrees per agent, with marker files
 * for orphan detection and cleanup.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AgentId,
  KoiError,
  ResolvedWorkspaceConfig,
  Result,
  WorkspaceBackend,
  WorkspaceId,
  WorkspaceInfo,
} from "@koi/core";
import { workspaceId } from "@koi/core";
import { resolveWorktreeBasePath, runGit } from "@koi/git-utils";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Configuration for the git worktree backend. */
export interface GitWorktreeBackendConfig {
  readonly repoPath: string;
  readonly baseBranch?: string;
  readonly branchPattern?: string;
  readonly worktreeBasePath?: string;
}

const DEFAULT_BASE_BRANCH = "main";
// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional pattern for string replacement
const DEFAULT_BRANCH_PATTERN = "workspace/${agentId}";
const MARKER_FILENAME = ".koi-workspace";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a git worktree WorkspaceBackend.
 *
 * Validates that repoPath exists and is a git repository.
 * Returns Result.error if validation fails.
 */
export function createGitWorktreeBackend(
  config: GitWorktreeBackendConfig,
): Result<WorkspaceBackend, KoiError> {
  if (!existsSync(config.repoPath)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `repoPath does not exist: ${config.repoPath}`,
        retryable: false,
      },
    };
  }

  if (!existsSync(`${config.repoPath}/.git`)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `repoPath is not a git repository: ${config.repoPath}`,
        retryable: false,
      },
    };
  }

  const repoPath = resolve(config.repoPath);
  const baseBranch = config.baseBranch ?? DEFAULT_BASE_BRANCH;
  const branchPattern = config.branchPattern ?? DEFAULT_BRANCH_PATTERN;
  const worktreeBase = resolve(resolveWorktreeBasePath(repoPath, config.worktreeBasePath));

  // Mutable Map justified: internal tracking state encapsulated in closure,
  // not exposed to callers. Maps workspace ID → worktree metadata for dispose/isHealthy.
  const tracked = new Map<string, { readonly worktreePath: string; readonly branchName: string }>();

  const backend: WorkspaceBackend = {
    name: "git-worktree",
    isSandboxed: false,

    create: async (
      agentId: AgentId,
      _config: ResolvedWorkspaceConfig,
    ): Promise<Result<WorkspaceInfo, KoiError>> => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional pattern for string replacement
      const branchName = branchPattern.replace("${agentId}", agentId);
      const worktreePath = resolve(worktreeBase, branchName.replace(/\//g, "-"));

      // Defense-in-depth: verify resolved path stays under worktreeBase
      if (!worktreePath.startsWith(worktreeBase)) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `Resolved worktree path escapes base directory: ${worktreePath}`,
            retryable: false,
          },
        };
      }

      // Ensure base directory exists
      await mkdir(worktreeBase, { recursive: true });

      const addResult = await runGit(
        ["worktree", "add", worktreePath, "-b", branchName, baseBranch],
        repoPath,
      );

      if (!addResult.ok) return addResult;

      const createdAt = Date.now();
      const id = workspaceId(`git-wt-${agentId}-${createdAt}`);

      // Write marker file for orphan detection
      const marker = JSON.stringify({
        id,
        agentId,
        createdAt,
        pid: process.pid,
        branchName,
        repoPath,
      });
      await writeFile(`${worktreePath}/${MARKER_FILENAME}`, marker, "utf-8");

      tracked.set(id, { worktreePath, branchName });

      return {
        ok: true,
        value: {
          id,
          path: worktreePath,
          createdAt,
          metadata: {
            branchName,
            baseBranch,
            repoPath,
          },
        },
      };
    },

    dispose: async (wsId: WorkspaceId): Promise<Result<void, KoiError>> => {
      const entry = tracked.get(wsId);
      if (!entry) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Unknown workspace ID: ${wsId}`,
            retryable: false,
          },
        };
      }

      // Remove worktree (try force first, then non-force)
      const removeResult = await runGit(
        ["worktree", "remove", "--force", entry.worktreePath],
        repoPath,
      );

      if (!removeResult.ok) {
        const fallback = await runGit(["worktree", "remove", entry.worktreePath], repoPath);
        if (!fallback.ok) return fallback;
      }

      // Worktree removed — safe to drop tracking entry.
      // If branch deletion below fails, we still consider the workspace disposed
      // (branch cleanup is non-fatal).
      tracked.delete(wsId);

      // Delete the branch
      const branchResult = await runGit(["branch", "-D", entry.branchName], repoPath);

      if (!branchResult.ok) {
        // Branch deletion failure is non-fatal — warn but succeed
        console.warn(
          `[workspace] Failed to delete branch ${entry.branchName}: ${branchResult.error.message}`,
        );
      }

      return { ok: true, value: undefined };
    },

    isHealthy: (wsId: WorkspaceId): boolean => {
      const entry = tracked.get(wsId);
      if (!entry) return false;
      return (
        existsSync(entry.worktreePath) && existsSync(`${entry.worktreePath}/${MARKER_FILENAME}`)
      );
    },
  };

  return { ok: true, value: backend };
}
