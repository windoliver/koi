/**
 * forge_edit — Edit an existing forged brick's implementation via search-and-replace.
 *
 * Loads the brick from the store, applies the edit via @koi/edit-match cascading
 * match strategies, re-runs verification, and saves the result as a new brick
 * (immutable — new content-addressed BrickId).
 */

import type {
  BrickArtifact,
  BrickId,
  ForgeProvenance,
  JsonObject,
  Result,
  Tool,
  ToolDescriptor,
} from "@koi/core";
import { brickId } from "@koi/core";
import { applyEdit } from "@koi/edit-match";
import { computeBrickId } from "@koi/hash";
import { z } from "zod";
import { createForgeProvenance, signAttestation } from "../attestation.js";
import { extractBrickContent } from "../brick-content.js";
import type { ForgeError } from "../errors.js";
import { staticError, storeError } from "../errors.js";
import { checkGovernance } from "../governance.js";
import type { ForgeInput } from "../types.js";
import { verify } from "../verify.js";
import type { ForgeDeps } from "./shared.js";

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

  // Re-run verification pipeline
  const { executor: sandboxExecutor } = deps.executor.forTier(brick.trustTier);
  const verifyResult = await verify(
    forgeInput,
    deps.context,
    sandboxExecutor,
    deps.verifiers,
    deps.config,
  );
  if (!verifyResult.ok) {
    return { ok: false, error: verifyResult.error };
  }

  // Compute new content-addressed ID
  const { kind, content } = extractBrickContent(updatedBrick);
  const newId = computeBrickId(kind, content, updatedBrick.files);

  // Build new provenance
  const startedAt = Date.now();
  let provenance = createForgeProvenance({
    input: forgeInput,
    context: deps.context,
    report: verifyResult.value,
    config: deps.config,
    contentHash: newId,
    invocationId: newId,
    startedAt,
    finishedAt: Date.now(),
  });

  if (deps.signer !== undefined) {
    provenance = await signAttestation(provenance, deps.signer);
  }

  // Save new brick (immutable — new ID)
  const newArtifact = withNewIdentity(
    updatedBrick,
    newId,
    provenance,
    incrementVersion(brick.version),
  );

  const saveResult = await deps.store.save(newArtifact);
  if (!saveResult.ok) {
    return {
      ok: false,
      error: storeError("SAVE_FAILED", `Failed to save edited brick: ${saveResult.error.message}`),
    };
  }

  return {
    ok: true,
    value: {
      id: newId,
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
      return undefined;
  }
}

/** Create a new immutable artifact with updated identity fields. */
function withNewIdentity(
  brick: BrickArtifact,
  newId: BrickId,
  provenance: ForgeProvenance,
  version: string,
): BrickArtifact {
  const now = Date.now();
  switch (brick.kind) {
    case "tool":
      return { ...brick, id: newId, provenance, version, lastVerifiedAt: now };
    case "skill":
      return { ...brick, id: newId, provenance, version, lastVerifiedAt: now };
    case "middleware":
      return { ...brick, id: newId, provenance, version, lastVerifiedAt: now };
    case "channel":
      return { ...brick, id: newId, provenance, version, lastVerifiedAt: now };
    case "agent":
      return { ...brick, id: newId, provenance, version, lastVerifiedAt: now };
  }
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
    const govResult = await checkGovernance(deps.context, deps.config, "forge_edit");
    if (!govResult.ok) {
      return { ok: false, error: govResult.error };
    }
    return forgeEditHandler(input, deps);
  };

  return {
    descriptor: FORGE_EDIT_DESCRIPTOR,
    trustTier: "promoted",
    execute,
  };
}
