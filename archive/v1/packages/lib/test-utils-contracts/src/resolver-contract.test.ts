/**
 * Self-test for the resolver contract suite.
 *
 * Exercises testResolverContract with two mock implementations:
 * 1. An empty resolver (no items) — verifies NOT_FOUND behavior.
 * 2. A seeded resolver (with items + onChange + source) — verifies
 *    discover → load round-trip and optional method contracts.
 */

import { describe } from "bun:test";
import { notFound } from "@koi/core";
import type { KoiError, Result } from "@koi/core/errors";
import type { Resolver, SourceBundle } from "@koi/core/resolver";
import { testResolverContract } from "./resolver-contract.js";

// ---------------------------------------------------------------------------
// Types for the mock resolver
// ---------------------------------------------------------------------------

interface MockMeta {
  readonly id: string;
  readonly label: string;
}

interface MockFull {
  readonly id: string;
  readonly label: string;
  readonly data: string;
}

// ---------------------------------------------------------------------------
// Empty resolver — no items seeded
// ---------------------------------------------------------------------------

function createEmptyResolver(): Resolver<MockMeta, MockFull> {
  return {
    discover: async (): Promise<readonly MockMeta[]> => [],

    load: async (id: string): Promise<Result<MockFull, KoiError>> => ({
      ok: false,
      error: notFound(id),
    }),
  };
}

describe("resolver contract — empty (no items)", () => {
  testResolverContract<MockMeta, MockFull>({
    createResolver: createEmptyResolver,
    getId: (meta) => meta.id,
  });
});

// ---------------------------------------------------------------------------
// Seeded resolver — with items, onChange, and source
// ---------------------------------------------------------------------------

const SEED_ITEMS: readonly MockMeta[] = [
  { id: "item-1", label: "First" },
  { id: "item-2", label: "Second" },
] as const;

function createSeededResolver(): Resolver<MockMeta, MockFull> {
  const items = new Map<string, MockFull>(
    SEED_ITEMS.map((m) => [m.id, { ...m, data: `data-for-${m.id}` }]),
  );

  const listeners = new Set<() => void>();

  return {
    discover: async (): Promise<readonly MockMeta[]> => SEED_ITEMS,

    load: async (id: string): Promise<Result<MockFull, KoiError>> => {
      const item = items.get(id);
      if (item === undefined) {
        return { ok: false, error: notFound(id) };
      }
      return { ok: true, value: item };
    },

    onChange: (listener: () => void): (() => void) => {
      listeners.add(listener);
      let removed = false; // let: toggled in unsubscribe closure
      return (): void => {
        if (removed) return;
        removed = true;
        listeners.delete(listener);
      };
    },

    source: async (id: string): Promise<Result<SourceBundle, KoiError>> => {
      if (!items.has(id)) {
        return { ok: false, error: notFound(id) };
      }
      return {
        ok: true,
        value: {
          content: `// source for ${id}`,
          language: "typescript",
        },
      };
    },
  };
}

describe("resolver contract — seeded (with onChange + source)", () => {
  testResolverContract<MockMeta, MockFull>({
    createResolver: createSeededResolver,
    seedItems: SEED_ITEMS,
    getId: (meta) => meta.id,
  });
});
