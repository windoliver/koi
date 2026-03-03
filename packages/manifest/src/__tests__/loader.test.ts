import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadManifest, loadManifestFromString } from "../loader.js";

const FIXTURES = resolve(import.meta.dir, "fixtures");

describe("loadManifestFromString", () => {
  test("loads minimal manifest", () => {
    const yaml = `name: "test"\nversion: "1.0.0"\nmodel: "anthropic:claude-sonnet-4-5-20250929"`;
    const result = loadManifestFromString(yaml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifest.name).toBe("test");
      expect(result.value.manifest.model).toEqual({ name: "anthropic:claude-sonnet-4-5-20250929" });
      expect(result.value.warnings).toEqual([]);
    }
  });

  test("interpolates env vars", () => {
    const yaml = `name: "test"\nversion: "1.0.0"\nmodel: "\${MODEL:-anthropic:claude-sonnet-4-5-20250929}"`;
    const result = loadManifestFromString(yaml, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifest.model).toEqual({ name: "anthropic:claude-sonnet-4-5-20250929" });
    }
  });

  test("returns error for missing required fields", () => {
    const yaml = `version: "1.0.0"\nmodel: "anthropic:claude-sonnet-4-5-20250929"`;
    const result = loadManifestFromString(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("name");
    }
  });

  test("returns error for invalid model type", () => {
    const yaml = `name: "test"\nversion: "1.0.0"\nmodel: 42`;
    const result = loadManifestFromString(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("warns on unknown fields with suggestions", () => {
    const yaml = `name: "test"\nversion: "1.0.0"\nmodel: "x"\nmodle: "typo"`;
    const result = loadManifestFromString(yaml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.warnings.length).toBeGreaterThan(0);
      const modle = result.value.warnings.find((w) => w.path === "modle");
      expect(modle).toBeDefined();
      expect(modle?.suggestion).toBe("model");
    }
  });

  test("transforms middleware shorthand", () => {
    const yaml = [
      'name: "test"',
      'version: "1.0.0"',
      'model: "x"',
      "middleware:",
      '  - "@koi/mw-memory": { scope: agent }',
    ].join("\n");
    const result = loadManifestFromString(yaml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifest.middleware).toEqual([
        { name: "@koi/mw-memory", options: { scope: "agent" } },
      ]);
    }
  });

  test("returns error for invalid YAML syntax", () => {
    const yaml = "name: [\ninvalid yaml";
    const result = loadManifestFromString(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("YAML");
    }
  });

  test("handles empty metadata gracefully", () => {
    const yaml = `name: "test"\nversion: "1.0.0"\nmodel: "x"\nmetadata: {}`;
    const result = loadManifestFromString(yaml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifest.metadata).toEqual({});
    }
  });

  test("loads skills from YAML with source discriminant", () => {
    const yaml = [
      'name: "test"',
      'version: "1.0.0"',
      'model: "x"',
      "skills:",
      '  - name: "code-review"',
      "    source:",
      "      kind: filesystem",
      '      path: "./skills/code-review"',
      '  - name: "deploy"',
      "    source:",
      "      kind: filesystem",
      '      path: "./skills/deploy"',
      "    options:",
      "      env: production",
    ].join("\n");
    const result = loadManifestFromString(yaml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifest.skills).toHaveLength(2);
      expect(result.value.manifest.skills?.[0]).toEqual({
        name: "code-review",
        source: { kind: "filesystem", path: "./skills/code-review" },
      });
      expect(result.value.manifest.skills?.[1]).toEqual({
        name: "deploy",
        source: { kind: "filesystem", path: "./skills/deploy" },
        options: { env: "production" },
      });
    }
  });

  test("skills field does not trigger unknown field warning", () => {
    const yaml = 'name: "test"\nversion: "1.0.0"\nmodel: "x"\nskills: []';
    const result = loadManifestFromString(yaml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.warnings).toHaveLength(0);
    }
  });
});

