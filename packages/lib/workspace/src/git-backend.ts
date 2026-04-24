import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
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

interface WorkspaceMarker {
  readonly id?: string;
  readonly branchName?: string;
  readonly agentId?: string;
}

export function createGitWorktreeBackend(config: GitWorktreeBackendConfig): WorkspaceBackend {
  const registry = new Map<WorkspaceId, RegistryEntry>();
  const basePath = resolveWorktreeBasePath(config.repoPath, config.worktreeBasePath);

  const resolvedRepo = resolve(config.repoPath);
  const resolvedBase = resolve(basePath);
  if (resolvedBase === resolvedRepo || resolvedBase.startsWith(resolvedRepo + sep)) {
    throw new Error(
      `worktreeBasePath must not be inside the repository: ${resolvedBase} is under ${resolvedRepo}`,
    );
  }

  // Scan git worktree list and on-disk markers to recover an entry that
  // survived a process restart and is no longer in the in-memory registry.
  async function recoverEntry(wsId: WorkspaceId): Promise<RegistryEntry | null> {
    const listResult = await runGit(["worktree", "list", "--porcelain"], config.repoPath);
    if (!listResult.ok) return null;

    const blocks = listResult.value.split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.trim().split("\n");
      const pathLine = lines.find((l) => l.startsWith("worktree "));
      if (!pathLine) continue;
      const path = pathLine.slice("worktree ".length).trim();
      try {
        const markerText = await Bun.file(join(path, ".koi-workspace")).text();
        const marker = JSON.parse(markerText) as WorkspaceMarker;
        if (marker.id === wsId && typeof marker.branchName === "string") {
          return { path, branchName: marker.branchName };
        }
      } catch {
        // Marker missing or unreadable — skip this worktree
      }
    }
    return null;
  }

  return {
    name: "git-worktree",
    isSandboxed: false,

    async create(
      agentId: AgentId,
      _cfg: ResolvedWorkspaceConfig,
    ): Promise<Result<WorkspaceInfo, KoiError>> {
      const id = workspaceId(`ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      // Sanitize agentId for use in a git ref: replace non-alphanumeric chars, collapse runs of dashes
      const safeAgentSlug = (agentId as string)
        .replace(/[^a-zA-Z0-9_]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      const branchName = `workspace/${safeAgentSlug}/${id}`;
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
      let entry = registry.get(wsId);
      if (!entry) {
        // Registry is in-memory only — attempt crash recovery via on-disk marker
        const recovered = await recoverEntry(wsId);
        if (!recovered) {
          return {
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: `Workspace ${wsId} not found in registry or on disk`,
              retryable: false,
            },
          };
        }
        entry = recovered;
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

    async findByAgentId(searchAgentId: AgentId): Promise<WorkspaceId | undefined> {
      const listResult = await runGit(["worktree", "list", "--porcelain"], config.repoPath);
      if (!listResult.ok) return undefined;

      const blocks = listResult.value.split(/\n\n+/);
      for (const block of blocks) {
        const lines = block.trim().split("\n");
        const pathLine = lines.find((l) => l.startsWith("worktree "));
        if (!pathLine) continue;
        const path = pathLine.slice("worktree ".length).trim();
        try {
          const markerText = await Bun.file(join(path, ".koi-workspace")).text();
          const marker = JSON.parse(markerText) as WorkspaceMarker;
          if (marker.agentId === (searchAgentId as string) && typeof marker.id === "string") {
            return workspaceId(marker.id);
          }
        } catch {
          // Marker missing or unreadable — skip
        }
      }
      return undefined;
    },
  };
}
