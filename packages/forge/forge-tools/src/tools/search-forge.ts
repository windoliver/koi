/**
 * search_forge — Discovers existing bricks via ForgeStore queries or hybrid retrieval.
 *
 * When a `Retriever` is injected (via ForgeDeps), `query` triggers BM25+vector
 * hybrid search through Nexus Search. Falls back to ForgeStore.search() when
 * no retriever is available or on retriever error.
 */

import type { BrickArtifact, BrickId, Result, Tool } from "@koi/core";
import type { ForgeError, ForgeQuery } from "@koi/forge-types";
import { filterByAgentScope, staticError } from "@koi/forge-types";
import { sortBricks } from "@koi/validation";
import { z } from "zod";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import { createForgeTool } from "./shared.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_ORDER_BY = new Set(["fitness", "recency", "usage"]);

/** Over-fetch multiplier for retriever results to compensate for post-filtering. */
const DEFAULT_OVER_FETCH_MULTIPLIER = 3;

// ---------------------------------------------------------------------------
// Zod input schema (replaces unsafe `as ForgeQuery` cast)
// ---------------------------------------------------------------------------

const searchInputSchema = z
  .object({
    query: z.string().optional(),
    kind: z.string().optional(),
    scope: z.string().optional(),
    origin: z.string().optional(),
    policy: z.string().optional(),
    lifecycle: z.string().optional(),
    tags: z.array(z.string()).optional(),
    createdBy: z.string().optional(),
    text: z.string().optional(),
    limit: z.number().optional(),
    orderBy: z.string().optional(),
    minFitnessScore: z.number().optional(),
  })
  .optional();

type SearchInput = z.infer<typeof searchInputSchema>;

// ---------------------------------------------------------------------------
// Tool config
// ---------------------------------------------------------------------------

const SEARCH_FORGE_CONFIG: ForgeToolConfig = {
  name: "search_forge",
  description:
    "Discovers existing forged bricks by kind, scope, tags, and other criteria. Use the `query` field for natural-language semantic search (e.g., 'visualize data'). Results are ranked by relevance when using query, or by fitness score for structured filters.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Natural-language search query. Triggers hybrid BM25+vector retrieval when available.",
      },
      kind: { type: "string" },
      scope: { type: "string" },
      origin: { type: "string" },
      policy: { type: "string" },
      lifecycle: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      createdBy: { type: "string" },
      text: { type: "string", description: "Substring match (legacy). Prefer `query`." },
      limit: { type: "number" },
      orderBy: {
        type: "string",
        description: "Sort order: 'fitness' (default), 'recency', or 'usage'",
      },
      minFitnessScore: {
        type: "number",
        description: "Minimum fitness score (0-1). Bricks below this threshold are excluded.",
      },
    },
  },
  handler: searchForgeHandler,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function searchForgeHandler(
  input: unknown,
  deps: ForgeDeps,
): Promise<Result<readonly BrickArtifact[], ForgeError>> {
  // Allow null/undefined (defaults to empty query), but reject non-objects
  if (input !== null && input !== undefined && typeof input !== "object") {
    return {
      ok: false,
      error: staticError("MISSING_FIELD", "Input must be a non-null object"),
    };
  }

  const parsed = searchInputSchema.safeParse(input);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return {
      ok: false,
      error: staticError(
        "INVALID_SCHEMA",
        `Invalid search input: ${firstIssue?.message ?? "validation failed"}`,
      ),
    };
  }

  const raw = parsed.data ?? {};
  const query = raw.query ?? raw.text;
  const limit = raw.limit ?? 20;

  // Normalize orderBy and minFitnessScore
  const orderBy =
    raw.orderBy !== undefined && VALID_ORDER_BY.has(raw.orderBy) ? raw.orderBy : "fitness";
  const clampedMin =
    raw.minFitnessScore !== undefined ? Math.max(0, Math.min(1, raw.minFitnessScore)) : undefined;

  // --- Retriever path: hybrid BM25+vector search ---
  if (query !== undefined && query.length > 0 && deps.retriever !== undefined) {
    const retrieverResult = await retrieverSearch(query, limit, raw, deps);
    if (retrieverResult !== undefined) {
      return retrieverResult;
    }
    // Fall through to store path on retriever failure
  }

  // --- Store path: structured ForgeStore.search() ---
  return storeSearch(raw, query, orderBy, clampedMin, limit, deps);
}

// ---------------------------------------------------------------------------
// Retriever-based search
// ---------------------------------------------------------------------------

/**
 * Attempt hybrid retrieval. Returns a Result on success, or undefined to signal
 * fallback to the store path (on retriever error).
 */
