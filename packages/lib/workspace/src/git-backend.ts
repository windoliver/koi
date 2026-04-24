import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

export interface GitWorktreeBackendConfig {
  readonly repoPath: string;
  readonly worktreeBasePath?: string;
}

interface RegistryEntry {
  readonly path: string;
  readonly branchName: string;
}

export function createGitWorktreeBackend(config: GitWorktreeBackendConfig): WorkspaceBackend {
  const registry = new Map<WorkspaceId, RegistryEntry>();
  const basePath = resolveWorktreeBasePath(config.repoPath, config.worktreeBasePath);

  return {
    name: "git-worktree",
    isSandboxed: false,

    async create(
      agentId: AgentId,
      _cfg: ResolvedWorkspaceConfig,
    ): Promise<Result<WorkspaceInfo, KoiError>> {
      const id = workspaceId(`ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const branchName = `workspace/${agentId}/${id}`;
      const path = join(basePath, id);

      await mkdir(basePath, { recursive: true });

      const addResult = await runGit(["worktree", "add", "-b", branchName, path], config.repoPath);
      if (!addResult.ok) return addResult;

      // Register before the marker write so we can dispose on failure
      registry.set(id, { path, branchName });

      const marker = JSON.stringify({
        id,
        agentId,
        createdAt: Date.now(),
        pid: process.pid,
        branchName,
        repoPath: config.repoPath,
      });

      try {
        await writeFile(join(path, ".koi-workspace"), marker, "utf8");
      } catch (e: unknown) {
        // Marker write failed — best-effort cleanup to avoid orphaned worktree/branch
        registry.delete(id);
        await runGit(["worktree", "remove", "--force", path], config.repoPath);
        await runGit(["branch", "-D", branchName], config.repoPath);
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: `Failed to write workspace marker: ${e instanceof Error ? e.message : String(e)}`,
            retryable: false,
            cause: e,
          },
        };
      }

      const info: WorkspaceInfo = {
        id,
        path,
        createdAt: Date.now(),
        metadata: { branchName, repoPath: config.repoPath },
      };

      return { ok: true, value: info };
    },

    async dispose(wsId: WorkspaceId): Promise<Result<void, KoiError>> {
      const entry = registry.get(wsId);
      if (!entry) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Workspace ${wsId} not found in registry`,
            retryable: false,
          },
        };
      }

      const removeResult = await runGit(
        ["worktree", "remove", "--force", entry.path],
        config.repoPath,
      );
      if (!removeResult.ok) return removeResult;

      // Branch deletion is best-effort — failure doesn't fail dispose
      await runGit(["branch", "-D", entry.branchName], config.repoPath);

      registry.delete(wsId);
      return { ok: true, value: undefined };
    },

    isHealthy(wsId: WorkspaceId): boolean {
      return registry.has(wsId);
    },
  };
}
