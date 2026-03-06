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
import { brickId, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { applyEdit } from "@koi/edit-match";
import type { ForgeError, ForgeInput, ForgePipeline } from "@koi/forge-types";
import { staticError, storeError } from "@koi/forge-types";
import { computeBrickId } from "@koi/hash";
import { z } from "zod";
import type { ForgeDeps } from "./shared.js";

// ---------------------------------------------------------------------------
// Pipeline-aware helpers — L2 package uses pipeline (no direct cross-L2 imports)
// ---------------------------------------------------------------------------

function getVerify(deps: ForgeDeps): ForgePipeline["verify"] {
  if (deps.pipeline === undefined) {
    throw new Error("ForgePipeline is required in @koi/forge-tools");
  }
  return deps.pipeline.verify;
}

function getCreateProvenance(deps: ForgeDeps): ForgePipeline["createProvenance"] {
  if (deps.pipeline === undefined) {
    throw new Error("ForgePipeline is required in @koi/forge-tools");
  }
  return deps.pipeline.createProvenance;
}

function getSignAttestation(deps: ForgeDeps): ForgePipeline["signAttestation"] {
  if (deps.pipeline === undefined) {
    throw new Error("ForgePipeline is required in @koi/forge-tools");
  }
  return deps.pipeline.signAttestation;
}

function getExtractBrickContent(deps: ForgeDeps): ForgePipeline["extractBrickContent"] {
  if (deps.pipeline === undefined) {
    throw new Error("ForgePipeline is required in @koi/forge-tools");
  }
  return deps.pipeline.extractBrickContent;
}

function getCheckGovernance(deps: ForgeDeps): ForgePipeline["checkGovernance"] {
  if (deps.pipeline === undefined) {
    throw new Error("ForgePipeline is required in @koi/forge-tools");
  }
  return deps.pipeline.checkGovernance;
}

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

  // Re-run verification pipeline
  const verifyResult = await getVerify(deps)(
    forgeInput,
    deps.context,
    deps.executor,
    deps.verifiers,
    deps.config,
  );
  if (!verifyResult.ok) {
    return { ok: false, error: verifyResult.error };
  }

  // Compute new content-addressed ID
  const { kind, content } = getExtractBrickContent(deps)(updatedBrick);
  const newId = computeBrickId(kind, content, updatedBrick.files);

  // Build new provenance
  const startedAt = Date.now();
  // let justified: provenance may be signed in-place below
  let provenance = getCreateProvenance(deps)({
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
    provenance = await getSignAttestation(deps)(provenance, deps.signer);
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
    case "composite":
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
    const govResult = await getCheckGovernance(deps)(deps.context, deps.config, "forge_edit");
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
