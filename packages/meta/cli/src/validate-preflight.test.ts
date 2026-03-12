import { describe, expect, test } from "bun:test";
import { printPreflightIssues, validateManifestPrerequisites } from "./validate-preflight.js";

describe("validateManifestPrerequisites", () => {
  test("returns ok when all prerequisites are met", () => {
    const manifest = {
      model: { name: "anthropic:claude-sonnet-4-5-20250929" },
      channels: [{ name: "@koi/channel-cli" }],
    };
    const env = { ANTHROPIC_API_KEY: "sk-test-key" };

    const result = validateManifestPrerequisites(manifest, env);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test("reports error for missing model API key", () => {
    const manifest = {
      model: { name: "anthropic:claude-sonnet-4-5-20250929" },
    };
    const env = {};

    const result = validateManifestPrerequisites(manifest, env);
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.severity).toBe("error");
    expect(result.issues[0]?.code).toBe("MISSING_MODEL_API_KEY");
    expect(result.issues[0]?.message).toContain("ANTHROPIC_API_KEY");
  });

  test("reports error for empty model API key", () => {
    const manifest = {
      model: { name: "openai:gpt-4o" },
    };
    const env = { OPENAI_API_KEY: "  " };

    const result = validateManifestPrerequisites(manifest, env);
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("MISSING_MODEL_API_KEY");
  });

  test("reports warning for missing channel tokens", () => {
    const manifest = {
      model: { name: "anthropic:claude-sonnet-4-5-20250929" },
      channels: [{ name: "@koi/channel-telegram" }],
    };
    const env = { ANTHROPIC_API_KEY: "sk-test" };

    const result = validateManifestPrerequisites(manifest, env);
    expect(result.ok).toBe(true); // warnings don't fail
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.severity).toBe("warning");
    expect(result.issues[0]?.code).toBe("MISSING_CHANNEL_TOKEN");
  });

  test("reports multiple warnings for slack channel", () => {
    const manifest = {
      model: { name: "anthropic:claude-sonnet-4-5-20250929" },
      channels: [{ name: "@koi/channel-slack" }],
    };
    const env = { ANTHROPIC_API_KEY: "sk-test" };

    const result = validateManifestPrerequisites(manifest, env);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(2); // SLACK_BOT_TOKEN + SLACK_APP_TOKEN
  });

  test("no issues for CLI-only channel", () => {
    const manifest = {
      model: { name: "anthropic:claude-sonnet-4-5-20250929" },
      channels: [{ name: "@koi/channel-cli" }],
    };
    const env = { ANTHROPIC_API_KEY: "sk-test" };

    const result = validateManifestPrerequisites(manifest, env);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test("handles manifest without channels", () => {
    const manifest = {
      model: { name: "anthropic:claude-sonnet-4-5-20250929" },
    };
    const env = { ANTHROPIC_API_KEY: "sk-test" };

    const result = validateManifestPrerequisites(manifest, env);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test("handles model without provider prefix", () => {
    const manifest = {
      model: { name: "custom-model" },
    };
    const env = {};

    const result = validateManifestPrerequisites(manifest, env);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test("reports both errors and warnings together", () => {
    const manifest = {
      model: { name: "anthropic:claude-sonnet-4-5-20250929" },
      channels: [{ name: "@koi/channel-telegram" }],
    };
    const env = {};

    const result = validateManifestPrerequisites(manifest, env);
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]?.severity).toBe("error");
    expect(result.issues[1]?.severity).toBe("warning");
  });

  test("accepts openrouter provider", () => {
    const manifest = {
      model: { name: "openrouter:anthropic/claude-sonnet-4.6" },
    };
    const env = { OPENROUTER_API_KEY: "or-test" };

    const result = validateManifestPrerequisites(manifest, env);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});

describe("printPreflightIssues", () => {
  test("returns true when result is ok", () => {
    const result = { ok: true, issues: [] };
    expect(printPreflightIssues(result)).toBe(true);
  });

  test("returns false when result is not ok", () => {
    const result = {
      ok: false,
      issues: [{ severity: "error" as const, code: "TEST", message: "test error" }],
    };
    expect(printPreflightIssues(result)).toBe(false);
  });
});
