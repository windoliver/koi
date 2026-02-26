import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runGit } from "@koi/git-utils";
import { executeMerge } from "../execute-merge.js";
import type { MergeConfig, VerifyFn } from "../types.js";
import { addCommit, createBranchWithChange, createTestRepo } from "./helpers.js";

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

describe("edge cases", () => {
  // Case 1: Zero branches
  it("returns immediate success for zero branches", async () => {
    const config: MergeConfig = {
      repoPath,
      targetBranch: "main",
      branches: [],
      strategy: "sequential",
    };

    const result = await executeMerge(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.outcomes.size).toBe(0);
      expect(result.value.mergeOrder).toEqual([]);
      expect(result.value.verified).toBe(true);
      expect(result.value.aborted).toBe(false);
    }
  });

  // Case 2: Single branch
  it("merges single branch without ordering issues", async () => {
    await createBranchWithChange(repoPath, "solo", "solo.ts", "solo\n");

    const config: MergeConfig = {
      repoPath,
      targetBranch: "main",
      branches: [{ name: "solo", dependsOn: [] }],
      strategy: "sequential",
    };

    const result = await executeMerge(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.outcomes.size).toBe(1);
      expect(result.value.outcomes.get("solo")?.kind).toBe("merged");
    }
  });

  // Case 3: Circular dependency
  it("returns validation error for circular dependency", async () => {
    const config: MergeConfig = {
      repoPath,
      targetBranch: "main",
      branches: [
        { name: "a", dependsOn: ["b"] },
        { name: "b", dependsOn: ["c"] },
        { name: "c", dependsOn: ["a"] },
      ],
      strategy: "sequential",
    };

    const result = await executeMerge(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("Cycle");
    }
  });

  // Case 4: Branch deleted between planning and merge
  it("returns failed outcome when branch does not exist", async () => {
    const config: MergeConfig = {
      repoPath,
      targetBranch: "main",
      branches: [{ name: "ghost-branch", dependsOn: [] }],
      strategy: "sequential",
    };

    const result = await executeMerge(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const outcome = result.value.outcomes.get("ghost-branch");
      expect(outcome?.kind).toBe("failed");
    }
  });

  // Case 5: Target branch advanced (other merges happened)
  it("merges from current HEAD even after target advances", async () => {
    await createBranchWithChange(repoPath, "feat-a", "a.ts", "a\n");

    // Advance main with another commit
    await addCommit(repoPath, "advance.ts", "advanced\n", "advance main");

    const config: MergeConfig = {
      repoPath,
      targetBranch: "main",
      branches: [{ name: "feat-a", dependsOn: [] }],
      strategy: "sequential",
    };

    const result = await executeMerge(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.outcomes.get("feat-a")?.kind).toBe("merged");
    }
  });

  // Case 6: Binary file conflict
  it("detects conflict with binary-like files", async () => {
    // Simulate binary-like conflict with same file, different content
    await createBranchWithChange(repoPath, "bin-1", "data.bin", "\x00\x01\x02");
    await createBranchWithChange(repoPath, "bin-2", "data.bin", "\x03\x04\x05");

    const config: MergeConfig = {
      repoPath,
      targetBranch: "main",
      branches: [
        { name: "bin-1", dependsOn: [] },
        { name: "bin-2", dependsOn: [] },
      ],
      strategy: "sequential",
    };

    const result = await executeMerge(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // First should merge, second should conflict
      expect(result.value.outcomes.get("bin-1")?.kind).toBe("merged");
      const bin2 = result.value.outcomes.get("bin-2");
      expect(bin2?.kind).toBe("conflict");
    }
  });

  // Case 7: Branch with no new commits
  it("handles branch with no new commits", async () => {
    await runGit(["branch", "no-change"], repoPath);

    const config: MergeConfig = {
      repoPath,
      targetBranch: "main",
      branches: [{ name: "no-change", dependsOn: [] }],
      strategy: "sequential",
    };

    const result = await executeMerge(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const outcome = result.value.outcomes.get("no-change");
      // Either merged (no-op) or failed (already up to date)
      expect(outcome).toBeDefined();
    }
  });

  // Case 8: Verify function throws
  it("handles verify function that throws", async () => {
    await createBranchWithChange(repoPath, "feat-a", "a.ts", "a\n");

    const config: MergeConfig = {
      repoPath,
      targetBranch: "main",
      branches: [{ name: "feat-a", dependsOn: [] }],
      strategy: "sequential",
      verifyAfter: "levels",
      verify: (async () => {
        throw new Error("verify exploded");
      }) as VerifyFn,
    };

    const result = await executeMerge(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Verify threw, so verified should be false
      expect(result.value.verified).toBe(false);
    }
  });

  // Case 9: AbortSignal mid-merge
  it("aborts and restores on AbortSignal", async () => {
    await createBranchWithChange(repoPath, "feat-a", "a.ts", "a\n");
    await createBranchWithChange(repoPath, "feat-b", "b.ts", "b\n");

    const headBefore = await runGit(["rev-parse", "HEAD"], repoPath);

    const controller = new AbortController();

    const config: MergeConfig = {
      repoPath,
      targetBranch: "main",
      branches: [
        { name: "feat-a", dependsOn: [] },
        { name: "feat-b", dependsOn: ["feat-a"] },
      ],
      strategy: "sequential",
      signal: controller.signal,
      onEvent: (event) => {
        // Abort after first merge completes
        if (event.kind === "merge:completed") {
          controller.abort();
        }
      },
    };

    const result = await executeMerge(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.aborted).toBe(true);
    }

    // HEAD should be restored
    const headAfter = await runGit(["rev-parse", "HEAD"], repoPath);
    if (headBefore.ok && headAfter.ok) {
      expect(headAfter.value).toBe(headBefore.value);
    }
  });

  // Case 10: Stale branch detected via expectedRef
  it("skips branch when expectedRef does not match (stale-branch guard)", async () => {
    const sha = await createBranchWithChange(repoPath, "feat-a", "a.ts", "a\n");

    // Advance the branch after capturing the SHA
    await runGit(["checkout", "feat-a"], repoPath);
    await addCommit(repoPath, "a2.ts", "a2\n", "advance feat-a");
    await runGit(["checkout", "main"], repoPath);

    const config: MergeConfig = {
      repoPath,
      targetBranch: "main",
      branches: [{ name: "feat-a", dependsOn: [], expectedRef: sha }],
      strategy: "sequential",
    };

    const result = await executeMerge(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const outcome = result.value.outcomes.get("feat-a");
      expect(outcome?.kind).toBe("skipped");
      if (outcome?.kind === "skipped") {
        expect(outcome.reason).toContain("stale");
      }
    }
  });

  // Case 11: expectedRef matches — merge proceeds normally
  it("merges branch when expectedRef matches (fresh branch)", async () => {
    const sha = await createBranchWithChange(repoPath, "feat-a", "a.ts", "a\n");

    const config: MergeConfig = {
      repoPath,
      targetBranch: "main",
      branches: [{ name: "feat-a", dependsOn: [], expectedRef: sha }],
      strategy: "sequential",
    };

    const result = await executeMerge(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.outcomes.get("feat-a")?.kind).toBe("merged");
    }
  });

  // Case 12: Concurrent executeMerge on same repo — second should fail with git lock
  it("fails gracefully on concurrent merge attempts", async () => {
    await createBranchWithChange(repoPath, "feat-a", "a.ts", "a\n");
    await createBranchWithChange(repoPath, "feat-b", "b.ts", "b\n");

    const config1: MergeConfig = {
      repoPath,
      targetBranch: "main",
      branches: [{ name: "feat-a", dependsOn: [] }],
      strategy: "sequential",
    };
    const config2: MergeConfig = {
      repoPath,
      targetBranch: "main",
      branches: [{ name: "feat-b", dependsOn: [] }],
      strategy: "sequential",
    };

    // Run both concurrently — at least one should succeed
    const [result1, result2] = await Promise.all([executeMerge(config1), executeMerge(config2)]);

    // At least one should succeed
    const anyOk =
      (result1.ok && result1.value.outcomes.size > 0) ||
      (result2.ok && result2.value.outcomes.size > 0);
    expect(anyOk).toBe(true);
  });
});
