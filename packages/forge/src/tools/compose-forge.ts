/**
 * compose_forge — Composes multiple bricks of the same kind into a single composite.
 *
 * Loads all referenced bricks from the store, validates they are the same kind,
 * merges their content, and runs the result through the standard forge pipeline
 * (verify → content-addressed ID → save).
 *
 * v1: same-kind only (tool+tool or skill+skill). Mixed kinds are rejected.
 */

import type { BrickArtifact, Result, Tool } from "@koi/core";
import { brickId } from "@koi/core";
import type { ForgeError } from "../errors.js";
import { staticError, storeError } from "../errors.js";
import { generateSkillMd } from "../generate-skill-md.js";
import type { ForgeResult, ForgeSkillInput, ForgeToolInput } from "../types.js";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import {
  buildBaseFields,
  createForgeTool,
  parseCompositeInput,
  runForgePipeline,
} from "./shared.js";

// ---------------------------------------------------------------------------
// Tool config
// ---------------------------------------------------------------------------

const COMPOSE_FORGE_CONFIG: ForgeToolConfig = {
  name: "compose_forge",
  description:
    "Composes multiple bricks of the same kind into a single composite brick. Merges implementations (tools) or content (skills), runs verification, and saves with a content-addressed ID.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name for the composite brick" },
      description: { type: "string", description: "Description for the composite brick" },
      brickIds: {
        type: "array",
        items: { type: "string" },
        description: "IDs of bricks to compose (must all be the same kind)",
      },
      tags: { type: "array", items: { type: "string" } },
      files: { type: "object", description: "Additional companion files: relative path → content" },
    },
    required: ["name", "description", "brickIds"],
  },
  handler: composeForgeHandler,
};

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

  if (parsed.value.brickIds.length < 2) {
    return {
      ok: false,
      error: staticError("INVALID_SCHEMA", "compose_forge requires at least 2 brickIds"),
    };
  }

  // Load all bricks in parallel
  const loadResults = await Promise.all(
    parsed.value.brickIds.map((id) => deps.store.load(brickId(id))),
  );

  const bricks: BrickArtifact[] = [];
  for (let i = 0; i < loadResults.length; i++) {
    const result = loadResults[i];
    if (result === undefined || !result.ok) {
      return {
        ok: false,
        error: storeError(
          "LOAD_FAILED",
          `Brick not found: ${parsed.value.brickIds[i] ?? "unknown"}`,
        ),
      };
    }
    // justified: mutable local array being constructed, not shared state
    bricks.push(result.value);
  }

  // Validate all same kind
  const firstBrick = bricks[0];
  if (firstBrick === undefined) {
    return {
      ok: false,
      error: staticError("INVALID_SCHEMA", "No bricks loaded"),
    };
  }

  const kind = firstBrick.kind;
  const mixedKind = bricks.find((b) => b.kind !== kind);
  if (mixedKind !== undefined) {
    return {
      ok: false,
      error: staticError(
        "INVALID_TYPE",
        `All bricks must be the same kind. Expected "${kind}" but found "${mixedKind.kind}". Mixed-kind composition is not supported in v1.`,
      ),
    };
  }

  // Merge based on kind and run through forge pipeline
  if (kind === "tool") {
    const merged = mergeTools(bricks, parsed.value);
    if (!merged.ok) return merged;

    return runForgePipeline(merged.value, deps, (report) => ({
      ...buildBaseFields(brickId("placeholder"), merged.value, report, deps),
      kind: "tool" as const,
      implementation: merged.value.implementation,
      inputSchema: merged.value.inputSchema,
      ...(merged.value.testCases !== undefined ? { testCases: merged.value.testCases } : {}),
      ...(merged.value.files !== undefined ? { files: merged.value.files } : {}),
    }));
  }

  if (kind === "skill") {
    const merged = mergeSkills(bricks, parsed.value);
    if (!merged.ok) return merged;

    const generatedContent = generateSkillMd({
      name: parsed.value.name,
      description: parsed.value.description,
      ...(parsed.value.tags !== undefined ? { tags: parsed.value.tags } : {}),
      agentId: deps.context.agentId,
      version: "0.0.1",
      body: merged.value.body,
    });

    return runForgePipeline(merged.value, deps, (report) => ({
      ...buildBaseFields(brickId("placeholder"), merged.value, report, deps),
      kind: "skill" as const,
      content: generatedContent,
      ...(merged.value.files !== undefined ? { files: merged.value.files } : {}),
    }));
  }

  return {
    ok: false,
    error: staticError(
      "INVALID_TYPE",
      `compose_forge does not support "${kind}" bricks in v1. Only "tool" and "skill" are supported.`,
    ),
  };
}

