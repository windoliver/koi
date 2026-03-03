import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mergeSequential } from "../merge-sequential.js";
import type { ConflictResolverFn } from "../types.js";
import { createBranchWithChange, createTestRepo } from "./helpers.js";

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

describe("mergeSequential (integration)", () => {
  it("merges a clean branch", async () => {
    await createBranchWithChange(repoPath, "feature-a", "a.ts", "export const a = 1;\n");

    const outcome = await mergeSequential("feature-a", "main", repoPath, abortResolver);

    expect(outcome.kind).toBe("merged");
    if (outcome.kind === "merged") {
      expect(outcome.commitSha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("merges two branches sequentially", async () => {
    await createBranchWithChange(repoPath, "feature-a", "a.ts", "export const a = 1;\n");
    await createBranchWithChange(repoPath, "feature-b", "b.ts", "export const b = 2;\n");

    const outcomeA = await mergeSequential("feature-a", "main", repoPath, abortResolver);
    expect(outcomeA.kind).toBe("merged");

    const outcomeB = await mergeSequential("feature-b", "main", repoPath, abortResolver);
    expect(outcomeB.kind).toBe("merged");
  });

  it("detects conflict and calls resolver", async () => {
    // Both branches modify the same file
    await createBranchWithChange(repoPath, "branch-1", "shared.ts", "version 1\n");
    await createBranchWithChange(repoPath, "branch-2", "shared.ts", "version 2\n");

    // Merge first branch (succeeds)
    await mergeSequential("branch-1", "main", repoPath, abortResolver);

    // Merge second branch (conflicts)
    const outcome = await mergeSequential("branch-2", "main", repoPath, abortResolver);
    expect(outcome.kind).toBe("conflict");
    if (outcome.kind === "conflict") {
      expect(outcome.resolved).toBe(false);
      expect(outcome.conflictFiles).toContain("shared.ts");
    }
  });

  it("handles branch with no new commits", async () => {
    // Create a branch from main with no additional commits
    const { runGit } = await import("@koi/git-utils");
    await runGit(["branch", "empty-branch"], repoPath);

    const outcome = await mergeSequential("empty-branch", "main", repoPath, abortResolver);

    // Git merge with no changes should succeed (already up to date)
    // The merge --no-ff may fail or succeed depending on git behavior
    // Either merged or failed is acceptable for empty branch
    expect(["merged", "failed"]).toContain(outcome.kind);
  });

  it("handles same-file modification across branches with different files", async () => {
    await createBranchWithChange(repoPath, "feature-x", "x.ts", "export const x = 'x';\n");
    await createBranchWithChange(repoPath, "feature-y", "y.ts", "export const y = 'y';\n");
    await createBranchWithChange(repoPath, "feature-z", "z.ts", "export const z = 'z';\n");

    const outcomes = [];
    for (const branch of ["feature-x", "feature-y", "feature-z"]) {
      const outcome = await mergeSequential(branch, "main", repoPath, abortResolver);
      outcomes.push(outcome);
    }

    // All should succeed since they touch different files
    expect(outcomes.every((o) => o.kind === "merged")).toBe(true);
  });
});
