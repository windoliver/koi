import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mergeRebaseChain } from "../merge-rebase-chain.js";
import type { ConflictResolverFn } from "../types.js";
import { addCommit, createBranchWithChange, createTestRepo } from "./helpers.js";

const abortResolver: ConflictResolverFn = async () => ({ kind: "abort" });

let repoPath: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const repo = await createTestRepo();
  repoPath = repo.path;
  cleanup = repo.cleanup;
});

afterEach(async () => {
  await cleanup();
});

describe("mergeRebaseChain (integration)", () => {
  it("rebases and fast-forward merges a clean branch", async () => {
    await createBranchWithChange(repoPath, "feature-a", "a.ts", "export const a = 1;\n");

    const outcome = await mergeRebaseChain("feature-a", "main", repoPath, abortResolver);

    expect(outcome.kind).toBe("merged");
    if (outcome.kind === "merged") {
      expect(outcome.commitSha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("rebases two branches sequentially", async () => {
    await createBranchWithChange(repoPath, "feature-a", "a.ts", "export const a = 1;\n");
    await createBranchWithChange(repoPath, "feature-b", "b.ts", "export const b = 2;\n");

    const outcomeA = await mergeRebaseChain("feature-a", "main", repoPath, abortResolver);
    expect(outcomeA.kind).toBe("merged");

    const outcomeB = await mergeRebaseChain("feature-b", "main", repoPath, abortResolver);
    expect(outcomeB.kind).toBe("merged");
  });

  it("detects conflict during rebase", async () => {
    await createBranchWithChange(repoPath, "branch-1", "shared.ts", "version 1\n");
    await createBranchWithChange(repoPath, "branch-2", "shared.ts", "version 2\n");

    // Rebase first (succeeds)
    await mergeRebaseChain("branch-1", "main", repoPath, abortResolver);

    // Rebase second (conflicts)
    const outcome = await mergeRebaseChain("branch-2", "main", repoPath, abortResolver);
    // Should be either conflict or failed depending on git state
    expect(["conflict", "failed"]).toContain(outcome.kind);
  });

  it("handles multi-commit branch", async () => {
    const { runGit } = await import("@koi/git-utils");
    await runGit(["checkout", "-b", "multi-commit"], repoPath);
    await addCommit(repoPath, "file1.ts", "commit 1\n", "first commit");
    await addCommit(repoPath, "file2.ts", "commit 2\n", "second commit");
    await addCommit(repoPath, "file3.ts", "commit 3\n", "third commit");
    await runGit(["checkout", "main"], repoPath);

    const outcome = await mergeRebaseChain("multi-commit", "main", repoPath, abortResolver);

    expect(outcome.kind).toBe("merged");
  });
});
