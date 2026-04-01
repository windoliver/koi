import { describe, expect, test } from "bun:test";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createMockGhExecutor, mockError, mockSuccess, mockSuccessRaw } from "../test-helpers.js";
import { createGithubPrReviewTool } from "./pr-review.js";

describe("github_pr_review — read", () => {
  test("reads reviews for a PR", async () => {
    const executor = createMockGhExecutor([
      mockSuccess({
        reviews: [{ author: { login: "reviewer" }, state: "APPROVED", body: "LGTM" }],
        latestReviews: [{ author: { login: "reviewer" }, state: "APPROVED" }],
        reviewDecision: "APPROVED",
      }),
    ]);
    const tool = createGithubPrReviewTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ pr_number: 10, action: "read" });
    expect(result).toMatchObject({ reviewDecision: "APPROVED" });
  });

  test("passes correct args for read action", async () => {
    const executor = createMockGhExecutor([mockSuccess({ reviewDecision: "APPROVED" })]);
    const tool = createGithubPrReviewTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({ pr_number: 10, action: "read" });
    expect(executor.calls[0]?.args).toContain("view");
    expect(executor.calls[0]?.args).toContain("10");
    expect(executor.calls[0]?.args).toContain("--json");
  });

  test("returns NOT_FOUND for unknown PR", async () => {
    const executor = createMockGhExecutor([mockError("NOT_FOUND", "not found")]);
    const tool = createGithubPrReviewTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ pr_number: 9999, action: "read" });
    expect(result).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("github_pr_review — post", () => {
  test("posts APPROVE review", async () => {
    const executor = createMockGhExecutor([mockSuccessRaw("Approved")]);
    const tool = createGithubPrReviewTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ pr_number: 10, action: "post", event: "APPROVE" });
    expect(result).toMatchObject({ success: true });
    expect(executor.calls[0]?.args).toContain("--approve");
  });

  test("posts REQUEST_CHANGES review with body", async () => {
    const executor = createMockGhExecutor([mockSuccessRaw("Changes requested")]);
    const tool = createGithubPrReviewTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({
      pr_number: 10,
      action: "post",
      event: "REQUEST_CHANGES",
      body: "Please fix the tests",
    });
    expect(result).toMatchObject({ success: true });
    expect(executor.calls[0]?.args).toContain("--request-changes");
    expect(executor.calls[0]?.args).toContain("--body");
  });

  test("posts COMMENT review with body", async () => {
    const executor = createMockGhExecutor([mockSuccessRaw("Commented")]);
    const tool = createGithubPrReviewTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({
      pr_number: 10,
      action: "post",
      body: "Nice work!",
    });
    expect(result).toMatchObject({ success: true });
    expect(executor.calls[0]?.args).toContain("--comment");
    expect(executor.calls[0]?.args).toContain("--body");
  });

  test("defaults to COMMENT when no event specified", async () => {
    const executor = createMockGhExecutor([mockSuccessRaw("Commented")]);
    const tool = createGithubPrReviewTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({ pr_number: 10, action: "post", body: "Hello" });
    expect(executor.calls[0]?.args).toContain("--comment");
  });

  test("rejects REQUEST_CHANGES without body", async () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubPrReviewTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({
      pr_number: 10,
      action: "post",
      event: "REQUEST_CHANGES",
    });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects REQUEST_CHANGES with empty body", async () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubPrReviewTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({
      pr_number: 10,
      action: "post",
      event: "REQUEST_CHANGES",
      body: "",
    });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns error on executor failure", async () => {
    const executor = createMockGhExecutor([mockError("PERMISSION", "no permission")]);
    const tool = createGithubPrReviewTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ pr_number: 10, action: "post", event: "APPROVE" });
    expect(result).toMatchObject({ code: "PERMISSION" });
  });
});

describe("github_pr_review — validation", () => {
  test("rejects missing pr_number", async () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubPrReviewTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ action: "read" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects missing action", async () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubPrReviewTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ pr_number: 10 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects invalid action", async () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubPrReviewTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ pr_number: 10, action: "delete" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects invalid event type", async () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubPrReviewTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ pr_number: 10, action: "post", event: "REJECT" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("descriptor has correct name", () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubPrReviewTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    expect(tool.descriptor.name).toBe("github_pr_review");
  });
});
