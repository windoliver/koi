/**
 * compose_forge — Groups multiple bricks into a metadata-only composite.
 * Validates all referenced brick IDs exist in the store before creating.
 */

import type { Result, Tool } from "@koi/core";
import type { ForgeError } from "../errors.js";
import { staticError, storeError } from "../errors.js";
import type { CompositeArtifact, ForgeCompositeInput, ForgeResult } from "../types.js";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import {
  computeContentHash,
  createForgeTool,
  runForgePipeline,
  validateInputFields,
} from "./shared.js";

// ---------------------------------------------------------------------------
// Tool config
// ---------------------------------------------------------------------------

const COMPOSE_FORGE_CONFIG: ForgeToolConfig = {
  name: "compose_forge",
  description: "Groups multiple bricks into a composite through the verification pipeline",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      brickIds: { type: "array", items: { type: "string" } },
      files: { type: "object", description: "Companion files: relative path → content" },
      requires: {
        type: "object",
        description: "Runtime requirements (bins, env, tools)",
        properties: {
          bins: { type: "array", items: { type: "string" } },
          env: { type: "array", items: { type: "string" } },
          tools: { type: "array", items: { type: "string" } },
        },
      },
    },
    required: ["name", "description", "brickIds"],
  },
  handler: composeForgeHandler,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const COMPOSE_FORGE_FIELDS = [
  { name: "name", type: "string", required: true },
  { name: "description", type: "string", required: true },
  { name: "brickIds", type: "array", required: true },
  { name: "files", type: "object", required: false },
  { name: "requires", type: "object", required: false },
] as const;

async function composeForgeHandler(
  input: unknown,
  deps: ForgeDeps,
): Promise<Result<ForgeResult, ForgeError>> {
  const validationErr = validateInputFields(input, COMPOSE_FORGE_FIELDS);
  if (validationErr !== undefined) {
    return { ok: false, error: validationErr };
  }

  const compositeInput = input as ForgeCompositeInput;

  // Check for duplicate brick IDs
  const uniqueIds = new Set(compositeInput.brickIds);
  if (uniqueIds.size !== compositeInput.brickIds.length) {
    return {
      ok: false,
      error: staticError("INVALID_SCHEMA", `Composite brickIds contain duplicate entries`),
    };
  }

  // Validate all referenced bricks exist (parallel loading per decision 14B)
  const loadResults = await Promise.all(compositeInput.brickIds.map((id) => deps.store.load(id)));

  const missingIds: string[] = [];
  for (let i = 0; i < loadResults.length; i++) {
    const loadResult = loadResults[i];
    if (loadResult === undefined || !loadResult.ok) {
      const brickId = compositeInput.brickIds[i];
      if (brickId !== undefined) {
        missingIds.push(brickId);
      }
    }
  }

  if (missingIds.length > 0) {
    return {
      ok: false,
      error: storeError("LOAD_FAILED", `Referenced brick(s) not found: ${missingIds.join(", ")}`),
    };
  }

  const forgeInput: ForgeCompositeInput = {
    kind: "composite",
    name: compositeInput.name,
    description: compositeInput.description,
    brickIds: compositeInput.brickIds,
    ...(compositeInput.files !== undefined ? { files: compositeInput.files } : {}),
    ...(compositeInput.requires !== undefined ? { requires: compositeInput.requires } : {}),
  };

  return runForgePipeline(forgeInput, deps, (id, report) => {
    const artifact: CompositeArtifact = {
      id,
      kind: "composite",
      name: forgeInput.name,
      description: forgeInput.description,
      scope: deps.config.defaultScope,
      trustTier: report.finalTrustTier,
      lifecycle: "active",
      createdBy: deps.context.agentId,
      createdAt: Date.now(),
      version: "0.0.1",
      tags: forgeInput.tags ?? [],
      usageCount: 0,
      contentHash: computeContentHash(forgeInput.brickIds.join(","), forgeInput.files),
      brickIds: forgeInput.brickIds,
      ...(forgeInput.files !== undefined ? { files: forgeInput.files } : {}),
      ...(forgeInput.requires !== undefined ? { requires: forgeInput.requires } : {}),
    };
    return artifact;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createComposeForgeTool(deps: ForgeDeps): Tool {
  return createForgeTool(COMPOSE_FORGE_CONFIG, deps);
}
