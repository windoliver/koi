import { describe, expect, test } from "bun:test";
import { parseGhError, parseGhJson } from "./parse-gh-error.js";

describe("parseGhError", () => {
  test("maps exit code 4 to PERMISSION", () => {
    const error = parseGhError("insufficient scope", 4, ["pr", "create"]);
    expect(error.code).toBe("PERMISSION");
    expect(error.retryable).toBe(false);
  });

  test("maps rate limit stderr to RATE_LIMIT", () => {
    const error = parseGhError("API rate limit exceeded", 1, ["pr", "view"]);
    expect(error.code).toBe("RATE_LIMIT");
    expect(error.retryable).toBe(true);
  });

  test("maps not found stderr to NOT_FOUND", () => {
    const error = parseGhError("Could not resolve to a PullRequest: not found", 1, [
      "pr",
      "view",
      "999",
    ]);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.retryable).toBe(false);
  });

  test("maps already exists stderr to CONFLICT", () => {
    const error = parseGhError("a pull request already exists for branch feature/x", 1, [
      "pr",
      "create",
    ]);
    expect(error.code).toBe("CONFLICT");
    expect(error.retryable).toBe(false);
  });

  test("maps merge conflict stderr to CONFLICT", () => {
    const error = parseGhError("merge conflict detected", 1, ["pr", "merge", "42"]);
    expect(error.code).toBe("CONFLICT");
    expect(error.retryable).toBe(false);
  });

  test("maps not mergeable stderr to VALIDATION", () => {
    const error = parseGhError("Pull request is not mergeable", 1, ["pr", "merge", "42"]);
    expect(error.code).toBe("VALIDATION");
    expect(error.retryable).toBe(false);
  });

  test("defaults to EXTERNAL for unknown errors", () => {
    const error = parseGhError("something unexpected", 1, ["pr", "view"]);
    expect(error.code).toBe("EXTERNAL");
    expect(error.retryable).toBe(false);
  });

  test("includes command in context", () => {
    const error = parseGhError("error", 1, ["pr", "view", "42"]);
    expect(error.context).toMatchObject({ command: "gh pr view 42" });
  });

  test("handles empty stderr gracefully", () => {
    const error = parseGhError("", 1, ["pr", "view"]);
    expect(error.code).toBe("EXTERNAL");
    expect(error.message).toContain("exit code 1");
  });

  test("exit code 4 takes precedence over stderr patterns", () => {
    const error = parseGhError("not found", 4, ["pr", "view"]);
    expect(error.code).toBe("PERMISSION");
  });
});

describe("parseGhJson", () => {
  test("parses valid JSON", () => {
    const result = parseGhJson('{"number": 42}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ number: 42 });
    }
  });

  test("returns error for invalid JSON", () => {
    const result = parseGhJson("not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.retryable).toBe(false);
    }
  });

  test("parses empty object", () => {
    const result = parseGhJson("{}");
    expect(result.ok).toBe(true);
  });

  test("parses array", () => {
    const result = parseGhJson("[1, 2, 3]");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([1, 2, 3]);
    }
  });
});
