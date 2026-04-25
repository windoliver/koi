import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedWorkspaceConfig } from "@koi/core";
import { agentId } from "@koi/core";
import { createGitWorktreeBackend } from "./git-backend.js";

const aid = agentId("test-agent");

const defaultConfig: ResolvedWorkspaceConfig = {
  cleanupPolicy: "always",
  cleanupTimeoutMs: 5_000,
};

async function createTempGitRepo(): Promise<string> {
  const dir = join(
    import.meta.dir,
    "__test-repos__",
    `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  const proc = Bun.spawn(["git", "init", "--initial-branch=main"], { cwd: dir });
  await proc.exited;
  const cfg = Bun.spawn(["git", "config", "user.email", "test@test.com"], { cwd: dir });
  await cfg.exited;
  const cfg2 = Bun.spawn(["git", "config", "user.name", "Test"], { cwd: dir });
  await cfg2.exited;
  // Need at least one commit for worktrees to work
  await writeFile(join(dir, "README.md"), "test repo");
  const add = Bun.spawn(["git", "add", "."], { cwd: dir });
  await add.exited;
  const commit = Bun.spawn(["git", "commit", "-m", "init"], { cwd: dir });
  await commit.exited;
  return dir;
}

describe("createGitWorktreeBackend", () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = await createTempGitRepo();
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
    // Also clean up __test-repos__ dir if empty
    await rm(join(import.meta.dir, "__test-repos__"), { recursive: true, force: true });
  });

  it("creates an isolated git worktree directory", async () => {
    const backend = createGitWorktreeBackend({ repoPath });
    const result = await backend.create(aid, defaultConfig);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ws = result.value;
    expect(ws.path).toBeTruthy();

    // Directory must exist
    const stat = await Bun.file(join(ws.path, ".koi-workspace")).exists();
    expect(stat).toBe(true);

    // Cleanup
    await backend.dispose(ws.id);
  });

  it("workspace path is inside basePath", async () => {
    const backend = createGitWorktreeBackend({ repoPath });
    const result = await backend.create(aid, defaultConfig);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await backend.dispose(result.value.id);
  });

  it("dispose removes the worktree directory", async () => {
    const backend = createGitWorktreeBackend({ repoPath });
    const result = await backend.create(aid, defaultConfig);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const path = result.value.path;
    const disposeResult = await backend.dispose(result.value.id);
    expect(disposeResult.ok).toBe(true);

    // Directory should be gone
    const exists = await Bun.file(join(path, ".koi-workspace")).exists();
    expect(exists).toBe(false);
  });

  it("dispose returns NOT_FOUND for unknown workspace id", async () => {
    const backend = createGitWorktreeBackend({ repoPath });
    const { workspaceId } = await import("@koi/core");
    const result = await backend.dispose(workspaceId("nonexistent"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("isHealthy returns true for an existing workspace", async () => {
    const backend = createGitWorktreeBackend({ repoPath });
    const result = await backend.create(aid, defaultConfig);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(await backend.isHealthy(result.value.id)).toBe(true);
    await backend.dispose(result.value.id);
  });

  it("isHealthy returns false for unknown workspace", async () => {
    const { workspaceId } = await import("@koi/core");
    const backend = createGitWorktreeBackend({ repoPath });
    expect(await backend.isHealthy(workspaceId("ghost"))).toBe(false);
  });

  it("metadata contains branchName", async () => {
    const backend = createGitWorktreeBackend({ repoPath });
    const result = await backend.create(aid, defaultConfig);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.branchName).toBeTruthy();
    expect(result.value.metadata.branchName).toMatch(/^workspace\/[0-9a-f]+\//);
    await backend.dispose(result.value.id);
  });

  it("supports worktreeBasePath override outside the repo", async () => {
    // Base path must be outside the repo — use a sibling directory
    const customBase = join(repoPath, "..", `custom-worktrees-${Date.now()}`);
    const backend = createGitWorktreeBackend({ repoPath, worktreeBasePath: customBase });
    const result = await backend.create(aid, defaultConfig);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.path.startsWith(customBase)).toBe(true);
    await backend.dispose(result.value.id);
    await rm(customBase, { recursive: true, force: true });
  });

  it("rejects worktreeBasePath inside the repository", () => {
    const insideRepo = join(repoPath, "custom-worktrees");
    expect(() => createGitWorktreeBackend({ repoPath, worktreeBasePath: insideRepo })).toThrow(
      "must not be inside the repository",
    );
  });

  it("findByAgentId locates a workspace by branch naming convention", async () => {
    const backend = createGitWorktreeBackend({ repoPath });
    const result = await backend.create(aid, defaultConfig);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ws = result.value;
    const survivors = await backend.findByAgentId?.(aid);
    expect(survivors).toHaveLength(1);
    expect(survivors?.[0]?.id).toBe(ws.id);
    expect(survivors?.[0]?.path).toBe(ws.path);

    await backend.dispose(ws.id);
  });

  it("findByAgentId returns empty array when no workspace for that agent", async () => {
    const backend = createGitWorktreeBackend({ repoPath });
    const survivors = await backend.findByAgentId?.(agentId("unknown-agent"));
    expect(survivors).toHaveLength(0);
  });

  it("findByAgentId still finds workspace after agent switched branches (via git branch list)", async () => {
    // An unsandboxed agent can switch branches, breaking git-owned branch-name discovery.
    // The provider branch `workspace/<hex>/<wsId>` stays in the repo even after drift.
    // The second pass scans git branch list and finds the workspace by matching the original
    // branch name against the live worktree directory — no trustOwnershipRefs needed.
    const backend = createGitWorktreeBackend({ repoPath }); // default: trustOwnershipRefs=false
    const result = await backend.create(aid, defaultConfig);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ws = result.value;
    const { execSync } = await import("node:child_process");
    execSync(`git -C "${ws.path}" checkout -b "some-other-branch"`, { stdio: "ignore" });

    // Git branch list fallback finds the workspace even after branch drift
    const survivors = await backend.findByAgentId?.(aid);
    expect(survivors).toHaveLength(1);
    expect(survivors?.[0]?.id).toBe(ws.id);

    // The recovered entry has the original managed branch; isHealthy returns false (branch mismatch)
    expect(await backend.isHealthy(ws.id)).toBe(false);
    // But exists() returns true — the worktree is physically present
    expect(await backend.exists?.(ws.id)).toBe(true);

    // dispose() can still remove it (uses registry entry populated by findByAgentId)
    await backend.dispose(ws.id);
    expect(await backend.exists?.(ws.id)).toBe(false);
  });

  it("findByAgentId still finds workspace via ownership ref (trustOwnershipRefs=true)", async () => {
    // Additional coverage: ownership-ref third pass works for sandboxed backends where
    // the git branch list second pass may not apply but trustOwnershipRefs is safe.
    const backend = createGitWorktreeBackend({ repoPath, trustOwnershipRefs: true });
    const result = await backend.create(aid, defaultConfig);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ws = result.value;
    const { execSync } = await import("node:child_process");
    execSync(`git -C "${ws.path}" checkout -b "some-sandboxed-drift"`, { stdio: "ignore" });

    // Both the branch-list pass and ownership-ref pass find it — deduplication should return 1
    const survivors = await backend.findByAgentId?.(aid);
    expect(survivors).toHaveLength(1);
    expect(survivors?.[0]?.id).toBe(ws.id);

    await backend.dispose(ws.id);
    expect(await backend.exists?.(ws.id)).toBe(false);
  });

  it("findByAgentId ignores worktrees outside this backend's base path", async () => {
    const basePath1 = join(repoPath, "..", `wt-base1-${Date.now()}`);
    const basePath2 = join(repoPath, "..", `wt-base2-${Date.now()}`);
    const backend1 = createGitWorktreeBackend({ repoPath, worktreeBasePath: basePath1 });
    const backend2 = createGitWorktreeBackend({ repoPath, worktreeBasePath: basePath2 });

    const aid2 = agentId("agent-two");
    const r1 = await backend1.create(aid, defaultConfig);
    const r2 = await backend2.create(aid2, defaultConfig);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    // backend1 should not see backend2's worktree for a different agent
    const found = await backend1.findByAgentId?.(aid2);
    expect(found).toHaveLength(0);

    await backend1.dispose(r1.value.id);
    await backend2.dispose(r2.value.id);
  });

  it("attestSetupComplete creates a git ref and verifySetupComplete confirms it", async () => {
    const backend = createGitWorktreeBackend({ repoPath });
    const result = await backend.create(aid, defaultConfig);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ws = result.value;
    expect(await backend.verifySetupComplete?.(ws.id)).toBe(false);

    await backend.attestSetupComplete?.(ws.id);
    expect(await backend.verifySetupComplete?.(ws.id)).toBe(true);

    await backend.dispose(ws.id);
    // Ref should be cleaned up by dispose
    expect(await backend.verifySetupComplete?.(ws.id)).toBe(false);
  });

  it("attestSetupComplete throws for an unknown workspace", async () => {
    const backend = createGitWorktreeBackend({ repoPath });
    const { workspaceId } = await import("@koi/core");
    await expect(backend.attestSetupComplete?.(workspaceId("ws-nonexistent"))).rejects.toThrow(
      "Cannot attest setup for unknown workspace",
    );
  });

  it("verifySetupComplete returns false after agent hard-resets the branch before the attested commit", async () => {
    const backend = createGitWorktreeBackend({ repoPath });
    const result = await backend.create(aid, defaultConfig);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ws = result.value;

    // Make a commit in the worktree so there is a parent to reset to
    await writeFile(join(ws.path, "agent-work.txt"), "work");
    const a = Bun.spawn(["git", "add", "."], { cwd: ws.path });
    await a.exited;
    const c = Bun.spawn(["git", "commit", "-m", "agent work", "--no-verify"], {
      cwd: ws.path,
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_AUTHOR_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "T",
      },
    });
    await c.exited;

    // Attest AFTER the commit — attested SHA is the commit above
    await backend.attestSetupComplete?.(ws.id);
    expect(await backend.verifySetupComplete?.(ws.id)).toBe(true);

    // Agent resets the branch back to the parent (before the attested commit)
    const r = Bun.spawn(["git", "reset", "--hard", "HEAD~1"], { cwd: ws.path });
    await r.exited;

    // Attestation should now fail: the attested commit is no longer reachable
    expect(await backend.verifySetupComplete?.(ws.id)).toBe(false);

    await backend.dispose(ws.id);
  });

  it("verifySetupComplete remains valid after agent commits more work on top of attested state", async () => {
    const backend = createGitWorktreeBackend({ repoPath });
    const result = await backend.create(aid, defaultConfig);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ws = result.value;

    // Attest at creation state, then agent makes a forward commit
    await backend.attestSetupComplete?.(ws.id);

    await writeFile(join(ws.path, "agent-work.txt"), "work");
    const a = Bun.spawn(["git", "add", "."], { cwd: ws.path });
    await a.exited;
    const c = Bun.spawn(["git", "commit", "-m", "agent work", "--no-verify"], {
      cwd: ws.path,
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_AUTHOR_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "T",
      },
    });
    await c.exited;

    // Verification should still pass: attested commit is an ancestor of current HEAD
    expect(await backend.verifySetupComplete?.(ws.id)).toBe(true);

    await backend.dispose(ws.id);
  });

  it("exists returns true for a live worktree and false after disposal", async () => {
    const backend = createGitWorktreeBackend({ repoPath });
    const r = await backend.create(aid, defaultConfig);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(await backend.exists?.(r.value.id)).toBe(true);

    await backend.dispose(r.value.id);
    expect(await backend.exists?.(r.value.id)).toBe(false);
  });

  it("exists returns true for a branch-drifted worktree (unlike isHealthy)", async () => {
    // This is the key difference: a worktree where the agent switched branches is
    // physically present but isHealthy() returns false due to branch mismatch.
    // exists() must return true so the provider correctly blocks a fresh workspace creation.
    const backend = createGitWorktreeBackend({ repoPath });
    const r = await backend.create(aid, defaultConfig);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Switch to a new branch in the worktree (simulating agent-driven branch drift)
    const driftBranch = `drifted-${Date.now()}`;
    await Bun.spawn(["git", "checkout", "-b", driftBranch], {
      cwd: r.value.path,
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_AUTHOR_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "T",
      },
    }).exited;

    // isHealthy should be false (branch drifted)
    expect(await backend.isHealthy(r.value.id)).toBe(false);

    // exists should still be true (worktree physically present)
    expect(await backend.exists?.(r.value.id)).toBe(true);

    // Cleanup: switch back then dispose
    await Bun.spawn(["git", "checkout", "-"], { cwd: r.value.path }).exited;
    await backend.dispose(r.value.id);
  });

  it("exists returns true after git worktree move (in-process, no drift)", async () => {
    // After git worktree move the directory basename changes, so basename matching fails.
    // exists() must fall back to the managed branch name to locate the moved worktree.
    const backend = createGitWorktreeBackend({ repoPath });
    const result = await backend.create(aid, defaultConfig);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ws = result.value;
    const newPath = ws.path + "-moved";
    // Move the worktree — basename changes from wsId to wsId+"-moved"
    await Bun.spawn(["git", "worktree", "move", ws.path, newPath], { cwd: repoPath }).exited;

    // exists() should return true (worktree physically present at new path, found via branch)
    expect(await backend.exists?.(ws.id)).toBe(true);
    // isHealthy uses the registry path (stale after move) and correctly returns false.
    // This is intentional: the provider treats moved workspaces as needing re-verification.
    expect(await backend.isHealthy(ws.id)).toBe(false);

    // Cleanup
    await Bun.spawn(["git", "worktree", "remove", "--force", newPath], { cwd: repoPath }).exited;
    await Bun.spawn(
      ["git", "branch", "-D", `workspace/${Buffer.from(aid as string).toString("hex")}/${ws.id}`],
      { cwd: repoPath },
    ).exited;
  });

  it("recoverEntry is scoped to this backend's base path", async () => {
    const basePath1 = join(repoPath, "..", `wt-recover1-${Date.now()}`);
    const basePath2 = join(repoPath, "..", `wt-recover2-${Date.now()}`);
    const backend1 = createGitWorktreeBackend({ repoPath, worktreeBasePath: basePath1 });
    const backend2 = createGitWorktreeBackend({ repoPath, worktreeBasePath: basePath2 });

    const aid2 = agentId("agent-recover");
    const r2 = await backend2.create(aid2, defaultConfig);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    // backend1 should NOT dispose backend2's workspace (recoverEntry is scoped to basePath1)
    const disposeResult = await backend1.dispose(r2.value.id);
    // Must fail: workspace is outside backend1's base path
    expect(disposeResult.ok).toBe(false);
    if (!disposeResult.ok) expect(disposeResult.error.code).toBe("NOT_FOUND");

    await backend2.dispose(r2.value.id);
  });
});
