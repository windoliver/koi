import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mergeOctopusLevel } from "../merge-octopus.js";
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

describe("mergeOctopusLevel (integration)", () => {
  it("merges multiple clean branches at once", async () => {
    await createBranchWithChange(repoPath, "feature-a", "a.ts", "export const a = 1;\n");
    await createBranchWithChange(repoPath, "feature-b", "b.ts", "export const b = 2;\n");
    await createBranchWithChange(repoPath, "feature-c", "c.ts", "export const c = 3;\n");

    const outcomes = await mergeOctopusLevel(
      ["feature-a", "feature-b", "feature-c"],
      "main",
      repoPath,
      abortResolver,
    );

    expect(outcomes.size).toBe(3);
    for (const [, outcome] of outcomes) {
      expect(outcome.kind).toBe("merged");
    }
  });

  it("falls back to sequential on conflict", async () => {
    await createBranchWithChange(repoPath, "branch-1", "shared.ts", "version 1\n");
    await createBranchWithChange(repoPath, "branch-2", "shared.ts", "version 2\n");

    const outcomes = await mergeOctopusLevel(
      ["branch-1", "branch-2"],
      "main",
      repoPath,
      abortResolver,
    );

    expect(outcomes.size).toBe(2);
    // First should succeed (sequential fallback), second should conflict
    expect(outcomes.get("branch-1")?.kind).toBe("merged");
    expect(outcomes.get("branch-2")?.kind).toBe("conflict");
  });

  it("handles single branch (degenerates to sequential)", async () => {
    await createBranchWithChange(repoPath, "feature-a", "a.ts", "export const a = 1;\n");

    const outcomes = await mergeOctopusLevel(["feature-a"], "main", repoPath, abortResolver);

    expect(outcomes.size).toBe(1);
    expect(outcomes.get("feature-a")?.kind).toBe("merged");
  });

  it("handles empty branches array", async () => {
    const outcomes = await mergeOctopusLevel([], "main", repoPath, abortResolver);

    expect(outcomes.size).toBe(0);
  });

  it("merges all independent branches", async () => {
    await createBranchWithChange(repoPath, "feat-1", "f1.ts", "1\n");
    await createBranchWithChange(repoPath, "feat-2", "f2.ts", "2\n");

    const outcomes = await mergeOctopusLevel(["feat-1", "feat-2"], "main", repoPath, abortResolver);

    expect(outcomes.size).toBe(2);
    for (const [, outcome] of outcomes) {
      expect(outcome.kind).toBe("merged");
    }
  });
});
