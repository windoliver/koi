/**
 * Integration test: ForgeSkillInput with credentials + configSchema
 * → generateSkillMd() → parse YAML → validateSkillFrontmatter()
 * → assert credentials + configSchema survive the round-trip.
 */

import { describe, expect, test } from "bun:test";
import { parse as yamlParse } from "yaml";
import { generateSkillMd } from "../generate-skill-md.js";

describe("credential round-trip", () => {
  test("credentials survive generateSkillMd → YAML parse round-trip", () => {
    const md = generateSkillMd({
      name: "db-query",
      description: "Query a database",
      agentId: "agent-1",
      version: "0.0.1",
      body: "# Query patterns\n\nUse parameterized queries.",
      requires: {
        credentials: {
          db: { kind: "connection_string", ref: "DATABASE_URL" },
          api: { kind: "api_key", ref: "API_KEY", scopes: ["read", "write"] },
        },
        network: true,
      },
      configSchema: {
        type: "object",
        properties: {
          host: { type: "string" },
          port: { type: "number" },
        },
      },
    });

    // Extract YAML frontmatter between --- delimiters
    const match = /^---\n([\s\S]*?)\n---/.exec(md);
    expect(match).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect above
    const frontmatter = yamlParse(match![1]!) as Record<string, unknown>;

    // Verify credentials survived
    expect(frontmatter.name).toBe("db-query");
    expect(frontmatter.description).toBe("Query a database");

    const requires = frontmatter.requires as Record<string, unknown>;
    expect(requires).toBeDefined();
    expect(requires.network).toBe(true);

    const credentials = requires.credentials as Record<string, Record<string, unknown>>;
    expect(credentials.db).toEqual({ kind: "connection_string", ref: "DATABASE_URL" });
    expect(credentials.api).toEqual({
      kind: "api_key",
      ref: "API_KEY",
      scopes: ["read", "write"],
    });

    // Verify configSchema survived
    const configSchema = frontmatter.configSchema as Record<string, unknown>;
    expect(configSchema.type).toBe("object");
    const props = configSchema.properties as Record<string, Record<string, string>>;
    expect(props.host).toEqual({ type: "string" });
    expect(props.port).toEqual({ type: "number" });

    // Verify body content
    expect(md).toContain("# Query patterns");
    expect(md).toContain("Use parameterized queries.");
  });

  test("generateSkillMd without requires/configSchema produces clean output", () => {
    const md = generateSkillMd({
      name: "simple",
      description: "A simple skill",
      agentId: "agent-1",
      version: "0.0.1",
      body: "Content here",
    });

    expect(md).not.toContain("requires:");
    expect(md).not.toContain("configSchema:");
    expect(md).toContain("name: simple");
  });
});

describe("trigger round-trip", () => {
  test("triggers rendered as YAML list in frontmatter", () => {
    const md = generateSkillMd({
      name: "viz-skill",
      description: "Visualize things",
      agentId: "agent-1",
      version: "0.0.1",
      body: "# Visualization",
      trigger: ["visualize theorem", "animate proof", "math explanation video"],
    });

    // Extract YAML frontmatter between --- delimiters
    const match = /^---\n([\s\S]*?)\n---/.exec(md);
    expect(match).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect above
    const frontmatter = yamlParse(match![1]!) as Record<string, unknown>;

    const trigger = frontmatter.trigger as string[];
    expect(trigger).toEqual(["visualize theorem", "animate proof", "math explanation video"]);
  });

  test("trigger with YAML special characters is properly escaped", () => {
    const md = generateSkillMd({
      name: "special-skill",
      description: "Special chars",
      agentId: "agent-1",
      version: "0.0.1",
      body: "Content",
      trigger: ["key: value", "# hashtag", "it's quoted"],
    });

    const match = /^---\n([\s\S]*?)\n---/.exec(md);
    expect(match).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect above
    const frontmatter = yamlParse(match![1]!) as Record<string, unknown>;

    const trigger = frontmatter.trigger as string[];
    expect(trigger).toEqual(["key: value", "# hashtag", "it's quoted"]);
  });

  test("no trigger field when trigger is undefined", () => {
    const md = generateSkillMd({
      name: "no-trigger",
      description: "No triggers",
      agentId: "agent-1",
      version: "0.0.1",
      body: "Content",
    });

    expect(md).not.toContain("trigger:");
  });

  test("no trigger field when trigger is empty array", () => {
    const md = generateSkillMd({
      name: "empty-trigger",
      description: "Empty triggers",
      agentId: "agent-1",
      version: "0.0.1",
      body: "Content",
      trigger: [],
    });

    expect(md).not.toContain("trigger:");
  });
});