describe("loadManifest (file-based)", () => {
  test("loads minimal.yaml fixture", async () => {
    const result = await loadManifest(resolve(FIXTURES, "minimal.yaml"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifest.name).toBe("minimal-agent");
      expect(result.value.manifest.version).toBe("1.0.0");
      expect(result.value.manifest.model).toEqual({
        name: "anthropic:claude-sonnet-4-5-20250929",
      });
    }
  });

  test("loads full.yaml fixture with all fields", async () => {
    const result = await loadManifest(resolve(FIXTURES, "full.yaml"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const m = result.value.manifest;
      expect(m.name).toBe("Research Assistant");
      expect(m.description).toBe("A research agent with full configuration");
      expect(m.model).toEqual({
        name: "anthropic:claude-sonnet-4-5-20250929",
        options: { temperature: 0.7, maxTokens: 4096 },
      });
      expect(m.tools).toHaveLength(2);
      expect(m.middleware).toHaveLength(2);
      expect(m.channels).toHaveLength(1);
      expect(m.permissions?.allow).toEqual(["read_file:/workspace/**"]);
      expect(m.engine).toBe("deepagents");
      expect(m.schedule).toBe("0 9 * * *");
    }
  });

  test("loads shorthand.yaml with key-value middleware", async () => {
    const result = await loadManifest(resolve(FIXTURES, "shorthand.yaml"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifest.middleware).toEqual([
        { name: "@koi/middleware-memory", options: { scope: "agent" } },
        { name: "@koi/middleware-pay", options: { dailyBudget: 1000 } },
      ]);
    }
  });

  test("loads env-vars.yaml with interpolation", async () => {
    const env = { TELEGRAM_BOT_TOKEN: "tk-secret", API_KEY: "ak-123" };
    const result = await loadManifest(resolve(FIXTURES, "env-vars.yaml"), env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const channels = result.value.manifest.channels;
      expect(channels).toHaveLength(1);
      expect(channels?.[0]?.options).toEqual({ token: "tk-secret" });
    }
  });

  test("returns validation error for invalid-name.yaml", async () => {
    const result = await loadManifest(resolve(FIXTURES, "invalid-name.yaml"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("produces warnings for unknown-fields.yaml", async () => {
    const result = await loadManifest(resolve(FIXTURES, "unknown-fields.yaml"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const paths = result.value.warnings.map((w) => w.path);
      expect(paths).toContain("modle");
      expect(paths).toContain("tols");
      expect(paths).toContain("scedule");
    }
  });

  test("returns validation error for bad-model.yaml", async () => {
    const result = await loadManifest(resolve(FIXTURES, "bad-model.yaml"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("returns validation error for invalid-template.yaml (template syntax in model)", async () => {
    const result = await loadManifest(resolve(FIXTURES, "invalid-template.yaml"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("template");
    }
  });

  test("loads complex-middleware.yaml with mixed formats", async () => {
    const result = await loadManifest(resolve(FIXTURES, "complex-middleware.yaml"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const mw = result.value.manifest.middleware;
      expect(mw).toHaveLength(3);
      expect(mw?.[0]?.name).toBe("@koi/middleware-log");
      expect(mw?.[1]?.name).toBe("@koi/middleware-memory");
      expect(mw?.[1]?.options).toEqual({ scope: "agent" });
      expect(mw?.[2]?.name).toBe("@koi/middleware-pay");
      expect(mw?.[2]?.options).toEqual({ dailyBudget: 1000, currency: "USD" });
    }
  });

  test("loads guide-agent.yaml fixture", async () => {
    const result = await loadManifest(resolve(FIXTURES, "guide-agent.yaml"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifest.name).toBe("knowledge-guide");
      expect(result.value.manifest.model).toEqual({
        name: "anthropic:claude-haiku-4-5-20251001",
      });
      expect(result.value.manifest.skills).toHaveLength(1);
      expect(result.value.manifest.skills?.[0]?.name).toBe("domain-knowledge");
    }
  });

  test("returns error for non-existent file", async () => {
    const result = await loadManifest("/does/not/exist.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });
});
