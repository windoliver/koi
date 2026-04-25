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
  // Only enable in sandboxed backends where agents cannot forge git refs.
  // On unsandboxed backends, an agent with repo access can write ownership refs
  // under another agent's hex, causing cross-agent workspace collisions.
  readonly trustOwnershipRefs?: boolean;
}

interface RegistryEntry {
  readonly path: string;
  readonly branchName: string; // current branch (may differ from original after drift)
  readonly agentHex?: string; // for ownership-ref cleanup; populated when known
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
      // Scope to this backend's base path — prevents cross-instance disposal when two
      // providers share a repo but use different worktreeBasePath roots.
      if (!path.startsWith(resolvedBase + sep)) continue;
      const branchRef =
        lines
          .find((l) => l.startsWith("branch "))
          ?.slice("branch ".length)
          .trim() ?? "";
      const branchName = branchRef.startsWith("refs/heads/")
        ? branchRef.slice("refs/heads/".length)
        : branchRef;
      if (!branchName) continue;
      // Enforce exact branch format: workspace/<agent>/<wsId> — reject any worktree whose
      // branch does not follow the 3-segment convention (isSandboxed=false, so agent code
      // could create arbitrary branches; don't recover from unrecognized shapes).
      const branchParts = branchName.split("/");
      if (branchParts.length !== 3 || branchParts[0] !== "workspace") continue;
      const branchWsId = branchParts[2];
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

