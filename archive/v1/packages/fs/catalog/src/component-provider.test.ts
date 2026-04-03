/**
 * Tests for createCatalogComponentProvider.
 */

import { describe, expect, test } from "bun:test";
import type {
  CatalogEntry,
  CatalogPage,
  CatalogQuery,
  CatalogReader,
  KoiError,
  Result,
} from "@koi/core";
import { COMPONENT_PRIORITY, toolToken } from "@koi/core";
import { createMockAgent } from "@koi/test-utils";

import { createCatalogComponentProvider } from "./component-provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createStubReader(): CatalogReader {
  return {
    search: async (_query: CatalogQuery): Promise<CatalogPage> => ({ items: [], total: 0 }),
    get: async (name: string): Promise<Result<CatalogEntry, KoiError>> => ({
      ok: false,
      error: { code: "NOT_FOUND", message: `Not found: ${name}`, retryable: false },
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCatalogComponentProvider", () => {
  test("attaches search_catalog and attach_capability tools", async () => {
    const provider = createCatalogComponentProvider({ reader: createStubReader() });
    const agent = createMockAgent();
    const result = await provider.attach(agent);

    // AttachResult shape
    expect("components" in result).toBe(true);
    expect("skipped" in result).toBe(true);

    const components = "components" in result ? result.components : result;

    const searchKey: string = toolToken("search_catalog");
    const attachKey: string = toolToken("attach_capability");

    expect(components.has(searchKey)).toBe(true);
    expect(components.has(attachKey)).toBe(true);
    expect(components.size).toBe(2);
  });

  test("uses COMPONENT_PRIORITY.BUNDLED", () => {
    const provider = createCatalogComponentProvider({ reader: createStubReader() });
    expect(provider.priority).toBe(COMPONENT_PRIORITY.BUNDLED);
    expect(provider.priority).toBe(100);
  });

  test("provider name is 'catalog'", () => {
    const provider = createCatalogComponentProvider({ reader: createStubReader() });
    expect(provider.name).toBe("catalog");
  });

  test("default onAttach returns INTERNAL error when not configured", async () => {
    const reader = createStubReader();
    // Override get to return a tool entry
    const readerWithEntry: CatalogReader = {
      ...reader,
      get: async (): Promise<Result<CatalogEntry, KoiError>> => ({
        ok: true,
        value: {
          name: "bundled:@koi/forge",
          kind: "tool",
          source: "bundled",
          description: "Forge",
        },
      }),
    };

    const provider = createCatalogComponentProvider({ reader: readerWithEntry });
    const agent = createMockAgent();
    const result = await provider.attach(agent);
    const components = "components" in result ? result.components : result;

    const attachKey: string = toolToken("attach_capability");
    const attachTool = components.get(attachKey) as {
      readonly execute: (args: Record<string, unknown>) => Promise<unknown>;
    };

    const attachResult = (await attachTool.execute({ name: "bundled:@koi/forge" })) as Record<
      string,
      unknown
    >;

    expect(attachResult.ok).toBe(false);
    expect(attachResult.code).toBe("INTERNAL");
    expect(attachResult.message as string).toContain("not configured");
  });

  test("skipped array is empty", async () => {
    const provider = createCatalogComponentProvider({ reader: createStubReader() });
    const agent = createMockAgent();
    const result = await provider.attach(agent);

    if ("skipped" in result) {
      expect(result.skipped).toHaveLength(0);
    }
  });
});
