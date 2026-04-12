import { describe, expect, test } from "bun:test";
import { validatePluginManifest } from "./schema.js";

describe("validatePluginManifest", () => {
  const VALID_MANIFEST = {
    name: "my-plugin",
    version: "1.0.0",
    description: "A sample plugin",
  };

  test("valid manifest parses and validates", () => {
    const result = validatePluginManifest(VALID_MANIFEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("my-plugin");
      expect(result.value.version).toBe("1.0.0");
      expect(result.value.description).toBe("A sample plugin");
    }
  });

  test("valid manifest with all optional fields", () => {
    const full = {
      ...VALID_MANIFEST,
      author: "Test Author",
      keywords: ["test", "sample"],
      skills: ["./skills/greeting"],
      hooks: "./hooks/hooks.json",
      mcpServers: "./.mcp.json",
      middleware: ["my-middleware"],
    };
    const result = validatePluginManifest(full);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.author).toBe("Test Author");
      expect(result.value.keywords).toEqual(["test", "sample"]);
      expect(result.value.skills).toEqual(["./skills/greeting"]);
      expect(result.value.hooks).toBe("./hooks/hooks.json");
      expect(result.value.mcpServers).toBe("./.mcp.json");
      expect(result.value.middleware).toEqual(["my-middleware"]);
    }
  });

  test("plugin without optional fields loads cleanly", () => {
    const result = validatePluginManifest(VALID_MANIFEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.author).toBeUndefined();
      expect(result.value.keywords).toBeUndefined();
      expect(result.value.skills).toBeUndefined();
      expect(result.value.hooks).toBeUndefined();
      expect(result.value.mcpServers).toBeUndefined();
      expect(result.value.middleware).toBeUndefined();
    }
  });

  test("invalid manifest returns typed error — missing required fields", () => {
    const result = validatePluginManifest({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.retryable).toBe(false);
    }
  });

  test("missing name returns validation error", () => {
    const result = validatePluginManifest({ version: "1.0.0", description: "test" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("missing version returns validation error", () => {
    const result = validatePluginManifest({ name: "test", description: "test" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("name must be kebab-case — uppercase rejected", () => {
    const result = validatePluginManifest({
      name: "My Plugin",
      version: "1.0.0",
      description: "test",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("kebab-case");
    }
  });

  test("name must be kebab-case — leading hyphen rejected", () => {
    const result = validatePluginManifest({
      name: "-bad-name",
      version: "1.0.0",
      description: "test",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("name with digits is valid", () => {
    const result = validatePluginManifest({
      name: "plugin-v2",
      version: "1.0.0",
      description: "test",
    });
    expect(result.ok).toBe(true);
  });

  test("non-object input returns validation error", () => {
    const result = validatePluginManifest("not an object");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  // Strict mode: unknown fields must be rejected, not silently stripped.
  // Before the `.strict()` tightening, a manifest like the one below would
  // pass validation with `mcp_servers` silently dropped — the plugin would
  // load but its MCP servers would never register, leaving the author to
  // debug a ghost configuration. Reject at load time with a clear error.
  test("unknown top-level field is rejected (catches typos like mcp_servers vs mcpServers)", () => {
    const result = validatePluginManifest({
      ...VALID_MANIFEST,
      mcp_servers: "./.mcp.json", // typo: real field is mcpServers
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("Plugin manifest validation failed");
    }
  });

  test("arbitrary unknown field (not a typo) is also rejected", () => {
    const result = validatePluginManifest({
      ...VALID_MANIFEST,
      futureExtensionField: "whatever",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });
});
