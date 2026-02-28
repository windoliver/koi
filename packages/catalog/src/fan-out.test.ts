/**
 * Tests for the fan-out utility.
 */

import { describe, expect, test } from "bun:test";
import type { CatalogEntry, CatalogQuery } from "@koi/core";
import { fanOut } from "./fan-out.js";
import type { CatalogSourceAdapter } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(
  source: CatalogSourceAdapter["source"],
  entries: readonly CatalogEntry[],
  shouldFail?: boolean,
): CatalogSourceAdapter {
  return {
    source,
    search: async (_query: CatalogQuery): Promise<readonly CatalogEntry[]> => {
      if (shouldFail === true) {
        throw new Error(`${source} failed`);
      }
      return entries;
    },
  };
}

const BUNDLED_ENTRY: CatalogEntry = {
  name: "bundled:@koi/middleware-audit",
  kind: "middleware",
  source: "bundled",
  description: "Audit middleware",
};

const FORGED_ENTRY: CatalogEntry = {
  name: "forged:my-tool",
  kind: "tool",
  source: "forged",
  description: "A forged tool",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fanOut", () => {
  test("merges results from multiple healthy sources", async () => {
    const adapters = [
      makeAdapter("bundled", [BUNDLED_ENTRY]),
      makeAdapter("forged", [FORGED_ENTRY]),
    ];

    const page = await fanOut(adapters, {});

    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.name).toBe("bundled:@koi/middleware-audit");
    expect(page.items[1]?.name).toBe("forged:my-tool");
    expect(page.total).toBe(2);
    expect(page.sourceErrors).toBeUndefined();
  });

  test("filters adapters by query.source", async () => {
    const adapters = [
      makeAdapter("bundled", [BUNDLED_ENTRY]),
      makeAdapter("forged", [FORGED_ENTRY]),
    ];

    const page = await fanOut(adapters, { source: "bundled" });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.name).toBe("bundled:@koi/middleware-audit");
  });

  test("collects errors from failed sources while returning healthy results", async () => {
    const adapters = [makeAdapter("bundled", [BUNDLED_ENTRY]), makeAdapter("forged", [], true)];

    const page = await fanOut(adapters, {});

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.name).toBe("bundled:@koi/middleware-audit");
    expect(page.sourceErrors).toHaveLength(1);
    expect(page.sourceErrors?.[0]?.source).toBe("forged");
    expect(page.sourceErrors?.[0]?.error.code).toBe("EXTERNAL");
  });
});
