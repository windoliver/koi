import { describe, expect, test } from "bun:test";
import type { BrickArtifact, BrickPage } from "@koi/core";
import { brickId, DEFAULT_SANDBOXED_POLICY, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { createRegistrySearchTool } from "./registry-search.js";
import { createMockFacade } from "./test-helpers.js";

const TOOL_ARTIFACT: BrickArtifact = {
  id: brickId("brick_search-test"),
  kind: "tool",
  name: "search-test",
  description: "A searchable tool",
  scope: "agent",
  origin: "primordial",
  policy: DEFAULT_SANDBOXED_POLICY,
  lifecycle: "active",
  provenance: DEFAULT_PROVENANCE,
  version: "1.0.0",
  tags: ["utility", "test"],
  usageCount: 5,
  implementation: "return 1;",
  inputSchema: { type: "object" },
};

describe("registry_search tool", () => {
  test("returns empty items for no results", async () => {
    const facade = createMockFacade();
    const tool = createRegistrySearchTool(facade, "registry", DEFAULT_UNSANDBOXED_POLICY);

    const result = await tool.execute({});
    expect(result).toEqual({ items: [], cursor: undefined, total: 0 });
  });

  test("passes text, kind, tags to backend", async () => {
    let capturedQuery: unknown;
    const facade = createMockFacade({
      bricks: {
        search: (query) => {
          capturedQuery = query;
          return { items: [], total: 0 };
        },
      },
    });
    const tool = createRegistrySearchTool(facade, "registry", DEFAULT_UNSANDBOXED_POLICY);

    await tool.execute({ text: "http", kind: "tool", tags: ["utility"], limit: 10 });

    expect(capturedQuery).toEqual({
      text: "http",
      kind: "tool",
      tags: ["utility"],
      limit: 10,
      cursor: undefined,
    });
  });

  test("maps results to summary (omits implementation, inputSchema)", async () => {
    const page: BrickPage = { items: [TOOL_ARTIFACT], total: 1 };
    const facade = createMockFacade({
      bricks: { search: () => page },
    });
    const tool = createRegistrySearchTool(facade, "registry", DEFAULT_UNSANDBOXED_POLICY);

    const result = (await tool.execute({})) as Record<string, unknown>;
    const items = result.items as readonly Record<string, unknown>[];

    expect(items).toHaveLength(1);
    expect(items[0]?.name).toBe("search-test");
    expect(items[0]?.implementation).toBeUndefined();
    expect(items[0]?.inputSchema).toBeUndefined();
    expect(items[0]?.provenance).toBeUndefined();
    expect(items[0]?.fitness).toBeUndefined();
    expect(items[0]?.files).toBeUndefined();
  });

  test("passes cursor for pagination", async () => {
    let capturedCursor: string | undefined;
    const facade = createMockFacade({
      bricks: {
        search: (query) => {
          capturedCursor = query.cursor;
          return { items: [], total: 0 };
        },
      },
    });
    const tool = createRegistrySearchTool(facade, "registry", DEFAULT_UNSANDBOXED_POLICY);

    await tool.execute({ cursor: "abc123" });
    expect(capturedCursor).toBe("abc123");
  });

  test("clamps limit to max 50", async () => {
    let capturedLimit: number | undefined;
    const facade = createMockFacade({
      bricks: {
        search: (query) => {
          capturedLimit = query.limit;
          return { items: [], total: 0 };
        },
      },
    });
    const tool = createRegistrySearchTool(facade, "registry", DEFAULT_UNSANDBOXED_POLICY);

    await tool.execute({ limit: 100 });
    expect(capturedLimit).toBe(50);
  });

  test("returns validation error for invalid kind", async () => {
    const facade = createMockFacade();
    const tool = createRegistrySearchTool(facade, "registry", DEFAULT_UNSANDBOXED_POLICY);

    const result = (await tool.execute({ kind: "invalid" })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("returns validation error for non-array tags", async () => {
    const facade = createMockFacade();
    const tool = createRegistrySearchTool(facade, "registry", DEFAULT_UNSANDBOXED_POLICY);

    const result = (await tool.execute({ tags: "not-array" })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });
});
