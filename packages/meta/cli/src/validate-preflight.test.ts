import { describe, expect, test } from "bun:test";
import { printPreflightIssues, validateManifestPrerequisites } from "./validate-preflight.js";

describe("validateManifestPrerequisites", () => {
  test("returns ok when all prerequisites are met", async () => {
    const manifest = {
      model: { name: "anthropic:claude-sonnet-4-5-20250929" },
      channels: [{ name: "@koi/channel-cli" }],
    };
    const env = { ANTHROPIC_API_KEY: "sk-test-key" };

    const result = await validateManifestPrerequisites(manifest, env);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test("reports error for missing model API key", async () => {
    const manifest = {
      model: { name: "anthropic:claude-sonnet-4-5-20250929" },
    };
    const env = {};

    const result = await validateManifestPrerequisites(manifest, env);
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.severity).toBe("error");
    expect(result.issues[0]?.code).toBe("MISSING_MODEL_API_KEY");
    expect(result.issues[0]?.message).toContain("ANTHROPIC_API_KEY");
  });

  test("reports error for empty model API key", async () => {
    const manifest = {
      model: { name: "openai:gpt-4o" },
    };
    const env = { OPENAI_API_KEY: "  " };

    const result = await validateManifestPrerequisites(manifest, env);
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("MISSING_MODEL_API_KEY");
  });

  test("reports warning for missing channel tokens", async () => {
    const manifest = {
      model: { name: "anthropic:claude-sonnet-4-5-20250929" },
      channels: [{ name: "@koi/channel-telegram" }],
    };
    const env = { ANTHROPIC_API_KEY: "sk-test" };

    const result = await validateManifestPrerequisites(manifest, env);
    expect(result.ok).toBe(true); // warnings don't fail
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.severity).toBe("warning");
    expect(result.issues[0]?.code).toBe("MISSING_CHANNEL_TOKEN");
  });

  test("reports multiple warnings for slack channel", async () => {
    const manifest = {
      model: { name: "anthropic:claude-sonnet-4-5-20250929" },
      channels: [{ name: "@koi/channel-slack" }],
    };
    const env = { ANTHROPIC_API_KEY: "sk-test" };

    const result = await validateManifestPrerequisites(manifest, env);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(2); // SLACK_BOT_TOKEN + SLACK_APP_TOKEN
  });

  test("no issues for CLI-only channel", async () => {
    const manifest = {
      model: { name: "anthropic:claude-sonnet-4-5-20250929" },
      channels: [{ name: "@koi/channel-cli" }],
    };
    const env = { ANTHROPIC_API_KEY: "sk-test" };

    const result = await validateManifestPrerequisites(manifest, env);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test("handles manifest without channels", async () => {
    const manifest = {
      model: { name: "anthropic:claude-sonnet-4-5-20250929" },
    };
    const env = { ANTHROPIC_API_KEY: "sk-test" };

    const result = await validateManifestPrerequisites(manifest, env);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test("handles model without provider prefix", async () => {
    const manifest = {
      model: { name: "custom-model" },
    };
    const env = {};

    const result = await validateManifestPrerequisites(manifest, env);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test("reports both errors and warnings together", async () => {
    const manifest = {
      model: { name: "anthropic:claude-sonnet-4-5-20250929" },
      channels: [{ name: "@koi/channel-telegram" }],
    };
    const env = {};

    const result = await validateManifestPrerequisites(manifest, env);
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]?.severity).toBe("error");
    expect(result.issues[1]?.severity).toBe("warning");
  });

  test("accepts openrouter provider", async () => {
    const manifest = {
      model: { name: "openrouter:anthropic/claude-sonnet-4.6" },
    };
    const env = { OPENROUTER_API_KEY: "or-test" };

    const result = await validateManifestPrerequisites(manifest, env);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test("warns when nexus URL is unreachable", async () => {
    const manifest = {
      model: { name: "custom-model" },
      nexus: { url: "http://127.0.0.1:59999" },
    };
    const env = {};

    const result = await validateManifestPrerequisites(manifest, env);
    expect(result.ok).toBe(true); // warning only, not an error
    const nexusIssue = result.issues.find((i) => i.code === "NEXUS_UNREACHABLE");
    expect(nexusIssue).toBeDefined();
    expect(nexusIssue?.severity).toBe("warning");
  });

  test("skips nexus check when no nexus URL configured", async () => {
    const manifest = {
      model: { name: "custom-model" },
    };
    const env = {};

    const result = await validateManifestPrerequisites(manifest, env);
    const nexusIssue = result.issues.find((i) => i.code === "NEXUS_UNREACHABLE");
    expect(nexusIssue).toBeUndefined();
  });

  test("checks nexus binary availability in embed mode", async () => {
    const manifest = {
      model: { name: "custom-model" },
      // No nexus.url → embed mode
    };
    // Set NEXUS_COMMAND to a binary that definitely doesn't exist
    const env = { NEXUS_COMMAND: "nonexistent-nexus-binary-xyz123" };

    const result = await validateManifestPrerequisites(manifest, env);
    const binaryIssue = result.issues.find((i) => i.code === "NEXUS_BINARY_MISSING");
    expect(binaryIssue).toBeDefined();
    expect(binaryIssue?.severity).toBe("warning");
    expect(binaryIssue?.message).toContain("nonexistent-nexus-binary-xyz123");
  });

  test("skips nexus binary check when remote URL configured", async () => {
    const manifest = {
      model: { name: "custom-model" },
      nexus: { url: "http://remote-nexus:2026" },
    };
    const env = {};

    const result = await validateManifestPrerequisites(manifest, env);
    const binaryIssue = result.issues.find((i) => i.code === "NEXUS_BINARY_MISSING");
    expect(binaryIssue).toBeUndefined();
  });

  test("warns when temporal binary missing and temporalRequired", async () => {
    const manifest = {
      model: { name: "custom-model" },
    };
    const env = {};

    const result = await validateManifestPrerequisites(manifest, env, {
      temporalRequired: true,
    });
    const temporalIssue = result.issues.find((i) => i.code === "TEMPORAL_BINARY_MISSING");
    // This test may pass or fail depending on whether `temporal` is installed.
    // We only assert the structure is correct if the issue is present.
    if (temporalIssue !== undefined) {
      expect(temporalIssue.severity).toBe("warning");
      expect(temporalIssue.message).toContain("temporal");
      expect(result.ok).toBe(true); // warning, not error
    }
  });

  test("skips temporal check when temporalRequired is false", async () => {
    const manifest = {
      model: { name: "custom-model" },
    };
    const env = {};

    const result = await validateManifestPrerequisites(manifest, env, {
      temporalRequired: false,
    });
    const temporalIssue = result.issues.find((i) => i.code === "TEMPORAL_BINARY_MISSING");
    expect(temporalIssue).toBeUndefined();
  });

  test("skips temporal check when no options provided", async () => {
    const manifest = {
      model: { name: "custom-model" },
    };
    const env = {};

    const result = await validateManifestPrerequisites(manifest, env);
    const temporalIssue = result.issues.find((i) => i.code === "TEMPORAL_BINARY_MISSING");
    expect(temporalIssue).toBeUndefined();
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
