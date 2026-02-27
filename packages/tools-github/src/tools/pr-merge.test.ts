import { describe, expect, test } from "bun:test";
import { createMockGhExecutor, mockError, mockSuccess, mockSuccessRaw } from "../test-helpers.js";
import { createGithubPrMergeTool } from "./pr-merge.js";

/** A valid PR status that is ready to merge. */
const MERGEABLE_STATUS = {
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
  headRefName: "feat/x",
  baseRefName: "main",
  title: "X",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
};

describe("github_pr_merge", () => {
  test("merges PR successfully with default strategy", async () => {
    const executor = createMockGhExecutor([
      mockSuccess(MERGEABLE_STATUS),
      mockSuccessRaw("Merged"),
    ]);
    const tool = createGithubPrMergeTool(executor, "github", "promoted");
    const result = await tool.execute({ pr_number: 42 });
    expect(result).toMatchObject({ merged: true });
    // Second call should be the merge command
    expect(executor.calls[1]?.args).toContain("merge");
    expect(executor.calls[1]?.args).toContain("--merge");
  });

  test("uses squash strategy", async () => {
    const executor = createMockGhExecutor([
      mockSuccess(MERGEABLE_STATUS),
      mockSuccessRaw("Merged"),
    ]);
    const tool = createGithubPrMergeTool(executor, "github", "promoted");
    await tool.execute({ pr_number: 42, strategy: "squash" });
    expect(executor.calls[1]?.args).toContain("--squash");
  });

  test("uses rebase strategy", async () => {
    const executor = createMockGhExecutor([
      mockSuccess(MERGEABLE_STATUS),
      mockSuccessRaw("Merged"),
    ]);
    const tool = createGithubPrMergeTool(executor, "github", "promoted");
    await tool.execute({ pr_number: 42, strategy: "rebase" });
    expect(executor.calls[1]?.args).toContain("--rebase");
  });

  test("passes --delete-branch when requested", async () => {
    const executor = createMockGhExecutor([
      mockSuccess(MERGEABLE_STATUS),
      mockSuccessRaw("Merged"),
    ]);
    const tool = createGithubPrMergeTool(executor, "github", "promoted");
    await tool.execute({ pr_number: 42, delete_branch: true });
    expect(executor.calls[1]?.args).toContain("--delete-branch");
  });

  test("omits --delete-branch when false", async () => {
    const executor = createMockGhExecutor([
      mockSuccess(MERGEABLE_STATUS),
      mockSuccessRaw("Merged"),
    ]);
    const tool = createGithubPrMergeTool(executor, "github", "promoted");
    await tool.execute({ pr_number: 42, delete_branch: false });
    expect(executor.calls[1]?.args).not.toContain("--delete-branch");
  });
});

describe("github_pr_merge — pre-validation", () => {
  test("rejects merge of closed PR", async () => {
    const executor = createMockGhExecutor([mockSuccess({ ...MERGEABLE_STATUS, state: "CLOSED" })]);
    const tool = createGithubPrMergeTool(executor, "github", "promoted");
    const result = await tool.execute({ pr_number: 42 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects merge of draft PR", async () => {
    const executor = createMockGhExecutor([mockSuccess({ ...MERGEABLE_STATUS, isDraft: true })]);
    const tool = createGithubPrMergeTool(executor, "github", "promoted");
    const result = await tool.execute({ pr_number: 42 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects merge with conflicts", async () => {
    const executor = createMockGhExecutor([
      mockSuccess({ ...MERGEABLE_STATUS, mergeable: "CONFLICTING" }),
    ]);
    const tool = createGithubPrMergeTool(executor, "github", "promoted");
    const result = await tool.execute({ pr_number: 42 });
    expect(result).toMatchObject({ code: "CONFLICT" });
  });

  test("rejects merge with failing CI checks", async () => {
    const executor = createMockGhExecutor([
      mockSuccess({
        ...MERGEABLE_STATUS,
        statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "FAILURE" }],
      }),
    ]);
    const tool = createGithubPrMergeTool(executor, "github", "promoted");
    const result = await tool.execute({ pr_number: 42 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns error when status check fails", async () => {
    const executor = createMockGhExecutor([mockError("NOT_FOUND", "PR not found")]);
    const tool = createGithubPrMergeTool(executor, "github", "promoted");
    const result = await tool.execute({ pr_number: 42 });
    expect(result).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("github_pr_merge — argument validation", () => {
  test("rejects missing pr_number", async () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubPrMergeTool(executor, "github", "promoted");
    const result = await tool.execute({});
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects invalid strategy", async () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubPrMergeTool(executor, "github", "promoted");
    const result = await tool.execute({ pr_number: 42, strategy: "fast-forward" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects non-boolean delete_branch", async () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubPrMergeTool(executor, "github", "promoted");
    const result = await tool.execute({ pr_number: 42, delete_branch: "yes" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("descriptor has correct name", () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubPrMergeTool(executor, "github", "promoted");
    expect(tool.descriptor.name).toBe("github_pr_merge");
  });
});
