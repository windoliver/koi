/**
 * Tests for source adapters — one per adapter type.
 */

import { describe, expect, test } from "bun:test";
import type { CatalogEntry, Resolver, Tool, ToolDescriptor } from "@koi/core";
import { skillId } from "@koi/core";
import {
  createInMemoryBrickRegistry,
  createInMemorySkillRegistry,
  createTestToolArtifact,
} from "@koi/test-utils";

import {
  createBundledAdapter,
  createForgeAdapter,
  createMcpAdapter,
  createSkillAdapter,
} from "./adapters.js";

// ---------------------------------------------------------------------------
// Forge adapter
// ---------------------------------------------------------------------------

describe("createForgeAdapter", () => {
  test("maps BrickArtifact to CatalogEntry with forged: prefix", async () => {
    const registry = createInMemoryBrickRegistry();
    const tool = createTestToolArtifact({ name: "my-tool", description: "A tool" });
    registry.register(tool);

    const adapter = createForgeAdapter(registry);
    const results = await adapter.search({});

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("forged:my-tool");
    expect(results[0]?.kind).toBe("tool");
    expect(results[0]?.source).toBe("forged");
    expect(results[0]?.description).toBe("A tool");
  });
});

// ---------------------------------------------------------------------------
// Skill adapter
// ---------------------------------------------------------------------------

describe("createSkillAdapter", () => {
  test("maps SkillRegistryEntry to CatalogEntry with skill-registry: prefix", async () => {
    const registry = createInMemorySkillRegistry();
    registry.publish({
      id: skillId("test-skill"),
      name: "test-skill",
      description: "A test skill",
      tags: ["testing"],
      version: "1.0.0",
      content: "# Skill content",
    });

    const adapter = createSkillAdapter(registry);
    const results = await adapter.search({});

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("skill-registry:test-skill");
    expect(results[0]?.kind).toBe("skill");
    expect(results[0]?.source).toBe("skill-registry");
  });

  test("skips search when query asks for non-skill kind", async () => {
    const registry = createInMemorySkillRegistry();
    registry.publish({
      id: skillId("test-skill"),
      name: "test-skill",
      description: "A test skill",
      tags: [],
      version: "1.0.0",
      content: "# content",
    });

    const adapter = createSkillAdapter(registry);
    const results = await adapter.search({ kind: "tool" });

    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Bundled adapter
// ---------------------------------------------------------------------------

describe("createBundledAdapter", () => {
  const entries: readonly CatalogEntry[] = [
    {
      name: "bundled:@koi/middleware-audit",
      kind: "middleware",
      source: "bundled",
      description: "Audit middleware",
      tags: ["middleware", "audit"],
    },
    {
      name: "bundled:@koi/forge",
      kind: "tool",
      source: "bundled",
      description: "Self-extension system",
      tags: ["forge", "tool"],
    },
  ];

  test("filters by kind", async () => {
    const adapter = createBundledAdapter(entries);
    const results = await adapter.search({ kind: "tool" });

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("bundled:@koi/forge");
  });

  test("filters by text", async () => {
    const adapter = createBundledAdapter(entries);
    const results = await adapter.search({ text: "audit" });

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("bundled:@koi/middleware-audit");
  });
});

// ---------------------------------------------------------------------------
// MCP adapter
// ---------------------------------------------------------------------------

describe("createMcpAdapter", () => {
  test("maps ToolDescriptor to CatalogEntry with mcp: prefix", async () => {
    const descriptors: readonly ToolDescriptor[] = [
      {
        name: "read_file",
        description: "Reads a file from disk",
        inputSchema: { type: "object" },
      },
    ];

    const resolver: Resolver<ToolDescriptor, Tool> = {
      discover: async () => descriptors,
      load: async () => ({
        ok: false,
        error: { code: "NOT_FOUND", message: "N/A", retryable: false },
      }),
    };

    const adapter = createMcpAdapter(resolver);
    const results = await adapter.search({});

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("mcp:read_file");
    expect(results[0]?.kind).toBe("tool");
    expect(results[0]?.source).toBe("mcp");
  });

  test("skips search when query asks for non-tool kind", async () => {
    const resolver: Resolver<ToolDescriptor, Tool> = {
      discover: async () => [],
      load: async () => ({
        ok: false,
        error: { code: "NOT_FOUND", message: "N/A", retryable: false },
      }),
    };

    const adapter = createMcpAdapter(resolver);
    const results = await adapter.search({ kind: "middleware" });

    expect(results).toHaveLength(0);
  });
});
