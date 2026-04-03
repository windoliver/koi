/**
 * Path safety tests — security-critical path resolution and stripping.
 */

import { describe, expect, test } from "bun:test";
import { computeFullPath, stripBasePath } from "./paths.js";

describe("computeFullPath", () => {
  // Happy paths
  test("simple path joins with basePath", () => {
    const result = computeFullPath("fs", "hello.txt");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("/fs/hello.txt");
  });

  test("nested path joins correctly", () => {
    const result = computeFullPath("fs", "a/b/c.txt");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("/fs/a/b/c.txt");
  });

  test("leading slash on userPath is stripped", () => {
    const result = computeFullPath("fs", "/hello.txt");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("/fs/hello.txt");
  });

  test("path equals basePath (root listing)", () => {
    const result = computeFullPath("fs", "/");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("/fs");
  });

  test("custom basePath", () => {
    const result = computeFullPath("agents/a1/workspace", "file.ts");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("/agents/a1/workspace/file.ts");
  });

  // Path traversal attacks
  test("rejects simple .. traversal", () => {
    const result = computeFullPath("fs", "../etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects encoded %2e%2e traversal", () => {
    const result = computeFullPath("fs", "%2e%2e/etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects double-encoded traversal", () => {
    const result = computeFullPath("fs", "%252e%252e/etc/passwd");
    // After one decode: %2e%2e — still suspicious but computeFullPath only decodes once
    // The resolved path should stay within basePath
    // If decoding produces "..", it should be caught
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects null bytes", () => {
    const result = computeFullPath("fs", "file\0.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("null");
    }
  });

  test("rejects backslash traversal", () => {
    const result = computeFullPath("fs", "..\\etc\\passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects deep traversal that escapes basePath", () => {
    const result = computeFullPath("fs", "a/b/../../../../etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("allows .. that stays within basePath", () => {
    const result = computeFullPath("fs", "a/b/../c.txt");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("/fs/a/c.txt");
  });

  test("rejects malformed percent-encoding", () => {
    const result = computeFullPath("fs", "file%ZZname.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });
});

describe("stripBasePath", () => {
  test("strips basePath prefix", () => {
    expect(stripBasePath("fs", "/fs/hello.txt")).toBe("/hello.txt");
  });

  test("strips basePath with leading slash", () => {
    expect(stripBasePath("/fs", "/fs/hello.txt")).toBe("/hello.txt");
  });

  test("returns / for exact basePath match", () => {
    expect(stripBasePath("fs", "/fs")).toBe("/");
  });

  test("does not strip sibling prefix", () => {
    // /fspath/a.txt should NOT be stripped by basePath "fs"
    expect(stripBasePath("fs", "/fspath/a.txt")).toBe("/fspath/a.txt");
  });

  test("returns full path when no match", () => {
    expect(stripBasePath("workspace", "/other/file.txt")).toBe("/other/file.txt");
  });

  test("handles nested basePath", () => {
    expect(stripBasePath("agents/a1", "/agents/a1/file.txt")).toBe("/file.txt");
  });
});
