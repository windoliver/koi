/**
 * compose_forge — Groups multiple bricks into a metadata-only composite.
 * Validates all referenced brick IDs exist in the store before creating.
 * Computes trust as min(component trusts) for trust propagation.
 */

import type { BrickArtifact, Result, Tool, TrustTier } from "@koi/core";
import type { ForgeError } from "../errors.js";
import { staticError, storeError } from "../errors.js";
import { TRUST_ORDER } from "../governance.js";
import type {
  CompositeArtifact,
  CompositionBrickInfo,
  CompositionMetadata,
  ForgeCompositeInput,
  ForgeResult,
} from "../types.js";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import {
  buildBaseFields,
  computeContentHash,
  createForgeTool,
  parseCompositeInput,
  runForgePipeline,
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
      tags: { type: "array", items: { type: "string" } },
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
// Trust helpers
// ---------------------------------------------------------------------------

function computeMinTrustTier(bricks: readonly BrickArtifact[]): TrustTier {
  let min: TrustTier = "promoted";
  for (const brick of bricks) {
    if (TRUST_ORDER[brick.trustTier] < TRUST_ORDER[min]) {
      min = brick.trustTier;
    }
  }
  return min;
}

function minTrustTier(a: TrustTier, b: TrustTier): TrustTier {
  return TRUST_ORDER[a] <= TRUST_ORDER[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function composeForgeHandler(
  input: unknown,
  deps: ForgeDeps,
): Promise<Result<ForgeResult, ForgeError>> {
  const parsed = parseCompositeInput(input);
  if (!parsed.ok) {
    return parsed;
  }

  const compositeInput = parsed.value;

  // Check for duplicate brick IDs
  const uniqueIds = new Set(compositeInput.brickIds);
  if (uniqueIds.size !== compositeInput.brickIds.length) {
    return {
      ok: false,
      error: staticError("INVALID_SCHEMA", "Composite brickIds contain duplicate entries"),
    };
  }

  // Validate all referenced bricks exist (parallel loading — 14A)
  const loadResults = await Promise.all(compositeInput.brickIds.map((id) => deps.store.load(id)));

  const loadedBricks: BrickArtifact[] = [];
  const missingIds: string[] = [];
  for (let i = 0; i < loadResults.length; i++) {
    const loadResult = loadResults[i];
    if (loadResult === undefined || !loadResult.ok) {
      const brickId = compositeInput.brickIds[i];
      if (brickId !== undefined) {
        missingIds.push(brickId);
      }
    } else {
      loadedBricks.push(loadResult.value);
    }
  }

  if (missingIds.length > 0) {
    return {
      ok: false,
      error: storeError("LOAD_FAILED", `Referenced brick(s) not found: ${missingIds.join(", ")}`),
    };
  }

  // Compute minimum trust from components (3A)
  const componentMinTrust = computeMinTrustTier(loadedBricks);

  // Build composition metadata
  const compositionMetadata: CompositionMetadata = {
    bricks: loadedBricks.map(
      (b): CompositionBrickInfo => ({
        id: b.id,
        name: b.name,
        kind: b.kind,
        trustTier: b.trustTier,
      }),
    ),
    minimumTrustTier: componentMinTrust,
  };

  const forgeInput: ForgeCompositeInput = {
    kind: "composite",
    name: compositeInput.name,
    description: compositeInput.description,
    brickIds: compositeInput.brickIds,
    ...(compositeInput.tags !== undefined ? { tags: compositeInput.tags } : {}),
    ...(compositeInput.files !== undefined ? { files: compositeInput.files } : {}),
    ...(compositeInput.requires !== undefined
      ? {
          requires: {
            ...(compositeInput.requires.bins !== undefined
              ? { bins: compositeInput.requires.bins }
              : {}),
            ...(compositeInput.requires.env !== undefined
              ? { env: compositeInput.requires.env }
              : {}),
            ...(compositeInput.requires.tools !== undefined
              ? { tools: compositeInput.requires.tools }
              : {}),
          },
        }
      : {}),
  };

  return runForgePipeline(forgeInput, deps, (id, report) => {
    const contentHash = computeContentHash(forgeInput.brickIds.join(","), forgeInput.files);
    // Trust tier = min(pipeline trust, component trusts)
    const effectiveTrust = minTrustTier(report.finalTrustTier, componentMinTrust);
    const artifact: CompositeArtifact = {
      ...buildBaseFields(id, forgeInput, report, deps, contentHash),
      kind: "composite",
      trustTier: effectiveTrust,
      brickIds: forgeInput.brickIds,
      files: {
        ...(forgeInput.files ?? {}),
        "_composition.json": JSON.stringify(compositionMetadata),
      },
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
