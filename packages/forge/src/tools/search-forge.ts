/**
 * search_forge — Discovers existing bricks via ForgeStore queries.
 */

import type { Result, Tool } from "@koi/core";
import { sortBricks } from "@koi/validation";
import type { ForgeError } from "../errors.js";
import { staticError } from "../errors.js";
import { filterByAgentScope } from "../scope-filter.js";
import type { BrickArtifact, ForgeQuery } from "../types.js";
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
      trustTier: { type: "string" },
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

  // All fields are optional — cast safely since ForgeQuery is all-optional
  const rawQuery = (input ?? {}) as ForgeQuery;

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

  const scoped = filterByAgentScope(result.value, deps.context.agentId);
  const ranked = sortBricks(scoped, query, { nowMs: Date.now() });
  return { ok: true, value: ranked };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createSearchForgeTool(deps: ForgeDeps): Tool {
  return createForgeTool(SEARCH_FORGE_CONFIG, deps);
}
