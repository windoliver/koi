import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMemoryDir } from "./resolve-dir.js";

const TEST_ROOT = join(tmpdir(), "koi-resolve-dir-test");

afterEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("resolveMemoryDir", () => {
  test("normal repo — .git directory returns {root}/.koi/memory", async () => {
    const repo = join(TEST_ROOT, "normal-repo");
    await mkdir(join(repo, ".git"), { recursive: true });

    const result = await resolveMemoryDir(repo);
    expect(result).toBe(join(repo, ".koi/memory"));
  });

  test("subdirectory of normal repo resolves to repo root", async () => {
    const repo = join(TEST_ROOT, "normal-repo-sub");
    await mkdir(join(repo, ".git"), { recursive: true });
    const sub = join(repo, "packages", "foo");
    await mkdir(sub, { recursive: true });

    const result = await resolveMemoryDir(sub);
    expect(result).toBe(join(repo, ".koi/memory"));
  });

  test("worktree — .git file follows gitdir to main root", async () => {
    // Set up main repo
    const main = join(TEST_ROOT, "main-repo");
    const mainGit = join(main, ".git");
    await mkdir(mainGit, { recursive: true });

    // Set up worktree with .git file pointing to main
    const wt = join(TEST_ROOT, "worktree");
    await mkdir(wt, { recursive: true });
    const wtGitDir = join(mainGit, "worktrees", "wt1");
    await mkdir(wtGitDir, { recursive: true });

    // .git file in worktree
    await writeFile(join(wt, ".git"), `gitdir: ${wtGitDir}\n`, "utf-8");
    // commondir in worktree gitdir
    // commondir points from worktrees/wt1/ back to the .git directory
    await writeFile(join(wtGitDir, "commondir"), "../..\n", "utf-8");

    const result = await resolveMemoryDir(wt);
    expect(result).toBe(join(main, ".koi/memory"));
  });

  test("no .git found — falls back to {cwd}/.koi/memory", async () => {
    const noGit = join(TEST_ROOT, "no-git");
    await mkdir(noGit, { recursive: true });

    const result = await resolveMemoryDir(noGit);
    expect(result).toBe(join(noGit, ".koi/memory"));
  });
});
