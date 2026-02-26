/**
 * Test helpers for creating temporary git repos with branches.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "@koi/git-utils";

/** Creates a temp git repo with an initial commit. */
export async function createTestRepo(): Promise<{
  readonly path: string;
  readonly cleanup: () => Promise<void>;
}> {
  const path = await mkdtemp(join(tmpdir(), "koi-merge-test-"));

  await runGit(["init", "--initial-branch=main"], path);
  await runGit(["config", "user.email", "test@koi.dev"], path);
  await runGit(["config", "user.name", "Koi Test"], path);

  // Create initial commit
  await Bun.write(join(path, "README.md"), "# Test repo\n");
  await runGit(["add", "README.md"], path);
  await runGit(["commit", "-m", "initial commit"], path);

  return {
    path,
    cleanup: async () => {
      await rm(path, { recursive: true, force: true });
    },
  };
}

/** Adds a file with content and commits, returns the commit SHA. */
export async function addCommit(
  repoPath: string,
  file: string,
  content: string,
  message: string,
): Promise<string> {
  await Bun.write(join(repoPath, file), content);
  await runGit(["add", file], repoPath);
  await runGit(["commit", "-m", message], repoPath);
  const result = await runGit(["rev-parse", "HEAD"], repoPath);
  if (!result.ok) throw new Error(`Failed to get HEAD: ${result.error.message}`);
  return result.value;
}

/** Creates a branch from a ref (default: HEAD). */
export async function createBranch(repoPath: string, branch: string, from?: string): Promise<void> {
  if (from) {
    await runGit(["branch", branch, from], repoPath);
  } else {
    await runGit(["branch", branch], repoPath);
  }
}

/**
 * Creates a branch with a specific file change.
 *
 * Creates the branch from main, checks it out, adds a commit
 * with the given file/content, then switches back to main.
 */
export async function createBranchWithChange(
  repoPath: string,
  branch: string,
  file: string,
  content: string,
): Promise<string> {
  await runGit(["checkout", "-b", branch], repoPath);
  const sha = await addCommit(repoPath, file, content, `Add ${file} on ${branch}`);
  await runGit(["checkout", "main"], repoPath);
  return sha;
}
