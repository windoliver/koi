/**
 * Tests for source adapters — one per adapter type.
 */

import { describe, expect, test } from "bun:test";
import type { BrickFitnessMetrics, CatalogEntry, Resolver, Tool, ToolDescriptor } from "@koi/core";
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

  test("populates fitnessScore for brick with fitness data", async () => {
    const registry = createInMemoryBrickRegistry();
    const fitness: BrickFitnessMetrics = {
      successCount: 10,
      errorCount: 0,
      latency: { samples: [100], count: 1, cap: 100 },
      lastUsedAt: Date.now(),
    };
    const tool = createTestToolArtifact({
      name: "fit-tool",
      description: "A fit tool",
      fitness,
    });
    registry.register(tool);

    const adapter = createForgeAdapter(registry);
    const results = await adapter.search({});

    expect(results).toHaveLength(1);
    expect(results[0]?.fitnessScore).toBeDefined();
    expect(results[0]?.fitnessScore).toBeGreaterThan(0);
  });

  test("omits fitnessScore when brick has no fitness data", async () => {
    const registry = createInMemoryBrickRegistry();
    const tool = createTestToolArtifact({ name: "no-fitness", description: "No fitness" });
    registry.register(tool);

    const adapter = createForgeAdapter(registry);
    const results = await adapter.search({});

    expect(results).toHaveLength(1);
    expect(results[0]?.fitnessScore).toBeUndefined();
  });

  test("fitnessScore is in [0, 1] range", async () => {
    const registry = createInMemoryBrickRegistry();
    const fitness: BrickFitnessMetrics = {
      successCount: 50,
      errorCount: 50,
      latency: { samples: [200, 300, 500], count: 3, cap: 100 },
      lastUsedAt: Date.now(),
    };
    const tool = createTestToolArtifact({
      name: "bounded-tool",
      description: "Bounded fitness",
      fitness,
    });
    registry.register(tool);

    const adapter = createForgeAdapter(registry);
    const results = await adapter.search({});

    expect(results).toHaveLength(1);
    const score = results[0]?.fitnessScore;
    expect(score).toBeDefined();
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
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

  test("forwards tags from ToolDescriptor to CatalogEntry", async () => {
    const descriptors: readonly ToolDescriptor[] = [
      {
        name: "shell_exec",
        description: "Execute shell commands",
        inputSchema: { type: "object" },
        tags: ["coding", "automation"],
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
    expect(results[0]?.tags).toEqual(["coding", "automation"]);
  });

  test("omits tags from CatalogEntry when ToolDescriptor has no tags", async () => {
    const descriptors: readonly ToolDescriptor[] = [
      {
        name: "read_file",
        description: "Reads a file",
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
    expect(results[0]?.tags).toBeUndefined();
  });

  test("omits tags from CatalogEntry when ToolDescriptor has empty tags", async () => {
    const descriptors: readonly ToolDescriptor[] = [
      {
        name: "read_file",
        description: "Reads a file",
        inputSchema: { type: "object" },
        tags: [],
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
    expect(results[0]?.tags).toBeUndefined();
  });
});
