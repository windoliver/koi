/**
 * forge_edit — Edit an existing forged brick's implementation via search-and-replace.
 *
 * Loads the brick from the store, applies the edit via @koi/edit-match cascading
 * match strategies, re-runs verification, and saves the result as a new brick
 * (immutable — new content-addressed BrickId).
 */

import type { BrickArtifact, BrickId, JsonObject, Result, Tool, ToolDescriptor } from "@koi/core";
import { brickId, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { applyEdit } from "@koi/edit-match";
import type { ForgeError, ForgeInput } from "@koi/forge-types";
import { staticError, storeError } from "@koi/forge-types";
import { z } from "zod";
import type { ForgeDeps } from "./shared.js";
import { requirePipeline, runForgePipeline } from "./shared.js";

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const forgeEditInputSchema = z.object({
  brickId: z.string(),
  searchBlock: z.string(),
  replaceBlock: z.string(),
  description: z.string().optional(),
});

interface ParsedEditInput {
  readonly brickId: string;
  readonly searchBlock: string;
  readonly replaceBlock: string;
  readonly description?: string | undefined;
}

function parseEditInput(input: unknown): Result<ParsedEditInput, ForgeError> {
  if (input === null || typeof input !== "object") {
    return { ok: false, error: staticError("MISSING_FIELD", "Input must be a non-null object") };
  }
  const result = forgeEditInputSchema.safeParse(input);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const msg = firstIssue !== undefined ? firstIssue.message : "Input validation failed";
    return { ok: false, error: staticError("INVALID_SCHEMA", msg) };
  }
  return { ok: true, value: result.data };
}

// ---------------------------------------------------------------------------
// Implementation extraction
// ---------------------------------------------------------------------------

/** Extract the mutable implementation string from an artifact, if the kind supports it. */
function extractImplementation(brick: BrickArtifact): string | undefined {
  if (brick.kind === "tool" || brick.kind === "middleware" || brick.kind === "channel") {
    return brick.implementation;
  }
  if (brick.kind === "skill") {
    return brick.content;
  }
  return undefined;
}

