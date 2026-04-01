import { describe, expect, test } from "bun:test";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createMockGhExecutor, mockError, mockSuccess } from "../test-helpers.js";
import { createGithubPrCreateTool } from "./pr-create.js";

describe("github_pr_create", () => {
  test("creates PR with title and body", async () => {
    const executor = createMockGhExecutor([
      mockSuccess({
        number: 42,
        url: "https://github.com/org/repo/pull/42",
        headRefName: "feat/x",
      }),
    ]);
    const tool = createGithubPrCreateTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ title: "Add feature X", body: "Description" });
    expect(result).toMatchObject({ number: 42, url: expect.any(String), headRefName: "feat/x" });
  });

  test("passes --title and --body to gh", async () => {
    const executor = createMockGhExecutor([mockSuccess({ number: 1, url: "u", headRefName: "b" })]);
    const tool = createGithubPrCreateTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({ title: "T", body: "B" });
    expect(executor.calls[0]?.args).toContain("--title");
    expect(executor.calls[0]?.args).toContain("T");
    expect(executor.calls[0]?.args).toContain("--body");
    expect(executor.calls[0]?.args).toContain("B");
  });

  test("uses --fill when no title provided", async () => {
    const executor = createMockGhExecutor([mockSuccess({ number: 1, url: "u", headRefName: "b" })]);
    const tool = createGithubPrCreateTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({});
    expect(executor.calls[0]?.args).toContain("--fill");
    expect(executor.calls[0]?.args).not.toContain("--title");
  });

  test("passes --base when base specified", async () => {
    const executor = createMockGhExecutor([mockSuccess({ number: 1, url: "u", headRefName: "b" })]);
    const tool = createGithubPrCreateTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({ title: "T", base: "develop" });
    expect(executor.calls[0]?.args).toContain("--base");
    expect(executor.calls[0]?.args).toContain("develop");
  });

  test("passes --head when head specified", async () => {
    const executor = createMockGhExecutor([mockSuccess({ number: 1, url: "u", headRefName: "b" })]);
    const tool = createGithubPrCreateTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({ title: "T", head: "feature/y" });
    expect(executor.calls[0]?.args).toContain("--head");
    expect(executor.calls[0]?.args).toContain("feature/y");
  });

  test("passes --draft when draft=true", async () => {
    const executor = createMockGhExecutor([mockSuccess({ number: 1, url: "u", headRefName: "b" })]);
    const tool = createGithubPrCreateTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({ title: "T", draft: true });
    expect(executor.calls[0]?.args).toContain("--draft");
  });

  test("omits --draft when draft=false", async () => {
    const executor = createMockGhExecutor([mockSuccess({ number: 1, url: "u", headRefName: "b" })]);
    const tool = createGithubPrCreateTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({ title: "T", draft: false });
    expect(executor.calls[0]?.args).not.toContain("--draft");
  });

  test("rejects non-string title", async () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubPrCreateTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ title: 123 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects non-boolean draft", async () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubPrCreateTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ draft: "yes" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns error when PR already exists", async () => {
    const executor = createMockGhExecutor([mockError("CONFLICT", "a]pull request already exists")]);
    const tool = createGithubPrCreateTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ title: "T" });
    expect(result).toMatchObject({ code: "CONFLICT" });
  });

  test("returns error on executor failure", async () => {
    const executor = createMockGhExecutor([mockError("EXTERNAL", "gh pr create failed")]);
    const tool = createGithubPrCreateTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ title: "T" });
    expect(result).toMatchObject({ code: "EXTERNAL" });
  });

  test("returns error on JSON parse failure", async () => {
    const executor = createMockGhExecutor([{ result: { ok: true, value: "not json" } }]);
    const tool = createGithubPrCreateTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ title: "T" });
    expect(result).toMatchObject({ code: "EXTERNAL" });
  });

  test("descriptor has correct name with custom prefix", () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubPrCreateTool(executor, "gh", DEFAULT_UNSANDBOXED_POLICY);
    expect(tool.descriptor.name).toBe("gh_pr_create");
  });

  test("trust tier is set correctly", () => {
    const executor = createMockGhExecutor([]);
    const tool = createGithubPrCreateTool(executor, "github", DEFAULT_UNSANDBOXED_POLICY);
    expect(tool.policy.sandbox).toBe(false);
  });
});
