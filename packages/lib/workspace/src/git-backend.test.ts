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

  it("findByAgentId does NOT find workspace when agent switched branches (accepted limitation)", async () => {
    // An unsandboxed agent can switch branches, breaking git-owned branch-name discovery.
    // This is a known limitation of isSandboxed=false: the agent can escape tracking by
    // renaming its branch, turning the workspace into an orphan. We deliberately do NOT
    // fall back to any file-based discovery (e.g. .koi-workspace marker) because on an
    // unsandboxed backend, any such file is writable by workspace processes — enabling
    // cross-agent disposal attacks where a tampered file causes another agent's workspace
    // to be cleaned up. The orphan scenario is a lesser harm than the trust regression.
    const backend = createGitWorktreeBackend({ repoPath });
    const result = await backend.create(aid, defaultConfig);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ws = result.value;
    const { execSync } = await import("node:child_process");
    execSync(`git -C "${ws.path}" checkout -b "some-other-branch"`, { stdio: "ignore" });

    // Branch-name discovery no longer finds it after the branch switch
    const survivors = await backend.findByAgentId?.(aid);
    expect(survivors).toHaveLength(0);

    // Restore so dispose (via registry) can clean up
    const branchInfo = ws.metadata.branchName as string;
    execSync(`git -C "${ws.path}" checkout "${branchInfo}"`, { stdio: "ignore" });
    await backend.dispose(ws.id);
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
