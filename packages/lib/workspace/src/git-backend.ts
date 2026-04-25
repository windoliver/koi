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

  // Scan git worktree list to recover an entry that survived a process restart.
  // Identity is derived exclusively from git-owned state (branch name suffix + path basename),
  // never from the writable marker file, so agent code cannot tamper recoverEntry into
  // deleting the wrong worktree.
  async function recoverEntry(wsId: WorkspaceId): Promise<RegistryEntry | null> {
    const listResult = await runGit(["worktree", "list", "--porcelain"], config.repoPath);
    if (!listResult.ok) return null;

    const blocks = listResult.value.split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.trim().split("\n");
      const pathLine = lines.find((l) => l.startsWith("worktree "));
      if (!pathLine) continue;
      const path = pathLine.slice("worktree ".length).trim();
      const branchRef =
        lines
          .find((l) => l.startsWith("branch "))
          ?.slice("branch ".length)
          .trim() ?? "";
      const branchName = branchRef.startsWith("refs/heads/")
        ? branchRef.slice("refs/heads/".length)
        : branchRef;
      if (!branchName) continue;
      // Derive wsId from git-owned branch suffix — branch format: workspace/<agent>/<wsId>
      const branchParts = branchName.split("/");
      const branchWsId = branchParts[branchParts.length - 1];
      // Require path basename to also match so a moved/renamed worktree is not mistakenly claimed
      const pathWsId = path.split(sep).pop();
      if (branchWsId !== wsId || pathWsId !== wsId) continue;
      return { path, branchName };
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
      // Hex-encode agentId for the branch name: reversible and collision-free, unlike
      // slug normalization which maps e.g. "a/b" and "a:b" to the same "a-b" slug.
      const agentIdHex = Buffer.from(agentId as string).toString("hex");
      const branchName = `workspace/${agentIdHex}/${id}`;
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

    async isHealthy(wsId: WorkspaceId): Promise<boolean> {
      const entry = registry.get(wsId);
      if (!entry) return false;
      // Validate via git-owned state: verify the path is still listed by git as a worktree.
      // A mere `.git` file check is spoofable by agent code; git worktree list is authoritative.
      const listResult = await runGit(["worktree", "list", "--porcelain"], config.repoPath);
      if (!listResult.ok) return false;
      for (const block of listResult.value.split(/\n\n+/)) {
        const pathLine = block
          .trim()
          .split("\n")
          .find((l) => l.startsWith("worktree "));
        if (pathLine && pathLine.slice("worktree ".length).trim() === entry.path) return true;
      }
      return false;
    },

    async findByAgentId(searchAgentId: AgentId): Promise<WorkspaceInfo | undefined> {
      // Derive ownership from the git-owned branch name.
      // New format: workspace/<hex(agentId)>/<wsId>  (current, reversible, collision-free)
      // Legacy format: workspace/<agentId>/<wsId>    (prior deployments where agentId was URL-safe)
      const searchHex = Buffer.from(searchAgentId as string).toString("hex");
      const searchRaw = searchAgentId as string;

      const listResult = await runGit(["worktree", "list", "--porcelain"], config.repoPath);
      if (!listResult.ok) return undefined;

      // Collect all matching survivors — multiple can exist when a prior dispose timed out.
      // We return the newest (by createdAt) so the caller operates on the most recent state.
      const matches: WorkspaceInfo[] = [];

      const blocks = listResult.value.split(/\n\n+/);
      for (const block of blocks) {
        const lines = block.trim().split("\n");
        const pathLine = lines.find((l) => l.startsWith("worktree "));
        if (!pathLine) continue;
        const path = pathLine.slice("worktree ".length).trim();
        const branchRef =
          lines
            .find((l) => l.startsWith("branch "))
            ?.slice("branch ".length)
            .trim() ?? "";
        const branchName = branchRef.startsWith("refs/heads/")
          ? branchRef.slice("refs/heads/".length)
          : branchRef;
        const parts = branchName.split("/");
        if (parts.length !== 3 || parts[0] !== "workspace") continue;
        const segment = parts[1] ?? "";
        // Match new hex format or legacy direct-agentId format (migration window).
        // No hex-only guard — "deadbeef"-style legacy agentIds must also be found.
        const isHexMatch = segment === searchHex;
        const isLegacyMatch = !isHexMatch && segment === searchRaw;
        if (!isHexMatch && !isLegacyMatch) continue;
        const wsId = parts[2];
        if (!wsId) continue;

        // Derive recency from the wsId itself (format: ws-<timestamp>-<random>), which is
        // embedded in the git-owned branch name — not from the writable marker file.
        const tsMatch = wsId.match(/^ws-(\d+)-/);
        const createdAt = tsMatch !== null && tsMatch[1] !== undefined ? Number(tsMatch[1]) : 0;
        const metadata: Record<string, string> = { branchName, repoPath: config.repoPath };

        const id = workspaceId(wsId);
        // Populate registry so subsequent isHealthy() calls work without rescanning
        if (!registry.has(id)) registry.set(id, { path, branchName });
        matches.push({ id, path, createdAt, metadata });
      }

      if (matches.length === 0) return undefined;
      // Multiple survivors: return the one with the highest timestamp embedded in the wsId
      // (git-owned, not agent-writable). Caller is responsible for disposing older survivors.
      return matches.reduce((best, cur) => (cur.createdAt > best.createdAt ? cur : best));
    },
  };
}
