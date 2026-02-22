import { describe, expect, test } from "bun:test";
import { rawManifestSchema, zodToKoiError } from "../schema.js";

describe("rawManifestSchema", () => {
  test("accepts minimal valid manifest", () => {
    const result = rawManifestSchema.safeParse({
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
    });
    expect(result.success).toBe(true);
  });

  test("accepts model as object", () => {
    const result = rawManifestSchema.safeParse({
      name: "my-agent",
      version: "1.0.0",
      model: { name: "anthropic:claude-sonnet-4-5-20250929", options: { temperature: 0.7 } },
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing name", () => {
    const result = rawManifestSchema.safeParse({
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing version", () => {
    const result = rawManifestSchema.safeParse({
      name: "my-agent",
      model: "anthropic:claude-sonnet-4-5-20250929",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing model", () => {
    const result = rawManifestSchema.safeParse({
      name: "my-agent",
      version: "1.0.0",
    });
    expect(result.success).toBe(false);
  });

  test("rejects model as number", () => {
    const result = rawManifestSchema.safeParse({
      name: "my-agent",
      version: "1.0.0",
      model: 42,
    });
    expect(result.success).toBe(false);
  });

  test("accepts middleware as key-value array", () => {
    const result = rawManifestSchema.safeParse({
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
      middleware: [{ "@koi/middleware-memory": { scope: "agent" } }],
    });
    expect(result.success).toBe(true);
  });

  test("accepts tools with mcp section", () => {
    const result = rawManifestSchema.safeParse({
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
      tools: {
        mcp: [{ name: "filesystem", command: "npx @anthropic/mcp-server-filesystem /workspace" }],
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts permissions", () => {
    const result = rawManifestSchema.safeParse({
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
      permissions: {
        allow: ["read_file:/workspace/**"],
        deny: ["bash:rm -rf *"],
        ask: ["bash:*"],
      },
    });
    expect(result.success).toBe(true);
  });

  test("passes through extension fields", () => {
    const result = rawManifestSchema.safeParse({
      name: "my-agent",
      version: "1.0.0",
      model: "anthropic:claude-sonnet-4-5-20250929",
      engine: "deepagents",
      schedule: "0 9 * * *",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.engine).toBe("deepagents");
      expect(result.data.schedule).toBe("0 9 * * *");
    }
  });
});

describe("zodToKoiError", () => {
  test("converts ZodError to KoiError with VALIDATION code", () => {
    const result = rawManifestSchema.safeParse({ model: 42 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const koiError = zodToKoiError(result.error);
      expect(koiError.code).toBe("VALIDATION");
      expect(koiError.retryable).toBe(false);
      expect(koiError.message).toContain("Manifest validation failed");
      expect(koiError.context).toBeDefined();
    }
  });
});
