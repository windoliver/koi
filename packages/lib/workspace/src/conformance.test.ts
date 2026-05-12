import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeWorkspaceConformance } from "@koi/workspace-conformance";
import { createGitWorktreeBackend } from "./git-backend.js";

async function makeRepo(): Promise<string> {
  // Resolve symlinks: macOS tmpdir() returns /var/folders/... but git resolves
  // to /private/var/folders/..., and isHealthy compares paths byte-for-byte.
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "koi-conformance-repo-")));
  const init = Bun.spawn(["git", "init", "--initial-branch=main"], { cwd: dir });
  await init.exited;
  const email = Bun.spawn(["git", "config", "user.email", "conformance@koi.dev"], { cwd: dir });
  await email.exited;
  const name = Bun.spawn(["git", "config", "user.name", "Conformance"], { cwd: dir });
  await name.exited;
  const commit = Bun.spawn(["git", "commit", "--allow-empty", "-m", "init"], { cwd: dir });
  await commit.exited;
  return dir;
}

describeWorkspaceConformance("createGitWorktreeBackend", async () => {
  const repoPath = await makeRepo();
  const worktreeBasePath = realpathSync(await mkdtemp(join(tmpdir(), "koi-conformance-wt-")));
  const backend = createGitWorktreeBackend({ repoPath, worktreeBasePath });
  return {
    backend,
    cleanup: async () => {
      await rm(repoPath, { recursive: true, force: true });
      await rm(worktreeBasePath, { recursive: true, force: true });
    },
  };
});