// ---------------------------------------------------------------------------
// Kind-specific merge logic
// ---------------------------------------------------------------------------

interface CompositeFields {
  readonly name: string;
  readonly description: string;
  readonly tags?: readonly string[] | undefined;
  readonly files?: Readonly<Record<string, string>> | undefined;
}

function mergeTools(
  bricks: readonly BrickArtifact[],
  fields: CompositeFields,
): Result<ForgeToolInput, ForgeError> {
  const implementations: string[] = [];
  const mergedProperties: Record<string, unknown> = {};
  const mergedRequired: string[] = [];
  const mergedTestCases: Array<{
    readonly name: string;
    readonly input: unknown;
    readonly expectedOutput?: unknown;
    readonly shouldThrow?: boolean;
  }> = [];
  let mergedFiles: Record<string, string> = {};

  for (const brick of bricks) {
    if (brick.kind !== "tool") continue;

    implementations.push(`// --- ${brick.name} ---\n${brick.implementation}`);

    // Merge inputSchema properties (union)
    const schema = brick.inputSchema;
    if (typeof schema === "object" && schema !== null) {
      const props = (schema as Record<string, unknown>).properties;
      if (typeof props === "object" && props !== null) {
        Object.assign(mergedProperties, props);
      }
      const req = (schema as Record<string, unknown>).required;
      if (Array.isArray(req)) {
        for (const r of req) {
          if (typeof r === "string" && !mergedRequired.includes(r)) {
            mergedRequired.push(r);
          }
        }
      }
    }

    // Merge test cases with name-spacing
    if (brick.testCases !== undefined) {
      for (const tc of brick.testCases) {
        mergedTestCases.push({
          name: `[${brick.name}] ${tc.name}`,
          input: tc.input,
          ...(tc.expectedOutput !== undefined ? { expectedOutput: tc.expectedOutput } : {}),
          ...(tc.shouldThrow !== undefined ? { shouldThrow: tc.shouldThrow } : {}),
        });
      }
    }

    // Merge companion files
    if (brick.files !== undefined) {
      mergedFiles = { ...mergedFiles, ...brick.files };
    }
  }

  // Overlay caller-provided files
  if (fields.files !== undefined) {
    mergedFiles = { ...mergedFiles, ...fields.files };
  }

  const inputSchema: Record<string, unknown> = {
    type: "object",
    properties: mergedProperties,
    ...(mergedRequired.length > 0 ? { required: mergedRequired } : {}),
  };

  const forgeInput: ForgeToolInput = {
    kind: "tool",
    name: fields.name,
    description: fields.description,
    inputSchema,
    implementation: implementations.join("\n\n"),
    ...(mergedTestCases.length > 0 ? { testCases: mergedTestCases } : {}),
    ...(fields.tags !== undefined ? { tags: fields.tags } : {}),
    ...(Object.keys(mergedFiles).length > 0 ? { files: mergedFiles } : {}),
  };

  return { ok: true, value: forgeInput };
}

function mergeSkills(
  bricks: readonly BrickArtifact[],
  fields: CompositeFields,
): Result<ForgeSkillInput, ForgeError> {
  const sections: string[] = [];
  let mergedFiles: Record<string, string> = {};

  for (const brick of bricks) {
    if (brick.kind !== "skill") continue;
    sections.push(`## ${brick.name}\n\n${brick.content}`);

    if (brick.files !== undefined) {
      mergedFiles = { ...mergedFiles, ...brick.files };
    }
  }

  if (fields.files !== undefined) {
    mergedFiles = { ...mergedFiles, ...fields.files };
  }

  const forgeInput: ForgeSkillInput = {
    kind: "skill",
    name: fields.name,
    description: fields.description,
    body: sections.join("\n\n---\n\n"),
    ...(fields.tags !== undefined ? { tags: fields.tags } : {}),
    ...(Object.keys(mergedFiles).length > 0 ? { files: mergedFiles } : {}),
  };

  return { ok: true, value: forgeInput };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createComposeForge(deps: ForgeDeps): Tool {
  return createForgeTool(COMPOSE_FORGE_CONFIG, deps);
}
