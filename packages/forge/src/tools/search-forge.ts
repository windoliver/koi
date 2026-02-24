/**
 * search_forge — Discovers existing bricks via ForgeStore queries.
 */

import type { Result, Tool } from "@koi/core";
import type { ForgeError } from "../errors.js";
import { staticError } from "../errors.js";
import { filterByAgentScope } from "../scope-filter.js";
import type { BrickArtifact, ForgeQuery } from "../types.js";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import { createForgeTool } from "./shared.js";

// ---------------------------------------------------------------------------
// Tool config
// ---------------------------------------------------------------------------

const SEARCH_FORGE_CONFIG: ForgeToolConfig = {
  name: "search_forge",
  description: "Discovers existing forged bricks by kind, scope, tags, and other criteria",
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
  const query = (input ?? {}) as ForgeQuery;
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

  const filtered = filterByAgentScope(result.value, deps.context.agentId);
  return { ok: true, value: filtered };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createSearchForgeTool(deps: ForgeDeps): Tool {
  return createForgeTool(SEARCH_FORGE_CONFIG, deps);
}
