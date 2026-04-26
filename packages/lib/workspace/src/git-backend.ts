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
  // Set to true only when agents cannot forge git state (e.g., no git access inside
  // the sandbox, or OS-level isolation). Enables: branch-only crash-survivor discovery,
  // ownership-ref recovery for drifted/moved workspaces, and setup-attestation trust for
  // the provider.
  readonly isSandboxed?: boolean;
}

interface RegistryEntry {
  readonly path: string;
  readonly branchName: string; // current branch (may differ from original after drift)
  readonly agentHex?: string; // for ownership-ref cleanup; populated when known
}

// SECURITY NOTE — isSandboxed=false (the default):
// Crash-survivor discovery uses git branch names and worktree basenames as ownership signals.
// Both are mutable by any agent with git access in the shared repo. A motivated agent can
// spoof these signals to cause another agent's workspace to be misidentified and disposed
// (cross-agent DoS). This is an accepted limitation of unsandboxed deployments.
// Use isSandboxed=true (with OS-level process isolation) for strong multi-agent isolation.
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

  // Scan the live worktree list for a worktree under this backend's base path that is
  // currently on the given managed branch. Used by dispose() to locate a moved worktree
  // when the registered path is stale — the managed branch is stable across git worktree move.
  async function findLivePathByBranch(branchName: string): Promise<string | null> {
    const listResult = await runGit(["worktree", "list", "--porcelain"], config.repoPath);
    if (!listResult.ok) return null;
    for (const block of listResult.value.split(/\n\n+/)) {
      const lines = block.trim().split("\n");
      const pathLine = lines.find((l) => l.startsWith("worktree "));
      if (!pathLine) continue;
      const path = pathLine.slice("worktree ".length).trim();
      if (!path.startsWith(resolvedBase + sep)) continue;
      const branchRef =
        lines
          .find((l) => l.startsWith("branch "))
          ?.slice("branch ".length)
          .trim() ?? "";
      const bn = branchRef.startsWith("refs/heads/")
        ? branchRef.slice("refs/heads/".length)
        : branchRef;
      if (bn === branchName) return path;
    }
    return null;
  }

  // Scan git worktree list to recover an entry that survived a process restart.
  // When isSandboxed=false (the default): identity requires BOTH the branch suffix AND
  // the path basename to match wsId — moved/renamed worktrees are unrecoverable, which
  // is safer than trusting a mismatched path that an agent could have forged via branch
  // switch + git worktree move. When isSandboxed=true: agents cannot forge git state,
  // so branch-only match is sufficient and moved worktrees are recoverable by branch name.
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
      // Enforce exact branch format: workspace/<agent>/<wsId>
      const branchParts = branchName.split("/");
      if (branchParts.length !== 3 || branchParts[0] !== "workspace") continue;
      const branchWsId = branchParts[2];
      if (branchWsId !== wsId) continue;
      // On untrusted backends: also require path basename to match — prevents cross-agent
      // misidentification if an agent switches its branch to another wsId's managed name.
      // On trusted backends: branch match alone is sufficient; basename may differ after move.
      const pathWsId = path.split(sep).pop();
      if (!config.isSandboxed && pathWsId !== wsId) continue;
      return { path, branchName };
    }
    return null;
  }

  // Always exposed: crash-survivor discovery is required for cleanup-only on ALL backends
  // (including unsandboxed) to prevent process restarts from stranding live worktrees and
  // violating the single-workspace-per-agent invariant. Reuse is separately gated by the
  // provider's isSetupComplete(), which returns false for unsandboxed backends so survivors
  // are always disposed rather than reused on untrusted backends.
  async function findByAgentId(searchAgentId: AgentId): Promise<ReadonlyArray<WorkspaceInfo>> {
    // Derive ownership from git-owned branch name and worktree path.
    // Branch format: workspace/<hex(agentId)>/<wsId>
    // Ownership is matched on hex encoding only — no raw-agentId fallback, which would create
    // a collision if one agent's literal id equals another agent's hex-encoded id.
    //
    // On isSandboxed=false: discovered survivors are never reused — the provider's
    // isSetupComplete() returns false for unsandboxed backends so tryReuseCrashSurvivor
    // always disposes them. Discovery here is for cleanup-only: without it, a process restart
    // strands live worktrees and violates the single-workspace-per-agent invariant.
    // A hostile agent with write access to both resolvedBase and the repo could forge a
    // basename+branch entry to trigger disposal of another agent's workspace (DoS). That risk
    // is accepted for unsandboxed deployments; the victim always recreates fresh afterward.
    //
    // On isSandboxed=true: survivors can be safely reused — OS isolation prevents git-state
    // forgery. Ownership refs (pass 3) are also trusted, enabling moved-worktree recovery.
    //
    // We deliberately avoid file-content fallbacks (e.g. reading .koi-workspace): on an
    // unsandboxed backend, any such file is writable by workspace processes, enabling cross-agent
    // disposal attacks where a tampered file causes another agent's workspace to be deleted.
    const searchHex = Buffer.from(searchAgentId as string).toString("hex");

    const listResult = await runGit(["worktree", "list", "--porcelain"], config.repoPath);
    if (!listResult.ok) {
      // Fail closed: returning [] would let the provider treat discovery failure as
      // "no survivors" and create a fresh workspace while an existing one may still be live.
      throw new Error(
        `Workspace survivor discovery failed for agent ${searchAgentId}: git worktree list error — ${listResult.error.message}`,
        { cause: listResult.error },
      );
    }

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
      // On untrusted backends: require path basename to match wsId — closes a cross-agent
      // DoS where an agent switches its branch to another agent's hex to appear as their
      // crash survivor. On isSandboxed=true backends, agents cannot forge git state
      // so branch-name matching is safe even after git worktree move changes the basename.
      if (!config.isSandboxed && path.split(sep).pop() !== wsId) continue;

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

    // Second pass: recover branch-drifted workspaces via git branch list.
    // The branch `workspace/<hex>/<wsId>` was created by the provider at create() time and
    // stays in the repo even when the agent switches the worktree to a different branch.
    // By scanning branches rather than current worktree heads, we find drifted survivors
    // that the first pass missed. This uses the same branch-naming signal as pass 1, so
    // it is no more forgeable than the primary discovery mechanism.
    const alreadyFound = new Set(matches.map((m) => m.id as string));
    const branchListResult = await runGit(
      ["branch", "--list", `workspace/${searchHex}/*`, "--format=%(refname:short)"],
      config.repoPath,
    );
    if (branchListResult.ok) {
      for (const branchName of branchListResult.value.split("\n").filter(Boolean)) {
        const parts = branchName.split("/");
        if (parts.length !== 3) continue;
        const wsId = parts[2] ?? "";
        if (!wsId || alreadyFound.has(wsId)) continue;
        // Search the actual worktree list under resolvedBase by basename — this handles
        // the default case (wsId === directory name) and avoids a synthesized path that
        // breaks after `git worktree move` changes the directory name.
        // Note: if the worktree was both moved (renamed) AND drifted, the basename will
        // no longer match wsId and recovery is not possible without ownership refs.
        // Guard: reject any candidate whose current HEAD branch is a DIFFERENT managed
        // workspace branch for this agent. That means pass 1 already claimed it (or will)
        // under the correct wsId — stealing it here would map the wrong workspace.
        let foundPath = "";
        const managedPrefix = `workspace/${searchHex}/`;
        for (const block of blocks) {
          const lines = block.trim().split("\n");
          const pathLine = lines.find((l) => l.startsWith("worktree "));
          if (!pathLine) continue;
          const candidate = pathLine.slice("worktree ".length).trim();
          if (!candidate.startsWith(resolvedBase + sep)) continue;
          if (candidate.split(sep).pop() !== wsId) continue;
          // Check whether this worktree is currently on a different managed branch.
          const rawRef =
            lines
              .find((l) => l.startsWith("branch "))
              ?.slice("branch ".length)
              .trim() ?? "";
          const candidateBranch = rawRef.startsWith("refs/heads/")
            ? rawRef.slice("refs/heads/".length)
            : rawRef;
          if (candidateBranch.startsWith(managedPrefix) && candidateBranch !== branchName) {
            // Worktree belongs to a different managed workspace — leave it for pass 1.
            break;
          }
          foundPath = candidate;
          break;
        }
        if (!foundPath) continue; // not found under resolvedBase — worktree may have been deleted or moved
        const id = workspaceId(wsId);
        if (!registry.has(id)) {
          registry.set(id, { path: foundPath, branchName, agentHex: searchHex });
        }
        const tsMatch = wsId.match(/^ws-(\d+)-/);
        const createdAt = tsMatch?.[1] !== undefined ? Number(tsMatch[1]) : 0;
        matches.push({
          id,
          path: foundPath,
          createdAt,
          metadata: { branchName, repoPath: config.repoPath },
        });
        alreadyFound.add(wsId);
      }
    }

    // Third pass (optional, sandboxed only): recover drifted workspaces via ownership refs.
    // Only enabled when isSandboxed=true. On unsandboxed backends, an agent with repo
    // access can forge ownership refs under another agent's hex, causing a cross-agent DoS.
    if (!config.isSandboxed) return matches.sort((a, b) => b.createdAt - a.createdAt);
    const ownershipResult = await runGit(
      ["for-each-ref", "--format=%(refname)", `refs/koi-ownership/${searchHex}/`],
      config.repoPath,
    );
    if (ownershipResult.ok) {
      for (const refname of ownershipResult.value.split("\n").filter(Boolean)) {
        const wsId = refname.split("/").pop() ?? "";
        if (!wsId || alreadyFound.has(wsId)) continue;
        // Find this worktree in the already-fetched list — restrict to resolvedBase to prevent
        // different backend instances sharing the same repo from claiming each other's workspaces.
        // Primary: match by basename (wsId === directory name — covers the common case).
        // Fallback: match by managed branch — covers git worktree move (basename changed).
        // isSandboxed=true guarantees agents cannot forge refs, making branch-match safe.
        let foundPath = "";
        const managedBranch = `workspace/${searchHex}/${wsId}`;
        for (const block of blocks) {
          const lines = block.trim().split("\n");
          const pathLine = lines.find((l) => l.startsWith("worktree "));
          if (!pathLine) continue;
          const candidate = pathLine.slice("worktree ".length).trim();
          if (!candidate.startsWith(resolvedBase + sep)) continue;
          if (candidate.split(sep).pop() === wsId) {
            foundPath = candidate;
            break;
          }
        }
        if (!foundPath) {
          // Branch-name fallback: find the worktree currently on the managed branch.
          // This recovers moved workspaces where git worktree move changed the directory name.
          for (const block of blocks) {
            const lines = block.trim().split("\n");
            const pathLine = lines.find((l) => l.startsWith("worktree "));
            if (!pathLine) continue;
            const candidate = pathLine.slice("worktree ".length).trim();
            if (!candidate.startsWith(resolvedBase + sep)) continue;
            const branchRef =
              lines
                .find((l) => l.startsWith("branch "))
                ?.slice("branch ".length)
                .trim() ?? "";
            const bn = branchRef.startsWith("refs/heads/")
              ? branchRef.slice("refs/heads/".length)
              : branchRef;
            if (bn === managedBranch) {
              foundPath = candidate;
              break;
            }
          }
        }
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
        matches.push({
          id,
          path: foundPath,
          createdAt,
          metadata: { branchName: originalBranch, repoPath: config.repoPath },
        });
      }
    }

    if (matches.length === 0) return [];
    // Return all survivors newest-first. The caller validates each candidate in order and
    // stops at the first healthy, setup-complete one. Older orphans are not pre-disposed here —
    // deleting alternatives before validation could cause irreversible loss if the newest
    // turns out incomplete; the provider disposes failed candidates as it iterates.
    return matches.sort((a, b) => b.createdAt - a.createdAt);
  }

  return {
    name: "git-worktree",
    isSandboxed: config.isSandboxed ?? false,

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

      let removeResult = await runGit(
        ["worktree", "remove", "--force", entry.path],
        config.repoPath,
      );
      if (!removeResult.ok && entry.branchName.startsWith("workspace/")) {
        // Path may be stale after git worktree move. Rescan by managed branch and retry.
        // The managed branch is stable across moves (it stays in the repo until explicitly
        // deleted), so it serves as a path-independent worktree identity for disposal.
        const livePath = await findLivePathByBranch(entry.branchName);
        if (livePath !== null && livePath !== entry.path) {
          removeResult = await runGit(["worktree", "remove", "--force", livePath], config.repoPath);
          if (removeResult.ok) {
            entry = { ...entry, path: livePath };
          }
        }
      }
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

    findByAgentId,

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
      const entry = registry.get(wsId);
      const registeredPath = entry?.path;
      // The managed branch is move-stable: it stays in the repo even after
      // git worktree move (as long as no branch drift). Use it as a secondary
      // identity check when the registered path is not found in the live list.
      const registeredBranch = entry?.branchName;
      let pathFound = false;
      let branchFound = false;
      for (const block of listResult.value.split(/\n\n+/)) {
        const lines = block.trim().split("\n");
        const pathLine = lines.find((l) => l.startsWith("worktree "));
        if (!pathLine) continue;
        const worktreePath = pathLine.slice("worktree ".length).trim();
        if (registeredPath !== undefined && worktreePath === registeredPath) {
          pathFound = true;
          break;
        }
        // If registered path is gone (moved), check by managed branch under resolvedBase.
        // This correctly returns true after git worktree move without branch drift.
        if (registeredBranch !== undefined && !pathFound) {
          const branchRef =
            lines
              .find((l) => l.startsWith("branch "))
              ?.slice("branch ".length)
              .trim() ?? "";
          const branchName = branchRef.startsWith("refs/heads/")
            ? branchRef.slice("refs/heads/".length)
            : branchRef;
          if (branchName === registeredBranch && worktreePath.startsWith(resolvedBase + sep)) {
            branchFound = true;
          }
        }
        // No registry entry (post-restart): fall back to basename.
        // Renamed destinations require ownership refs to resolve.
        if (registeredPath === undefined && registeredBranch === undefined) {
          if (worktreePath.split(sep).pop() === (wsId as string)) return true;
        }
      }
      return pathFound || branchFound;
    },
  };
}
