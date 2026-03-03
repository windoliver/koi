import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "@koi/git-utils";
import {
  gitBranchExists,
  gitCheckout,
  gitDiffConflictFiles,
  gitMergeNoFf,
  gitResetHard,
  gitRevParseBranch,
  gitRevParseHead,
} from "./git-operations.js";

let repoPath: string;

beforeEach(async () => {
  repoPath = await mkdtemp(join(tmpdir(), "koi-gitops-test-"));
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

describe("gitRevParseHead", () => {
  it("returns the HEAD sha", async () => {
    const result = await gitRevParseHead(repoPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

describe("gitMergeNoFf", () => {
  it("returns commit sha on successful merge", async () => {
    await runGit(["checkout", "-b", "feature"], repoPath);
    await Bun.write(join(repoPath, "feat.ts"), "feat\n");
    await runGit(["add", "feat.ts"], repoPath);
    await runGit(["commit", "-m", "add feat"], repoPath);
    await runGit(["checkout", "main"], repoPath);

    const result = await gitMergeNoFf("feature", repoPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("returns error on merge failure", async () => {
    const result = await gitMergeNoFf("nonexistent", repoPath);
    expect(result.ok).toBe(false);
  });
});

describe("gitResetHard", () => {
  it("resets to a ref", async () => {
    const head1 = await gitRevParseHead(repoPath);
    await Bun.write(join(repoPath, "new.ts"), "new\n");
    await runGit(["add", "new.ts"], repoPath);
    await runGit(["commit", "-m", "new commit"], repoPath);

    if (head1.ok) {
      const result = await gitResetHard(head1.value, repoPath);
      expect(result).toEqual({ ok: true, value: undefined });
      const head2 = await gitRevParseHead(repoPath);
      expect(head2.ok && head2.value).toBe(head1.value);
    }
  });
});

describe("gitDiffConflictFiles", () => {
  it("returns empty for clean repo", async () => {
    const result = await gitDiffConflictFiles(repoPath);
    expect(result).toEqual({ ok: true, value: [] });
  });
});

describe("gitBranchExists", () => {
  it("returns true for existing branch", async () => {
    const result = await gitBranchExists("main", repoPath);
    expect(result).toEqual({ ok: true, value: true });
  });

  it("returns false for nonexistent branch", async () => {
    const result = await gitBranchExists("nonexistent", repoPath);
    expect(result).toEqual({ ok: true, value: false });
  });
});

describe("gitCheckout", () => {
  it("switches branch", async () => {
    await runGit(["branch", "develop"], repoPath);
    const result = await gitCheckout("develop", repoPath);
    expect(result).toEqual({ ok: true, value: undefined });
  });
});

describe("gitRevParseBranch", () => {
  it("returns the SHA for an existing branch", async () => {
    const result = await gitRevParseBranch("main", repoPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("returns error for nonexistent branch", async () => {
    const result = await gitRevParseBranch("nonexistent", repoPath);
    expect(result.ok).toBe(false);
  });
});
