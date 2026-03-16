/**
 * search_forge — Discovers existing bricks via ForgeStore queries.
 */

import type { BrickSummary, Result, Tool } from "@koi/core";
import type { BrickArtifact, ForgeError, ForgeQuery } from "@koi/forge-types";
import { filterByAgentScope, staticError } from "@koi/forge-types";
import { sortBricks } from "@koi/validation";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import { createForgeTool } from "./shared.js";

// ---------------------------------------------------------------------------
// Tool config
// ---------------------------------------------------------------------------

const VALID_ORDER_BY = new Set(["fitness", "recency", "usage"]);

const SEARCH_FORGE_CONFIG: ForgeToolConfig = {
  name: "search_forge",
  description:
    "Discovers existing forged bricks by kind, scope, tags, and other criteria. Results are ranked by fitness score (composite of success rate, recency, usage, and latency).",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string" },
      scope: { type: "string" },
      origin: { type: "string" },
      policy: { type: "string" },
      lifecycle: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      createdBy: { type: "string" },
      text: { type: "string" },
      limit: { type: "number" },
      orderBy: {
        type: "string",
        description: "Sort order: 'fitness' (default), 'recency', or 'usage'",
      },
      minFitnessScore: {
        type: "number",
        description: "Minimum fitness score (0-1). Bricks below this threshold are excluded.",
      },
      detail: {
        type: "string",
        description:
          "Result detail level: 'summary' (default, ~20 tokens/brick — name + description + tags only) or 'full' (complete artifact with implementation/schema).",
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
): Promise<Result<readonly BrickArtifact[] | readonly BrickSummary[], ForgeError>> {
  // Allow null/undefined (defaults to empty query), but reject non-objects
  if (input !== null && input !== undefined && typeof input !== "object") {
    return {
      ok: false,
      error: staticError("MISSING_FIELD", "Input must be a non-null object"),
    };
  }

  // All fields are optional — cast safely since ForgeQuery is all-optional
  const rawQuery = (input ?? {}) as ForgeQuery & { readonly detail?: string };

  // Extract detail level (default: "summary" for token efficiency)
  const detail = rawQuery.detail === "full" ? "full" : "summary";

  // Lightweight validation: clamp minFitnessScore to [0,1], default invalid orderBy
  const orderBy =
    rawQuery.orderBy !== undefined && VALID_ORDER_BY.has(rawQuery.orderBy)
      ? rawQuery.orderBy
      : "fitness";
  const clampedMin =
    rawQuery.minFitnessScore !== undefined
      ? Math.max(0, Math.min(1, rawQuery.minFitnessScore))
      : undefined;
  const query: ForgeQuery = {
    ...rawQuery,
    orderBy,
    ...(clampedMin !== undefined ? { minFitnessScore: clampedMin } : {}),
  };

  // Summary mode: return lightweight BrickSummary[] (~20 tokens/brick)
  if (detail === "summary") {
    const result = await deps.store.searchSummaries(query);
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
    // BrickSummary lacks scope/fitness fields — filter by agent ID on full search then project
    const fullResult = await deps.store.search(query);
    if (!fullResult.ok) {
      return {
        ok: false,
        error: {
          stage: "store",
          code: "SEARCH_FAILED",
          message: `Search failed: ${fullResult.error.message}`,
        },
      };
    }
    const scoped = filterByAgentScope(fullResult.value, deps.context.agentId, deps.context.zoneId);
    const ranked = sortBricks(scoped, query, { nowMs: Date.now() });
    const summaries: readonly BrickSummary[] = ranked.map(
      (b): BrickSummary => ({
        id: b.id,
        kind: b.kind,
        name: b.name,
        description: b.description,
        tags: b.tags,
      }),
    );
    return { ok: true, value: summaries };
  }

  // Full mode: return complete BrickArtifact[] (existing behavior)
  const result = await deps.store.search(query);

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
  const ranked = sortBricks(scoped, query, { nowMs: Date.now() });
  return { ok: true, value: ranked };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createSearchForgeTool(deps: ForgeDeps): Tool {
  return createForgeTool(SEARCH_FORGE_CONFIG, deps);
}
