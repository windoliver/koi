import { describe, expect, test } from "bun:test";
import { createMockGhExecutor, mockError, mockSuccess } from "../test-helpers.js";
import { createGithubCiWaitTool } from "./ci-wait.js";

const PENDING_CHECKS = {
  statusCheckRollup: [{ name: "ci", status: "IN_PROGRESS", conclusion: null }],
};

const SUCCESS_CHECKS = {
  statusCheckRollup: [
    { name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
  ],
};

const FAILURE_CHECKS = {
  statusCheckRollup: [
    { name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
  ],
};

const MIXED_CHECKS = {
  statusCheckRollup: [
    { name: "ci", status: "COMPLETED", conclusion: "FAILURE" },
    { name: "lint", status: "IN_PROGRESS", conclusion: null },
  ],
};

describe("github_ci_wait — happy paths", () => {
  test("returns success when all checks pass immediately", async () => {
    const executor = createMockGhExecutor([mockSuccess(SUCCESS_CHECKS)]);
    const tool = createGithubCiWaitTool(executor, "github", "verified");
    const result = (await tool.execute({ pr_number: 42, poll_interval_ms: 1 })) as Record<
      string,
      unknown
    >;
    expect(result.status).toBe("success");
    expect(result.elapsed_ms).toEqual(expect.any(Number));
    expect(Array.isArray(result.checks)).toBe(true);
  });

  test("returns success when no checks configured", async () => {
    const executor = createMockGhExecutor([mockSuccess({ statusCheckRollup: [] })]);
    const tool = createGithubCiWaitTool(executor, "github", "verified");
    const result = (await tool.execute({ pr_number: 42, poll_interval_ms: 1 })) as Record<
      string,
      unknown
    >;
    expect(result.status).toBe("success");
  });

  test("returns success when statusCheckRollup is missing", async () => {
    const executor = createMockGhExecutor([mockSuccess({})]);
    const tool = createGithubCiWaitTool(executor, "github", "verified");
    const result = (await tool.execute({ pr_number: 42, poll_interval_ms: 1 })) as Record<
      string,
      unknown
    >;
    expect(result.status).toBe("success");
  });

  test("returns failure when checks fail", async () => {
    const executor = createMockGhExecutor([mockSuccess(FAILURE_CHECKS)]);
    const tool = createGithubCiWaitTool(executor, "github", "verified");
    const result = (await tool.execute({ pr_number: 42, poll_interval_ms: 1 })) as Record<
      string,
      unknown
    >;
    expect(result.status).toBe("failure");
  });
});

describe("github_ci_wait — polling", () => {
  test("polls until checks complete", async () => {
    const executor = createMockGhExecutor([
      mockSuccess(PENDING_CHECKS),
      mockSuccess(SUCCESS_CHECKS),
    ]);
    const tool = createGithubCiWaitTool(executor, "github", "verified");
    const result = (await tool.execute({
      pr_number: 42,
      poll_interval_ms: 1,
      timeout_ms: 60000,
    })) as Record<string, unknown>;
    expect(result.status).toBe("success");
    expect(executor.calls.length).toBe(2);
  });

  test("returns timeout when deadline exceeded", async () => {
    const executor = createMockGhExecutor([mockSuccess(PENDING_CHECKS)]);
    const tool = createGithubCiWaitTool(executor, "github", "verified");
    const result = (await tool.execute({
      pr_number: 42,
      timeout_ms: 1,
      poll_interval_ms: 100,
    })) as Record<string, unknown>;
    expect(result.status).toBe("timeout");
  });

  test("fail_fast stops on first failure", async () => {
    const executor = createMockGhExecutor([mockSuccess(MIXED_CHECKS)]);
    const tool = createGithubCiWaitTool(executor, "github", "verified");
    const result = (await tool.execute({
      pr_number: 42,
      fail_fast: true,
      poll_interval_ms: 1,
    })) as Record<string, unknown>;
    expect(result.status).toBe("failure");
    // Should stop after first poll since fail_fast is true
    expect(executor.calls.length).toBe(1);
  });
});

describe("github_ci_wait — argument validation", () => {
  test("rejects missing pr_number", async () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubCiWaitTool(executor, "github", "verified");
    const result = await tool.execute({});
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects non-number pr_number", async () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubCiWaitTool(executor, "github", "verified");
    const result = await tool.execute({ pr_number: "42" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects timeout_ms below minimum", async () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubCiWaitTool(executor, "github", "verified");
    const result = await tool.execute({ pr_number: 42, timeout_ms: 0 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects timeout_ms above maximum", async () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubCiWaitTool(executor, "github", "verified");
    const result = await tool.execute({ pr_number: 42, timeout_ms: 99_999_999 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects poll_interval_ms below minimum", async () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubCiWaitTool(executor, "github", "verified");
    const result = await tool.execute({ pr_number: 42, poll_interval_ms: 0 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects non-boolean fail_fast", async () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubCiWaitTool(executor, "github", "verified");
    const result = await tool.execute({ pr_number: 42, fail_fast: "yes" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });
});

describe("github_ci_wait — error handling", () => {
  test("returns error when PR not found", async () => {
    const executor = createMockGhExecutor([mockError("NOT_FOUND", "PR not found")]);
    const tool = createGithubCiWaitTool(executor, "github", "verified");
    const result = await tool.execute({ pr_number: 9999, poll_interval_ms: 1 });
    expect(result).toMatchObject({ code: "NOT_FOUND" });
  });

  test("returns error on executor failure", async () => {
    const executor = createMockGhExecutor([mockError("EXTERNAL", "network error")]);
    const tool = createGithubCiWaitTool(executor, "github", "verified");
    const result = await tool.execute({ pr_number: 42, poll_interval_ms: 1 });
    expect(result).toMatchObject({ code: "EXTERNAL" });
  });

  test("descriptor has correct name", () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubCiWaitTool(executor, "github", "verified");
    expect(tool.descriptor.name).toBe("github_ci_wait");
  });

  test("trust tier is verified", () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubCiWaitTool(executor, "github", "verified");
    expect(tool.trustTier).toBe("verified");
  });
});
