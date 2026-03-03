import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { executeMerge } from "../execute-merge.js";
import type { MergeConfig, MergeEvent } from "../types.js";
import { createBranchWithChange, createTestRepo } from "./helpers.js";

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

describe("executeMerge (integration)", () => {
  it("merges 3 independent branches with sequential strategy", async () => {
    await createBranchWithChange(repoPath, "feat-a", "a.ts", "a\n");
    await createBranchWithChange(repoPath, "feat-b", "b.ts", "b\n");
    await createBranchWithChange(repoPath, "feat-c", "c.ts", "c\n");

    const config: MergeConfig = {
      repoPath,
      targetBranch: "main",
      branches: [
        { name: "feat-a", dependsOn: [] },
        { name: "feat-b", dependsOn: [] },
        { name: "feat-c", dependsOn: [] },
      ],
      strategy: "sequential",
    };

    const result = await executeMerge(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.outcomes.size).toBe(3);
      expect(result.value.aborted).toBe(false);
      expect(result.value.verified).toBe(true);
      for (const [, outcome] of result.value.outcomes) {
        expect(outcome.kind).toBe("merged");
      }
    }
  });

  it("merges branches with dependencies in correct order", async () => {
    await createBranchWithChange(repoPath, "base", "base.ts", "base\n");
    await createBranchWithChange(repoPath, "derived", "derived.ts", "derived\n");

    const config: MergeConfig = {
      repoPath,
      targetBranch: "main",
      branches: [
        { name: "derived", dependsOn: ["base"] },
        { name: "base", dependsOn: [] },
      ],
      strategy: "sequential",
    };

    const result = await executeMerge(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mergeOrder).toEqual(["base", "derived"]);
      expect(result.value.outcomes.size).toBe(2);
    }
  });

  it("collects onEvent callbacks", async () => {
    await createBranchWithChange(repoPath, "feat-a", "a.ts", "a\n");

    const events: MergeEvent[] = [];
    const config: MergeConfig = {
      repoPath,
      targetBranch: "main",
      branches: [{ name: "feat-a", dependsOn: [] }],
      strategy: "sequential",
      onEvent: (event) => {
        events.push(event);
      },
    };

    await executeMerge(config);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("level:started");
    expect(kinds).toContain("merge:started");
    expect(kinds).toContain("merge:completed");
    expect(kinds).toContain("level:completed");
  });

  it("runs verify after levels", async () => {
    await createBranchWithChange(repoPath, "feat-a", "a.ts", "a\n");

    let verifyCalled = false;
    const config: MergeConfig = {
      repoPath,
      targetBranch: "main",
      branches: [{ name: "feat-a", dependsOn: [] }],
      strategy: "sequential",
      verifyAfter: "levels",
      verify: async () => {
        verifyCalled = true;
        return { passed: true };
      },
    };

    const result = await executeMerge(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.verified).toBe(true);
    }
    expect(verifyCalled).toBe(true);
  });

  it("reverts on verify failure", async () => {
    const { runGit } = await import("@koi/git-utils");
    await createBranchWithChange(repoPath, "feat-a", "a.ts", "a\n");

    // Get initial HEAD
    const headBefore = await runGit(["rev-parse", "HEAD"], repoPath);

    const config: MergeConfig = {
      repoPath,
      targetBranch: "main",
      branches: [{ name: "feat-a", dependsOn: [] }],
      strategy: "sequential",
      verifyAfter: "levels",
      verify: async () => ({ passed: false, message: "tests failed" }),
    };

    const result = await executeMerge(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.verified).toBe(false);
    }

    // HEAD should be restored
    const headAfter = await runGit(["rev-parse", "HEAD"], repoPath);
    expect(headAfter.ok && headBefore.ok && headAfter.value).toBe(
      headBefore.ok ? headBefore.value : "unreachable",
    );
  });

  it("uses octopus strategy for independent branches", async () => {
    await createBranchWithChange(repoPath, "feat-a", "a.ts", "a\n");
    await createBranchWithChange(repoPath, "feat-b", "b.ts", "b\n");

    const config: MergeConfig = {
      repoPath,
      targetBranch: "main",
      branches: [
        { name: "feat-a", dependsOn: [] },
        { name: "feat-b", dependsOn: [] },
      ],
      strategy: "octopus",
    };

    const result = await executeMerge(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.strategy).toBe("octopus");
      expect(result.value.outcomes.size).toBe(2);
    }
  });

  it("handles 5 branches with deps using sequential + verify:levels", async () => {
    await createBranchWithChange(repoPath, "core", "core.ts", "core\n");
    await createBranchWithChange(repoPath, "api", "api.ts", "api\n");
    await createBranchWithChange(repoPath, "ui", "ui.ts", "ui\n");
    await createBranchWithChange(repoPath, "tests", "tests.ts", "tests\n");
    await createBranchWithChange(repoPath, "docs", "docs.ts", "docs\n");

    let verifyCount = 0;
    const config: MergeConfig = {
      repoPath,
      targetBranch: "main",
      branches: [
        { name: "core", dependsOn: [] },
        { name: "api", dependsOn: ["core"] },
        { name: "ui", dependsOn: ["core"] },
        { name: "tests", dependsOn: ["api", "ui"] },
        { name: "docs", dependsOn: [] },
      ],
      strategy: "sequential",
      verifyAfter: "levels",
      verify: async () => {
        verifyCount++;
        return { passed: true };
      },
    };

    const result = await executeMerge(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.outcomes.size).toBe(5);
      expect(result.value.verified).toBe(true);
      // Levels: [core, docs], [api, ui], [tests] = 3 levels
      expect(verifyCount).toBe(3);
    }
  });
});
