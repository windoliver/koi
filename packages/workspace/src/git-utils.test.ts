import { describe, expect, it } from "bun:test";
import { parseGitError, resolveWorktreeBasePath } from "./git-utils.js";

describe("parseGitError", () => {
  it("maps 'already exists' to CONFLICT", () => {
    const err = parseGitError("fatal: branch 'foo' already exists", ["branch", "-b", "foo"]);
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toContain("already exists");
  });

  it("maps 'not a git repository' to VALIDATION", () => {
    const err = parseGitError("fatal: not a git repository (or any parent)", ["status"]);
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("not a git repository");
  });

  it("maps 'not found' to NOT_FOUND", () => {
    const err = parseGitError(
      "error: pathspec 'foo' did not match any file(s) known to git. Did you mean 'bar'? file not found",
      ["checkout", "foo"],
    );
    expect(err.code).toBe("NOT_FOUND");
  });

  it("maps 'does not exist' to NOT_FOUND", () => {
    const err = parseGitError("error: branch 'foo' does not exist", ["branch", "-D", "foo"]);
    expect(err.code).toBe("NOT_FOUND");
  });

  it("maps generic stderr to EXTERNAL", () => {
    const err = parseGitError("some unknown error", ["push"]);
    expect(err.code).toBe("EXTERNAL");
    expect(err.message).toContain("git push failed");
  });

  it("includes command in context", () => {
    const err = parseGitError("error", ["worktree", "add", "/path"]);
    expect(err.context).toEqual({ command: "git worktree add /path" });
  });
});

describe("resolveWorktreeBasePath", () => {
  it("returns explicit path when provided", () => {
    expect(resolveWorktreeBasePath("/repos/myrepo", "/custom/base")).toBe("/custom/base");
  });

  it("derives path from repo name when no explicit path", () => {
    const result = resolveWorktreeBasePath("/repos/myrepo");
    expect(result).toBe("/repos/myrepo/../myrepo-workspaces");
  });

  it("handles repo path ending with slash", () => {
    // path.split("/").pop() on trailing slash gives ""
    const result = resolveWorktreeBasePath("/repos/myrepo/");
    // pop() returns "" for trailing slash, fallback to "repo"
    expect(result).toContain("-workspaces");
  });

  it("falls back to 'repo' for edge case paths", () => {
    const result = resolveWorktreeBasePath("/");
    expect(result).toContain("repo-workspaces");
  });
});
