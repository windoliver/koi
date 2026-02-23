import { describe, expect, test } from "bun:test";
import { validateConfig } from "./config.js";

describe("validateConfig", () => {
  test("accepts valid config with both soul and user", () => {
    const result = validateConfig({
      soul: "./SOUL.md",
      user: "./USER.md",
      basePath: "/tmp/agent",
    });
    expect(result.ok).toBe(true);
  });

  test("accepts config with soul only", () => {
    const result = validateConfig({
      soul: "./SOUL.md",
      basePath: "/tmp/agent",
    });
    expect(result.ok).toBe(true);
  });

  test("accepts config with user only", () => {
    const result = validateConfig({
      user: "./USER.md",
      basePath: "/tmp/agent",
    });
    expect(result.ok).toBe(true);
  });

  test("accepts config with neither soul nor user (no-op middleware)", () => {
    const result = validateConfig({
      basePath: "/tmp/agent",
    });
    expect(result.ok).toBe(true);
  });

  test("accepts soul as object with path and maxTokens", () => {
    const result = validateConfig({
      soul: { path: "./soul/", maxTokens: 2000 },
      basePath: "/tmp/agent",
    });
    expect(result.ok).toBe(true);
  });

  test("accepts user as object with path and maxTokens", () => {
    const result = validateConfig({
      user: { path: "./USER.md", maxTokens: 1000 },
      basePath: "/tmp/agent",
    });
    expect(result.ok).toBe(true);
  });

  test("rejects null config", () => {
    const result = validateConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects undefined config", () => {
    const result = validateConfig(undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects missing basePath", () => {
    const result = validateConfig({ soul: "./SOUL.md" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("basePath");
  });

  test("rejects empty basePath", () => {
    const result = validateConfig({ soul: "./SOUL.md", basePath: "" });
    expect(result.ok).toBe(false);
  });

  test("rejects soul with invalid type (number)", () => {
    const result = validateConfig({ soul: 42, basePath: "/tmp" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("soul");
  });

  test("rejects soul object without path", () => {
    const result = validateConfig({
      soul: { maxTokens: 2000 },
      basePath: "/tmp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("soul.path");
  });

  test("rejects negative soul.maxTokens", () => {
    const result = validateConfig({
      soul: { path: "./SOUL.md", maxTokens: -1 },
      basePath: "/tmp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("maxTokens");
  });

  test("rejects zero soul.maxTokens", () => {
    const result = validateConfig({
      soul: { path: "./SOUL.md", maxTokens: 0 },
      basePath: "/tmp",
    });
    expect(result.ok).toBe(false);
  });

  test("rejects user with invalid type (number)", () => {
    const result = validateConfig({ user: 42, basePath: "/tmp" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("user");
  });

  test("rejects user object without path", () => {
    const result = validateConfig({
      user: { maxTokens: 1000 },
      basePath: "/tmp",
    });
    expect(result.ok).toBe(false);
  });

  test("rejects negative user.maxTokens", () => {
    const result = validateConfig({
      user: { path: "./USER.md", maxTokens: -5 },
      basePath: "/tmp",
    });
    expect(result.ok).toBe(false);
  });

  test("rejects non-boolean refreshUser", () => {
    const result = validateConfig({
      basePath: "/tmp",
      refreshUser: "yes",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("refreshUser");
  });

  test("accepts boolean refreshUser", () => {
    const result = validateConfig({
      basePath: "/tmp",
      refreshUser: true,
    });
    expect(result.ok).toBe(true);
  });

  test("error is non-retryable", () => {
    const result = validateConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.retryable).toBe(false);
  });
});
