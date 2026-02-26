import { describe, expect, test } from "bun:test";
import { validateSoulConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Basic valid configs
// ---------------------------------------------------------------------------

describe("validateSoulConfig — valid configs", () => {
  test("accepts valid config with all three layers", () => {
    const result = validateSoulConfig({
      soul: "./SOUL.md",
      identity: { personas: [{ channelId: "@koi/channel-telegram", name: "Alex" }] },
      user: "./USER.md",
      basePath: "/tmp/agent",
    });
    expect(result.ok).toBe(true);
  });

  test("accepts config with soul only", () => {
    const result = validateSoulConfig({
      soul: "./SOUL.md",
      basePath: "/tmp/agent",
    });
    expect(result.ok).toBe(true);
  });

  test("accepts config with user only", () => {
    const result = validateSoulConfig({
      user: "./USER.md",
      basePath: "/tmp/agent",
    });
    expect(result.ok).toBe(true);
  });

  test("accepts config with identity only", () => {
    const result = validateSoulConfig({
      identity: { personas: [{ channelId: "@koi/channel-slack" }] },
      basePath: "/tmp/agent",
    });
    expect(result.ok).toBe(true);
  });

  test("accepts config with no layers (no-op middleware)", () => {
    const result = validateSoulConfig({
      basePath: "/tmp/agent",
    });
    expect(result.ok).toBe(true);
  });

  test("accepts soul as object with path and maxTokens", () => {
    const result = validateSoulConfig({
      soul: { path: "./soul/", maxTokens: 2000 },
      basePath: "/tmp/agent",
    });
    expect(result.ok).toBe(true);
  });

  test("accepts user as object with path and maxTokens", () => {
    const result = validateSoulConfig({
      user: { path: "./USER.md", maxTokens: 1000 },
      basePath: "/tmp/agent",
    });
    expect(result.ok).toBe(true);
  });

  test("accepts boolean refreshUser", () => {
    const result = validateSoulConfig({
      basePath: "/tmp",
      refreshUser: true,
    });
    expect(result.ok).toBe(true);
  });

  test("accepts identity with empty personas array", () => {
    const result = validateSoulConfig({
      identity: { personas: [] },
      basePath: "/tmp",
    });
    expect(result.ok).toBe(true);
  });

  test("accepts persona with instruction path object", () => {
    const result = validateSoulConfig({
      identity: {
        personas: [{ channelId: "@koi/channel-telegram", instructions: { path: "./persona.md" } }],
      },
      basePath: "/tmp",
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invalid configs — top-level
// ---------------------------------------------------------------------------

describe("validateSoulConfig — invalid top-level", () => {
  test("rejects null config", () => {
    const result = validateSoulConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects undefined config", () => {
    const result = validateSoulConfig(undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects missing basePath", () => {
    const result = validateSoulConfig({ soul: "./SOUL.md" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("basePath");
  });

  test("rejects empty basePath", () => {
    const result = validateSoulConfig({ soul: "./SOUL.md", basePath: "" });
    expect(result.ok).toBe(false);
  });

  test("rejects non-boolean refreshUser", () => {
    const result = validateSoulConfig({
      basePath: "/tmp",
      refreshUser: "yes",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("refreshUser");
  });

  test("error is non-retryable", () => {
    const result = validateSoulConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invalid soul/user fields
// ---------------------------------------------------------------------------

describe("validateSoulConfig — invalid soul/user", () => {
  test("rejects soul with invalid type (number)", () => {
    const result = validateSoulConfig({ soul: 42, basePath: "/tmp" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("soul");
  });

  test("rejects soul object without path", () => {
    const result = validateSoulConfig({
      soul: { maxTokens: 2000 },
      basePath: "/tmp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("soul.path");
  });

  test("rejects negative soul.maxTokens", () => {
    const result = validateSoulConfig({
      soul: { path: "./SOUL.md", maxTokens: -1 },
      basePath: "/tmp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("maxTokens");
  });

  test("rejects zero soul.maxTokens", () => {
    const result = validateSoulConfig({
      soul: { path: "./SOUL.md", maxTokens: 0 },
      basePath: "/tmp",
    });
    expect(result.ok).toBe(false);
  });

  test("rejects user with invalid type (number)", () => {
    const result = validateSoulConfig({ user: 42, basePath: "/tmp" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("user");
  });

  test("rejects user object without path", () => {
    const result = validateSoulConfig({
      user: { maxTokens: 1000 },
      basePath: "/tmp",
    });
    expect(result.ok).toBe(false);
  });

  test("rejects negative user.maxTokens", () => {
    const result = validateSoulConfig({
      user: { path: "./USER.md", maxTokens: -5 },
      basePath: "/tmp",
    });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invalid identity fields
// ---------------------------------------------------------------------------

describe("validateSoulConfig — invalid identity", () => {
  test("rejects identity as non-object", () => {
    const result = validateSoulConfig({
      identity: "not an object",
      basePath: "/tmp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("identity");
  });

  test("rejects identity without personas array", () => {
    const result = validateSoulConfig({
      identity: {},
      basePath: "/tmp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("personas");
  });

  test("rejects identity.personas as non-array", () => {
    const result = validateSoulConfig({
      identity: { personas: "not an array" },
      basePath: "/tmp",
    });
    expect(result.ok).toBe(false);
  });

  test("rejects persona entry that is not an object", () => {
    const result = validateSoulConfig({
      identity: { personas: ["bad"] },
      basePath: "/tmp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("personas[0]");
  });

  test("rejects persona with missing channelId", () => {
    const result = validateSoulConfig({
      identity: { personas: [{ name: "Alex" }] },
      basePath: "/tmp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("channelId");
  });

  test("rejects persona with empty channelId", () => {
    const result = validateSoulConfig({
      identity: { personas: [{ channelId: "" }] },
      basePath: "/tmp",
    });
    expect(result.ok).toBe(false);
  });

  test("rejects persona with non-string name", () => {
    const result = validateSoulConfig({
      identity: { personas: [{ channelId: "@koi/channel-telegram", name: 42 }] },
      basePath: "/tmp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("name");
  });

  test("rejects persona with non-string avatar", () => {
    const result = validateSoulConfig({
      identity: { personas: [{ channelId: "@koi/channel-telegram", avatar: [] }] },
      basePath: "/tmp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("avatar");
  });

  test("rejects persona with invalid instructions type", () => {
    const result = validateSoulConfig({
      identity: { personas: [{ channelId: "@koi/channel-telegram", instructions: 42 }] },
      basePath: "/tmp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("instructions");
  });

  test("rejects persona with invalid instructions.path", () => {
    const result = validateSoulConfig({
      identity: { personas: [{ channelId: "@koi/channel-telegram", instructions: { path: 42 } }] },
      basePath: "/tmp",
    });
    expect(result.ok).toBe(false);
  });
});
