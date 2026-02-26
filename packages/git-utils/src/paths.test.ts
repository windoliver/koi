import { describe, expect, it } from "bun:test";
import { resolveWorktreeBasePath } from "./paths.js";

describe("resolveWorktreeBasePath", () => {
  it("returns explicit path when provided", () => {
    expect(resolveWorktreeBasePath("/repos/myrepo", "/custom/base")).toBe("/custom/base");
  });

  it("derives path from repo name when no explicit path", () => {
    const result = resolveWorktreeBasePath("/repos/myrepo");
    expect(result).toBe("/repos/myrepo/../myrepo-workspaces");
  });

  it("handles repo path ending with slash", () => {
    const result = resolveWorktreeBasePath("/repos/myrepo/");
    expect(result).toContain("-workspaces");
  });

  it("falls back to 'repo' for edge case paths", () => {
    const result = resolveWorktreeBasePath("/");
    expect(result).toContain("repo-workspaces");
  });
});
