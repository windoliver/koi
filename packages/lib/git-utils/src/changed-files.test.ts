import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFilesSince, getHeadCommit } from "./changed-files.js";
import { runGit } from "./run-git.js";

let repoPath: string;

beforeEach(async () => {
  repoPath = await mkdtemp(join(tmpdir(), "koi-changed-files-test-"));
  await runGit(["init", "--initial-branch=main"], repoPath);
  await runGit(["config", "user.email", "test@koi.dev"], repoPath);
  await runGit(["config", "user.name", "Koi Test"], repoPath);
  await Bun.write(join(repoPath, "README.md"), "# Test\n");
  await runGit(["add", "README.md"], repoPath);
  await runGit(["commit", "-m", "initial"], repoPath);
});

afterEach(async () => {
  await rm(repoPath, { recursive: true, force: true });
});

describe("getHeadCommit", () => {
  it("returns a 40-character hex SHA", async () => {
    const result = await getHeadCommit(repoPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("returns error for non-git directory", async () => {
    const nonGitDir = await mkdtemp(join(tmpdir(), "koi-nogit-"));
    const result = await getHeadCommit(nonGitDir);
    expect(result.ok).toBe(false);
    await rm(nonGitDir, { recursive: true, force: true });
  });
});

describe("changedFilesSince", () => {
  it("returns empty array when no files changed", async () => {
    const headResult = await getHeadCommit(repoPath);
    expect(headResult.ok).toBe(true);
    if (!headResult.ok) return;

    const result = await changedFilesSince(headResult.value, repoPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  it("detects modified files since a commit", async () => {
    const baseResult = await getHeadCommit(repoPath);
    expect(baseResult.ok).toBe(true);
    if (!baseResult.ok) return;

    // Modify a file after the base commit
    await Bun.write(join(repoPath, "README.md"), "# Updated\n");

    const result = await changedFilesSince(baseResult.value, repoPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(["README.md"]);
    }
  });

  it("detects newly added files", async () => {
    const baseResult = await getHeadCommit(repoPath);
    expect(baseResult.ok).toBe(true);
    if (!baseResult.ok) return;

    // Add new file and commit
    await Bun.write(join(repoPath, "new-file.ts"), "export const x = 1;\n");
    await runGit(["add", "new-file.ts"], repoPath);
    await runGit(["commit", "-m", "add new file"], repoPath);

    const result = await changedFilesSince(baseResult.value, repoPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain("new-file.ts");
    }
  });

  it("returns error for nonexistent commit", async () => {
    const result = await changedFilesSince("0000000000000000000000000000000000000000", repoPath);
    expect(result.ok).toBe(false);
  });
});