      try {
        await mkdir(basePath, { recursive: true });
      } catch (e: unknown) {
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: `Failed to create worktree base directory ${basePath}: ${e instanceof Error ? e.message : String(e)}`,
            retryable: false,
            cause: e,
          },
        };
      }

      const addResult = await runGit(["worktree", "add", "-b", branchName, path], config.repoPath);
      if (!addResult.ok) return addResult;

      // Register before the marker write so we can dispose on failure
      registry.set(id, { path, branchName, agentHex: agentIdHex });

      // Write an ownership ref in the main repo so findByAgentId can locate this workspace
      // even if the agent later switches branches inside the worktree (branch drift).
      // Best-effort: failure here is non-fatal since the branch-name scan serves as fallback.
      await runGit(
        ["update-ref", `refs/koi-ownership/${agentIdHex}/${id}`, "HEAD"],
        config.repoPath,
      );

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

      // Branch deletion is best-effort — failure doesn't fail dispose.
      // Only delete branches owned by this backend (workspace/<hex>/<wsId> naming).
      // If the workspace switched branches (drift), the current branch belongs to the user
      // and must not be deleted — the worktree removal above is sufficient cleanup.
      if (entry.branchName?.startsWith("workspace/")) {
        await runGit(["branch", "-D", entry.branchName], config.repoPath);
      }
      // Setup-attestation ref cleanup is best-effort — failure doesn't fail dispose
      await runGit(["update-ref", "-d", `refs/koi-setup-ok/${wsId}`], config.repoPath);
      // Ownership ref cleanup — derive agentHex from registry entry or from branch name
      const agentHex =
        entry.agentHex ??
        (entry.branchName.startsWith("workspace/") ? entry.branchName.split("/")[1] : undefined);
      if (agentHex) {
        await runGit(
          ["update-ref", "-d", `refs/koi-ownership/${agentHex}/${wsId}`],
          config.repoPath,
        );
      }

      registry.delete(wsId);
      return { ok: true, value: undefined };
    },

    async isHealthy(wsId: WorkspaceId): Promise<boolean> {
      const entry = registry.get(wsId);
      if (!entry) return false;
      // Validate via git-owned state: verify both the path AND expected branch still match.
      // Path-only check would pass even if an agent has repointed the worktree to a different
      // branch — the branch check prevents reuse of state that drifted from the attested setup.
      const listResult = await runGit(["worktree", "list", "--porcelain"], config.repoPath);
      if (!listResult.ok) return false;
      for (const block of listResult.value.split(/\n\n+/)) {
        const lines = block.trim().split("\n");
        const pathLine = lines.find((l) => l.startsWith("worktree "));
        if (!pathLine || pathLine.slice("worktree ".length).trim() !== entry.path) continue;
        const branchRef =
          lines
            .find((l) => l.startsWith("branch "))
            ?.slice("branch ".length)
            .trim() ?? "";
        const branchName = branchRef.startsWith("refs/heads/")
          ? branchRef.slice("refs/heads/".length)
          : branchRef;
        return branchName === entry.branchName;
      }
      return false;
    },

    async findByAgentId(searchAgentId: AgentId): Promise<ReadonlyArray<WorkspaceInfo>> {
      // Derive ownership exclusively from the git-owned branch name — tamper-resistant for
      // the naming scheme (agents cannot claim another agent's branch without knowing their hex).
      // Branch format: workspace/<hex(agentId)>/<wsId>
      // Ownership is matched on hex encoding only — no raw-agentId fallback, which would create
      // a collision if one agent's literal id equals another agent's hex-encoded id.
      //
      // We deliberately avoid file-content fallbacks (e.g. reading .koi-workspace): on an
      // unsandboxed backend, any such file is writable by workspace processes, enabling cross-agent
      // disposal attacks where a tampered file causes another agent's workspace to be deleted.
      // The two ownership signals used here are both stored in the main repo:
      //   1. Branch name `workspace/<hex>/<wsId>` — the primary signal (most tamper-resistant)
      //   2. Ownership ref `refs/koi-ownership/<hex>/<wsId>` — fallback for branch-drift recovery
      // Note: since isSandboxed=false, a workspace process CAN forge git refs, so neither signal
      // is fully tamper-proof. The risk model accepts this for unsandboxed backends.
      const searchHex = Buffer.from(searchAgentId as string).toString("hex");

      const listResult = await runGit(["worktree", "list", "--porcelain"], config.repoPath);
      if (!listResult.ok) return [];

      // Collect all matching survivors — multiple can exist when a prior dispose timed out.
      const matches: WorkspaceInfo[] = [];

      const blocks = listResult.value.split(/\n\n+/);
      for (const block of blocks) {
        const lines = block.trim().split("\n");
        const pathLine = lines.find((l) => l.startsWith("worktree "));
        if (!pathLine) continue;
        const path = pathLine.slice("worktree ".length).trim();
        // Reject worktrees outside this backend's configured base path.
        // Without this check, two providers sharing a repo but different base paths
        // can claim each other's worktrees, leading to cross-instance deletion.
        if (!path.startsWith(resolvedBase + sep)) continue;
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
        if (segment !== searchHex) continue;
        const wsId = parts[2];
        if (!wsId) continue;

        // Derive recency from the wsId itself (format: ws-<timestamp>-<random>), which is
        // embedded in the git-owned branch name — not from the writable marker file.
        const tsMatch = wsId.match(/^ws-(\d+)-/);
        const createdAt = tsMatch !== null && tsMatch[1] !== undefined ? Number(tsMatch[1]) : 0;
        const metadata: Record<string, string> = { branchName, repoPath: config.repoPath };

        const id = workspaceId(wsId);
        // Populate registry so subsequent isHealthy() calls work without rescanning
        if (!registry.has(id)) registry.set(id, { path, branchName, agentHex: searchHex });
        matches.push({ id, path, createdAt, metadata });
      }

      // Second pass: recover branch-drifted workspaces via ownership refs.
      // Only enabled when trustOwnershipRefs=true (sandboxed backends). On unsandboxed
      // backends, an agent with repo access can forge ownership refs under another agent's
      // hex, which would cause the victim's next attach() to try disposing an unrelated
      // live workspace — a cross-agent DoS via forgeable git state.
      if (!config.trustOwnershipRefs) return matches.sort((a, b) => b.createdAt - a.createdAt);
      const alreadyFound = new Set(matches.map((m) => m.id as string));
      const ownershipResult = await runGit(
        ["for-each-ref", "--format=%(refname)", `refs/koi-ownership/${searchHex}/`],
        config.repoPath,
      );
      if (ownershipResult.ok) {
        for (const refname of ownershipResult.value.split("\n").filter(Boolean)) {
          const wsId = refname.split("/").pop() ?? "";
          if (!wsId || alreadyFound.has(wsId)) continue;
          // The worktree is expected to be directly under basePath (wsId is its basename).
          // Note: relocation outside basePath via `git worktree move` is not recovered here;
          // this fallback is specifically for branch-drift survivors at their original path.
          const expectedPath = join(basePath, wsId);
          // Find this worktree in the already-fetched list — restrict to resolvedBase to prevent
          // different backend instances sharing the same repo from claiming each other's workspaces.
          let foundPath = "";
          for (const block of blocks) {
            const lines = block.trim().split("\n");
            const pathLine = lines.find((l) => l.startsWith("worktree "));
            if (!pathLine) continue;
            const candidate = pathLine.slice("worktree ".length).trim();
            if (!candidate.startsWith(resolvedBase + sep)) continue;
            // Match by basename to handle any within-basePath relocation edge cases
            if (candidate.split(sep).pop() === wsId) {
              foundPath = candidate;
              break;
            }
          }
          // Also accept the exact expected path even if no basePath-restricted match
          if (!foundPath) foundPath = expectedPath;
          // Verify by checking git worktree list (basePath-scoped)
          const inList = blocks.some((block) => {
            const lines = block.trim().split("\n");
            const pathLine = lines.find((l) => l.startsWith("worktree "));
            return pathLine?.slice("worktree ".length).trim() === foundPath;
          });
          if (!inList) continue; // worktree not present — already gone or relocated outside scope
          const tsMatch = wsId.match(/^ws-(\d+)-/);
          const createdAt = tsMatch !== null && tsMatch[1] !== undefined ? Number(tsMatch[1]) : 0;
          const id = workspaceId(wsId);
          // Store the ORIGINAL managed branch (not the drifted one) so dispose() only removes
          // the backend-owned ephemeral branch, never a user branch the agent switched to.
          const originalBranch = `workspace/${searchHex}/${wsId}`;
          if (!registry.has(id)) {
            registry.set(id, { path: foundPath, branchName: originalBranch, agentHex: searchHex });
          }
          matches.push({ id, path: foundPath, createdAt, metadata: { repoPath: config.repoPath } });
        }
      }

      if (matches.length === 0) return [];
      // Return all survivors newest-first. The caller validates each candidate in order and
      // stops at the first healthy, setup-complete one. Older orphans are not pre-disposed here —
      // deleting alternatives before validation could cause irreversible loss if the newest
      // turns out incomplete; the provider disposes failed candidates as it iterates.
      return matches.sort((a, b) => b.createdAt - a.createdAt);
    },

    // Use a git ref as the setup-complete attestation. Note: since isSandboxed is false,
    // an agent running in the worktree can forge refs/koi-setup-ok/* via ordinary git
    // plumbing. The provider therefore does NOT trust these methods for crash-survivor
    // reuse on unsandboxed backends — they are useful only for in-process tracking and
    // for sandboxed backends where the agent cannot reach the shared git repo.
    async attestSetupComplete(wsId: WorkspaceId): Promise<void> {
      const entry = registry.get(wsId);
      if (!entry) throw new Error(`Cannot attest setup for unknown workspace ${wsId}`);
      const result = await runGit(
        ["update-ref", `refs/koi-setup-ok/${wsId}`, `refs/heads/${entry.branchName}`],
        config.repoPath,
      );
      if (!result.ok) {
        throw new Error(`Failed to write setup-attestation ref for workspace ${wsId}`, {
          cause: result.error,
        });
      }
    },

    async invalidateSetupComplete(wsId: WorkspaceId): Promise<void> {
      // Delete the attestation ref so a mid-repair crash leaves this workspace unattested.
      // Fail closed: if deletion is unconfirmed, verify the ref is actually gone.
      // If the ref is still present, throw so callers block repair rather than proceeding
      // with a stale "setup complete" marker still in place.
      const result = await runGit(
        ["update-ref", "-d", `refs/koi-setup-ok/${wsId}`],
        config.repoPath,
      );
      if (result.ok) return;
      // Deletion returned non-zero — could be "ref already absent" (idempotent) or a real error.
      // Check presence to distinguish the two cases.
      const checkResult = await runGit(
        ["rev-parse", "--verify", `refs/koi-setup-ok/${wsId}`],
        config.repoPath,
      );
      if (checkResult.ok) {
        // Ref is still present — the deletion genuinely failed
        throw new Error(`Failed to invalidate setup attestation for workspace ${wsId}`, {
          cause: result.error,
        });
      }
      // Ref is already gone — idempotent success
    },

    async verifySetupComplete(wsId: WorkspaceId): Promise<boolean> {
      const entry = registry.get(wsId);
      if (!entry) return false;
      // Verify the attestation ref exists
      const refResult = await runGit(
        ["rev-parse", "--verify", `refs/koi-setup-ok/${wsId}`],
        config.repoPath,
      );
      if (!refResult.ok) return false;
      // Verify the attested commit is still an ancestor of the current branch HEAD.
      // If the agent hard-reset the branch to a commit before setup, this fails and
      // we refuse reuse — preventing resurrection of pre-setup state after a crash.
      // Forward commits (normal agent work) are fine: the attested commit remains reachable.
      const ancestorResult = await runGit(
        [
          "merge-base",
          "--is-ancestor",
          `refs/koi-setup-ok/${wsId}`,
          `refs/heads/${entry.branchName}`,
        ],
        config.repoPath,
      );
      return ancestorResult.ok;
    },

    // Distinct from isHealthy: answers "does the worktree exist on disk?" regardless of branch
    // state or path. Used as a post-disposal liveness oracle — isHealthy returns false for
    // branch-drifted workspaces even when the worktree is still registered with git.
    // Matches by wsId in the path basename rather than by a fixed expected path, so it
    // correctly returns true even after `git worktree move` relocates the worktree.
    async exists(wsId: WorkspaceId): Promise<boolean> {
      const listResult = await runGit(["worktree", "list", "--porcelain"], config.repoPath);
      // Fail closed: if we cannot query git, assume the worktree still exists.
      if (!listResult.ok) return true;
      for (const block of listResult.value.split(/\n\n+/)) {
        const lines = block.trim().split("\n");
        const pathLine = lines.find((l) => l.startsWith("worktree "));
        if (!pathLine) continue;
        const worktreePath = pathLine.slice("worktree ".length).trim();
        // Match by basename — wsId (ws-<timestamp>-<random>) is unique and is always the
        // directory name. Basename matching survives git worktree move or filesystem relocation.
        if (worktreePath.split(sep).pop() === (wsId as string)) return true;
      }
      return false;
    },
  };
}