/** Create a new artifact with updated implementation. Returns undefined for agent kind. */
function withUpdatedImplementation(
  brick: BrickArtifact,
  newContent: string,
): BrickArtifact | undefined {
  switch (brick.kind) {
    case "tool":
      return { ...brick, implementation: newContent };
    case "middleware":
    case "channel":
      return { ...brick, implementation: newContent };
    case "skill":
      return { ...brick, content: newContent };
    case "agent":
    case "composite":
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function forgeEditHandler(
  input: unknown,
  deps: ForgeDeps,
): Promise<
  Result<
    { readonly id: BrickId; readonly strategy: string; readonly confidence: number },
    ForgeError
  >
> {
  const parsed = parseEditInput(input);
  if (!parsed.ok) {
    return parsed;
  }

  // Load existing brick
  const loadResult = await deps.store.load(brickId(parsed.value.brickId));
  if (!loadResult.ok) {
    return {
      ok: false,
      error: storeError("LOAD_FAILED", `Brick not found: ${parsed.value.brickId}`),
    };
  }

  const brick = loadResult.value;
  const implementation = extractImplementation(brick);
  if (implementation === undefined) {
    return {
      ok: false,
      error: staticError(
        "INVALID_TYPE",
        `Brick kind "${brick.kind}" does not support editing (no implementation field)`,
      ),
    };
  }

  // Apply edit via cascading match
  const editResult = applyEdit(implementation, parsed.value.searchBlock, parsed.value.replaceBlock);
  if (editResult === undefined) {
    return {
      ok: false,
      error: staticError(
        "INVALID_SCHEMA",
        "Search block not found in brick implementation. Ensure the search text uniquely matches a section of the code.",
      ),
    };
  }

  const updatedBrick = withUpdatedImplementation(brick, editResult.content);
  if (updatedBrick === undefined) {
    return {
      ok: false,
      error: staticError("INVALID_TYPE", "Cannot update implementation for this brick kind"),
    };
  }

  // Build forge input for re-verification
  const forgeInput = buildForgeInputFromArtifact(updatedBrick);
  if (forgeInput === undefined) {
    return {
      ok: false,
      error: staticError("INVALID_TYPE", "Cannot build forge input for brick kind"),
    };
  }

  // Delegate to the shared pipeline — handles verify → ID → provenance → sign → save → notify
  const pipelineResult = await runForgePipeline(
    forgeInput,
    deps,
    () => stripProvenanceFields(updatedBrick),
    {
      version: incrementVersion(brick.version),
      skipDedup: true, // Edits always produce a new brick
      evolution: {
        parentBrickId: brick.id,
        evolutionKind: "fix",
        ...(parsed.value.description !== undefined
          ? { description: parsed.value.description }
          : {}),
      },
    },
  );

  if (!pipelineResult.ok) {
    // Map pipeline errors to forge-edit error format
    const err = pipelineResult.error;
    if (err.stage === "store" && err.code === "SAVE_FAILED") {
      return {
        ok: false,
        error: storeError("SAVE_FAILED", err.message),
      };
    }
    return pipelineResult;
  }

  return {
    ok: true,
    value: {
      id: pipelineResult.value.id,
      strategy: editResult.match.strategy,
      confidence: editResult.match.confidence,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildForgeInputFromArtifact(brick: BrickArtifact): ForgeInput | undefined {
  const base = {
    name: brick.name,
    description: brick.description,
    ...(brick.tags.length > 0 ? { tags: brick.tags } : {}),
    ...(brick.files !== undefined ? { files: brick.files } : {}),
    ...(brick.requires !== undefined ? { requires: brick.requires } : {}),
  };

  switch (brick.kind) {
    case "tool":
      return {
        kind: "tool",
        ...base,
        inputSchema: brick.inputSchema,
        ...(brick.outputSchema !== undefined ? { outputSchema: brick.outputSchema } : {}),
        implementation: brick.implementation,
        ...(brick.testCases !== undefined ? { testCases: brick.testCases } : {}),
      };
    case "skill":
      return {
        kind: "skill",
        ...base,
        body: brick.content,
      };
    case "middleware":
      return {
        kind: "middleware",
        ...base,
        implementation: brick.implementation,
        ...(brick.testCases !== undefined ? { testCases: brick.testCases } : {}),
      };
    case "channel":
      return {
        kind: "channel",
        ...base,
        implementation: brick.implementation,
        ...(brick.testCases !== undefined ? { testCases: brick.testCases } : {}),
      };
    case "agent":
    case "composite":
      return undefined;
  }
}

/**
 * Strip provenance and identity fields from an artifact for the pipeline builder.
 * Pipeline will re-assign id, provenance, and version after verification + signing.
 */
function stripProvenanceFields(brick: BrickArtifact): Omit<BrickArtifact, "provenance"> {
  // Justified: spreading a discriminated union and omitting 'provenance' preserves the kind
  // discriminant, but TypeScript cannot prove this statically for Omit<Union, K>.
  const {
    provenance: _prov,
    storeVersion: _sv,
    lastVerifiedAt: _lv,
    ...rest
  } = brick as BrickArtifact & Record<string, unknown>;
  return rest as Omit<BrickArtifact, "provenance">;
}

/** Increment a semver patch version: "0.0.1" → "0.0.2". */
function incrementVersion(version: string): string {
  const parts = version.split(".");
  if (parts.length !== 3) {
    return "0.0.1";
  }
  const patch = Number.parseInt(parts[2] ?? "0", 10);
  return `${parts[0]}.${parts[1]}.${Number.isNaN(patch) ? 1 : patch + 1}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const FORGE_EDIT_DESCRIPTOR: ToolDescriptor = {
  name: "forge_edit",
  description:
    "Edit an existing forged brick via search-and-replace. Uses cascading match strategies (exact → whitespace-normalized → indentation-flexible → fuzzy). Creates a new immutable brick with re-verification.",
  inputSchema: {
    type: "object",
    properties: {
      brickId: { type: "string", description: "ID of the brick to edit" },
      searchBlock: {
        type: "string",
        description: "Code block to find in the implementation (must uniquely match)",
      },
      replaceBlock: {
        type: "string",
        description: "Code block to replace the matched section with",
      },
      description: {
        type: "string",
        description: "Optional description of the edit",
      },
    },
    required: ["brickId", "searchBlock", "replaceBlock"],
  },
};

export function createForgeEditTool(deps: ForgeDeps): Tool {
  const execute = async (input: JsonObject): Promise<unknown> => {
    const govResult = await requirePipeline(deps).checkGovernance(
      deps.context,
      deps.config,
      "forge_edit",
    );
    if (!govResult.ok) {
      return { ok: false, error: govResult.error };
    }
    return forgeEditHandler(input, deps);
  };

  return {
    descriptor: FORGE_EDIT_DESCRIPTOR,
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute,
  };
}