async function retrieverSearch(
  query: string,
  limit: number,
  raw: NonNullable<SearchInput>,
  deps: ForgeDeps,
): Promise<Result<readonly BrickArtifact[], ForgeError> | undefined> {
  try {
    const retriever = deps.retriever;
    if (retriever === undefined) return undefined;

    const overFetchLimit = limit * DEFAULT_OVER_FETCH_MULTIPLIER;
    const searchResult = await retriever.retrieve({
      text: query,
      limit: overFetchLimit,
    });

    if (!searchResult.ok) {
      // Non-fatal: fall back to store search
      if (deps.onError !== undefined) {
        deps.onError(
          new Error(`Retriever search failed: ${searchResult.error.message}`, {
            cause: searchResult.error,
          }),
        );
      }
      return undefined;
    }

    // Resolve result IDs → BrickArtifact[] via parallel store.load()
    const loadPromises = searchResult.value.results.map(async (r) => {
      const loadResult = await deps.store.load(r.id as BrickId);
      return loadResult.ok ? loadResult.value : undefined;
    });
    const loaded = await Promise.all(loadPromises);

    // Filter out failed loads, preserving retriever relevance ordering
    let bricks: readonly BrickArtifact[] = loaded.filter(
      (b): b is BrickArtifact => b !== undefined,
    );

    // Post-filter by metadata
    bricks = postFilterByMetadata(bricks, raw);

    // Agent scope filtering
    bricks = filterByAgentScope(bricks, deps.context.agentId, deps.context.zoneId);

    // Fitness score filtering
    if (raw.minFitnessScore !== undefined) {
      const min = Math.max(0, Math.min(1, raw.minFitnessScore));
      bricks = bricks.filter((b) => {
        if (b.fitness === undefined) return false;
        const total = b.fitness.successCount + b.fitness.errorCount;
        if (total === 0) return false;
        return b.fitness.successCount / total >= min;
      });
    }

    // Truncate to requested limit (relevance ordering preserved from retriever)
    return { ok: true, value: bricks.slice(0, limit) };
  } catch (e: unknown) {
    if (deps.onError !== undefined) {
      deps.onError(e);
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Store-based search (fallback)
// ---------------------------------------------------------------------------

async function storeSearch(
  raw: NonNullable<SearchInput>,
  query: string | undefined,
  orderBy: string,
  clampedMin: number | undefined,
  limit: number,
  deps: ForgeDeps,
): Promise<Result<readonly BrickArtifact[], ForgeError>> {
  // Build ForgeQuery imperatively to satisfy exactOptionalPropertyTypes —
  // conditional spread can leak `undefined` into optional fields.
  const forgeQuery = Object.assign(
    { orderBy, limit } as ForgeQuery,
    raw.kind !== undefined ? { kind: raw.kind } : null,
    raw.scope !== undefined ? { scope: raw.scope } : null,
    raw.lifecycle !== undefined ? { lifecycle: raw.lifecycle } : null,
    raw.tags !== undefined ? { tags: raw.tags } : null,
    raw.createdBy !== undefined ? { createdBy: raw.createdBy } : null,
    query !== undefined ? { text: query } : null,
    clampedMin !== undefined ? { minFitnessScore: clampedMin } : null,
  );

  const result = await deps.store.search(forgeQuery);

  if (!result.ok) {
    return {
      ok: false,
      error: {
        stage: "store",
        code: "SEARCH_FAILED",
        message: `Search failed: ${result.error.message}`,
      },
    };
  }

  const scoped = filterByAgentScope(result.value, deps.context.agentId, deps.context.zoneId);
  const ranked = sortBricks(scoped, forgeQuery, { nowMs: Date.now() });
  return { ok: true, value: ranked };
}

// ---------------------------------------------------------------------------
// Post-filter helpers
// ---------------------------------------------------------------------------

/**
 * Filters bricks by metadata fields (kind, scope, lifecycle, tags)
 * after retriever returns results. The retriever doesn't understand
 * forge-specific metadata, so we filter client-side.
 */
function postFilterByMetadata(
  bricks: readonly BrickArtifact[],
  raw: NonNullable<SearchInput>,
): readonly BrickArtifact[] {
  let filtered = bricks;

  if (raw.kind !== undefined) {
    filtered = filtered.filter((b) => b.kind === raw.kind);
  }
  if (raw.scope !== undefined) {
    filtered = filtered.filter((b) => b.scope === raw.scope);
  }
  if (raw.lifecycle !== undefined) {
    filtered = filtered.filter((b) => b.lifecycle === raw.lifecycle);
  }
  if (raw.tags !== undefined && raw.tags.length > 0) {
    const requiredTags = new Set(raw.tags);
    filtered = filtered.filter((b) => b.tags.some((t) => requiredTags.has(t)));
  }

  return filtered;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createSearchForgeTool(deps: ForgeDeps): Tool {
  return createForgeTool(SEARCH_FORGE_CONFIG, deps);
}
