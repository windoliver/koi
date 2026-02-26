/**
 * Temporary git repository helper for tests.
 *
 * Creates a bare git repo with an initial commit for testing
 * git-based features (worktrees, branches, etc.).
 */

import { rm } from "node:fs/promises";
import { makeTempDir } from "./temp-dir.js";

export interface TempGitRepo {
  readonly repoPath: string;
  readonly cleanup: () => Promise<void>;
}

/**
 * Creates a temporary git repository with an initial commit.
 *
 * The repo is fully initialized with a `main` branch and a
 * single commit containing a README file. Caller is responsible
 * for cleanup (call `cleanup()` when done).
 */
export async function createTempGitRepo(): Promise<TempGitRepo> {
  const repoPath = await makeTempDir();

  const run = async (args: readonly string[]): Promise<void> => {
    const proc = Bun.spawn(["git", ...args], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`git ${args[0]} failed (exit ${exitCode}): ${stderr}`);
    }
  };

  await run(["init", "--initial-branch", "main"]);
  await run(["config", "user.email", "test@koi.dev"]);
  await run(["config", "user.name", "Koi Test"]);
  await Bun.write(`${repoPath}/README.md`, "# Test Repo\n");
  await run(["add", "README.md"]);
  await run(["commit", "-m", "initial commit"]);

  return {
    repoPath,
    cleanup: async () => {
      await rm(repoPath, { recursive: true, force: true });
    },
  };
}
