/**
 * Integration test — full search → attach flow with in-memory backends.
 */

import { describe, expect, test } from "bun:test";
import type {
  CatalogEntry,
  CatalogQuery,
  CatalogSourceError,
  Resolver,
  Tool,
  ToolDescriptor,
} from "@koi/core";
import { skillId } from "@koi/core";
import {
  createInMemoryBrickRegistry,
  createInMemorySkillRegistry,
  createMockAgent,
  createTestToolArtifact,
} from "@koi/test-utils";

import {
  createBundledAdapter,
  createForgeAdapter,
  createMcpAdapter,
  createSkillAdapter,
} from "../adapters.js";
import { BUNDLED_ENTRIES } from "../bundled-entries.js";
import { createCatalogResolver } from "../catalog-resolver.js";
import type { AttachConfig } from "../tools/attach-capability.js";
import { createAttachCapabilityTool } from "../tools/attach-capability.js";
import { createSearchCatalogTool } from "../tools/search-catalog.js";
import type { CatalogSourceAdapter } from "../types.js";

// ---------------------------------------------------------------------------
// Setup: wire up in-memory backends
// ---------------------------------------------------------------------------

function createTestCatalog(): ReturnType<typeof createCatalogResolver> {
  // Forge store with one tool
  const brickRegistry = createInMemoryBrickRegistry();
  brickRegistry.register(
    createTestToolArtifact({ name: "calculator", description: "Math calculator tool" }),
  );

  // Skill registry with one skill
  const skillRegistry = createInMemorySkillRegistry();
  skillRegistry.publish({
    id: skillId("code-review"),
    name: "code-review",
    description: "Code review assistant skill",
    tags: ["review", "quality"],
    version: "1.0.0",
    content: "# Code Review\n\nReview code for quality.",
  });

  // MCP resolver with one tool
  const mcpResolver: Resolver<ToolDescriptor, Tool> = {
    discover: async () => [
      {
        name: "fetch_url",
        description: "Fetch content from a URL",
        inputSchema: { type: "object" },
      },
    ],
    load: async () => ({
      ok: false,
      error: { code: "NOT_FOUND", message: "N/A", retryable: false },
    }),
  };

  // Use a small subset of bundled entries for testing
  const bundledSubset: readonly CatalogEntry[] = BUNDLED_ENTRIES.slice(0, 3);

  return createCatalogResolver({
    adapters: [
      createBundledAdapter(bundledSubset),
      createForgeAdapter(brickRegistry),
      createSkillAdapter(skillRegistry),
      createMcpAdapter(mcpResolver),
    ],
  });
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("catalog integration", () => {
  test("search returns entries from all four sources", async () => {
    const resolver = createTestCatalog();
    const page = await resolver.search({});

    // 3 bundled + 1 forged + 1 skill + 1 mcp = 6
    expect(page.items.length).toBe(6);

    const sources = new Set(page.items.map((i) => i.source));
    expect(sources.has("bundled")).toBe(true);
    expect(sources.has("forged")).toBe(true);
    expect(sources.has("skill-registry")).toBe(true);
    expect(sources.has("mcp")).toBe(true);
  });

  test("get retrieves a specific entry by name", async () => {
    const resolver = createTestCatalog();
    const result = await resolver.get("forged:calculator");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("forged:calculator");
      expect(result.value.kind).toBe("tool");
    }
  });

  test("get returns NOT_FOUND for unknown entry", async () => {
    const resolver = createTestCatalog();
    const result = await resolver.get("bundled:nonexistent");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("full search → attach flow", async () => {
    const resolver = createTestCatalog();
    const agent = createMockAgent();
    const searchTool = createSearchCatalogTool(resolver, agent);

    // 1. Search for tools
    const searchResult = (await searchTool.execute({ kind: "tool" })) as Record<string, unknown>;
    const items = searchResult.items as readonly Record<string, unknown>[];

    // Should find forged calculator, bundled entries with kind "tool", and mcp fetch_url
    expect(items.length).toBeGreaterThan(0);

    // 2. Attach a capability
    let attachedEntry: CatalogEntry | undefined;
    const attachConfig: AttachConfig = {
      allowedKinds: ["tool", "skill"],
      onAttach: async (entry) => {
        attachedEntry = entry;
        return { ok: true, value: undefined };
      },
    };
    const attachTool = createAttachCapabilityTool(resolver, agent, attachConfig);

    const attachResult = (await attachTool.execute({
      name: "forged:calculator",
    })) as Record<string, unknown>;

    expect(attachResult.ok).toBe(true);
    expect(attachedEntry).toBeDefined();
    if (attachedEntry !== undefined) {
      expect(attachedEntry.name).toBe("forged:calculator");
      expect(attachedEntry.kind).toBe("tool");
    }
  });

  // -----------------------------------------------------------------------
  // Partial failure scenarios
  // -----------------------------------------------------------------------

  test("partial failure: healthy sources return results alongside sourceErrors", async () => {
    // Bundled adapter (healthy)
    const bundledSubset: readonly CatalogEntry[] = BUNDLED_ENTRIES.slice(0, 2);
    const bundledAdapter = createBundledAdapter(bundledSubset);

    // Failing adapter (simulates forge store down)
    const failingAdapter: CatalogSourceAdapter = {
      source: "forged",
      search: async (_query: CatalogQuery): Promise<readonly CatalogEntry[]> => {
        throw new Error("Forge store connection refused");
      },
    };

    const resolver = createCatalogResolver({
      adapters: [bundledAdapter, failingAdapter],
    });

    const page = await resolver.search({});

    // Bundled entries still returned
    expect(page.items.length).toBe(2);
    expect(page.items[0]?.source).toBe("bundled");

    // sourceErrors includes the failed adapter
    const errors = page.sourceErrors;
    expect(errors).toBeDefined();
    if (errors !== undefined) {
      expect(errors.length).toBe(1);
      const forgeError = errors[0] as CatalogSourceError;
      expect(forgeError.source).toBe("forged");
      expect(forgeError.error.message).toContain("Forge store connection refused");
    }
  });

  test("all sources fail: returns empty items with all sourceErrors", async () => {
    const failingForge: CatalogSourceAdapter = {
      source: "forged",
      search: async () => {
        throw new Error("forge down");
      },
    };
    const failingMcp: CatalogSourceAdapter = {
      source: "mcp",
      search: async () => {
        throw new Error("mcp timeout");
      },
    };

    const resolver = createCatalogResolver({
      adapters: [failingForge, failingMcp],
    });

    const page = await resolver.search({});

    expect(page.items.length).toBe(0);

    const errors = page.sourceErrors;
    expect(errors).toBeDefined();
    if (errors !== undefined) {
      expect(errors.length).toBe(2);
      const errorSources = new Set(errors.map((e) => e.source));
      expect(errorSources.has("forged")).toBe(true);
      expect(errorSources.has("mcp")).toBe(true);
    }
  });

  // -----------------------------------------------------------------------
  // Bundled search scenarios
  // -----------------------------------------------------------------------

  test("bundled search: filter by kind returns only matching entries", async () => {
    const resolver = createCatalogResolver({
      adapters: [createBundledAdapter(BUNDLED_ENTRIES)],
    });

    const middlewarePage = await resolver.search({ kind: "middleware" });
    const channelPage = await resolver.search({ kind: "channel" });

    // All middleware entries should have kind "middleware"
    for (const item of middlewarePage.items) {
      expect(item.kind).toBe("middleware");
    }
    // Should have all 25 middleware packages
    expect(middlewarePage.items.length).toBe(25);

    // All channel entries should have kind "channel"
    for (const item of channelPage.items) {
      expect(item.kind).toBe("channel");
    }
    expect(channelPage.items.length).toBe(6);
  });

  test("bundled search: text search matches name and description", async () => {
    const resolver = createCatalogResolver({
      adapters: [createBundledAdapter(BUNDLED_ENTRIES)],
    });

    // Search by package name fragment
    const piiPage = await resolver.search({ text: "pii" });
    expect(piiPage.items.length).toBeGreaterThanOrEqual(1);
    expect(piiPage.items.some((i) => i.name.includes("pii"))).toBe(true);

    // Search by description keyword
    const dockerPage = await resolver.search({ text: "docker" });
    expect(dockerPage.items.length).toBeGreaterThanOrEqual(1);
    expect(dockerPage.items.some((i) => i.name.includes("docker"))).toBe(true);
  });

  test("bundled search: tag filter narrows results", async () => {
    const resolver = createCatalogResolver({
      adapters: [createBundledAdapter(BUNDLED_ENTRIES)],
    });

    const sandboxPage = await resolver.search({ tags: ["sandbox"] });

    // All sandbox-tagged entries should include "sandbox" in tags
    for (const item of sandboxPage.items) {
      const tags = item.tags ?? [];
      expect(tags.includes("sandbox")).toBe(true);
    }
    expect(sandboxPage.items.length).toBeGreaterThanOrEqual(5);
  });

  test("bundled search: combined kind + text filter", async () => {
    const resolver = createCatalogResolver({
      adapters: [createBundledAdapter(BUNDLED_ENTRIES)],
    });

    // Search for middleware that mentions "retry"
    const page = await resolver.search({ kind: "middleware", text: "retry" });

    expect(page.items.length).toBe(2); // semantic-retry + guided-retry
    for (const item of page.items) {
      expect(item.kind).toBe("middleware");
    }
  });

  test("bundled entries total count matches expected", async () => {
    // Verify the bundled entries array has the expected total
    // 25 middleware + 6 channel + 4 engine + 10 sandbox + 3 tool + 21 infra = 69
    expect(BUNDLED_ENTRIES.length).toBe(69);
  });
});
