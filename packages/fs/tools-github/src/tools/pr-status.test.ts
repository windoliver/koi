import { describe, expect, test } from "bun:test";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createMockGhExecutor, mockError, mockSuccess } from "../test-helpers.js";
import { createGithubPrStatusTool } from "./pr-status.js";

describe("github_pr_status", () => {
  test("returns PR status for a valid PR number", async () => {
    const executor = createMockGhExecutor([
      mockSuccess({
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
        headRefName: "feat/x",
        baseRefName: "main",
        title: "Add X",
        additions: 10,
        deletions: 5,
        changedFiles: 3,
      }),
    ]);
    const tool = createGithubPrStatusTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ pr_number: 42 });
    expect(result).toMatchObject({
      state: "OPEN",
      isDraft: false,
      title: "Add X",
      additions: 10,
    });
  });

  test("passes correct PR number to gh", async () => {
    const executor = createMockGhExecutor([mockSuccess({ state: "OPEN" })]);
    const tool = createGithubPrStatusTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({ pr_number: 99 });
    expect(executor.calls[0]?.args).toContain("99");
  });

  test("rejects missing pr_number", async () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubPrStatusTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({});
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects non-number pr_number", async () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubPrStatusTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ pr_number: "42" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects negative pr_number", async () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubPrStatusTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ pr_number: -1 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects non-integer pr_number", async () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubPrStatusTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ pr_number: 4.5 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns NOT_FOUND for unknown PR", async () => {
    const executor = createMockGhExecutor([
      mockError("NOT_FOUND", "Could not resolve to a PullRequest"),
    ]);
    const tool = createGithubPrStatusTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ pr_number: 9999 });
    expect(result).toMatchObject({ code: "NOT_FOUND" });
  });

  test("returns error on executor failure", async () => {
    const executor = createMockGhExecutor([mockError("EXTERNAL", "network error")]);
    const tool = createGithubPrStatusTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ pr_number: 1 });
    expect(result).toMatchObject({ code: "EXTERNAL" });
  });

  test("returns error on JSON parse failure", async () => {
    const executor = createMockGhExecutor([{ result: { ok: true, value: "not json" } }]);
    const tool = createGithubPrStatusTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ pr_number: 1 });
    expect(result).toMatchObject({ code: "EXTERNAL" });
  });

  test("descriptor has correct name with custom prefix", () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubPrStatusTool(executor, "gh", DEFAULT_UNSANDBOXED_POLICY);
    expect(tool.descriptor.name).toBe("gh_pr_status");
  });
});
