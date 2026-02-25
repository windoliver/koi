/**
 * forge_middleware — Creates a new middleware brick through the verification pipeline.
 */

import type { Result, Tool } from "@koi/core";
import type { ForgeError } from "../errors.js";
import type { ForgeMiddlewareInput, ForgeResult, ImplementationArtifact } from "../types.js";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import {
  buildBaseFields,
  computeContentHash,
  createForgeTool,
  parseImplementationInput,
  runForgePipeline,
} from "./shared.js";

// ---------------------------------------------------------------------------
// Tool config
// ---------------------------------------------------------------------------

const FORGE_MIDDLEWARE_CONFIG: ForgeToolConfig = {
  name: "forge_middleware",
  description:
    "Creates a new middleware brick by running it through the 4-stage verification pipeline. " +
    "Middleware requires 'promoted' trust (HITL approval via promote_forge) before attachment.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      implementation: { type: "string" },
      testCases: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            input: {},
            expectedOutput: {},
            shouldThrow: { type: "boolean" },
          },
          required: ["name", "input"],
        },
      },
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
      configSchema: { type: "object", description: "JSON Schema for brick config parameters" },
    },
    required: ["name", "description", "implementation"],
  },
  handler: forgeMiddlewareHandler,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function forgeMiddlewareHandler(
  input: unknown,
  deps: ForgeDeps,
): Promise<Result<ForgeResult, ForgeError>> {
  const parsed = parseImplementationInput(input);
  if (!parsed.ok) {
    return parsed;
  }

  const forgeInput: ForgeMiddlewareInput = {
    kind: "middleware",
    name: parsed.value.name,
    description: parsed.value.description,
    implementation: parsed.value.implementation,
    ...(parsed.value.testCases !== undefined
      ? {
          testCases: parsed.value.testCases.map((tc) => ({
            name: tc.name,
            input: tc.input,
            ...(tc.expectedOutput !== undefined ? { expectedOutput: tc.expectedOutput } : {}),
            ...(tc.shouldThrow !== undefined ? { shouldThrow: tc.shouldThrow } : {}),
          })),
        }
      : {}),
    ...(parsed.value.tags !== undefined ? { tags: parsed.value.tags } : {}),
    ...(parsed.value.files !== undefined ? { files: parsed.value.files } : {}),
    ...(parsed.value.requires !== undefined
      ? {
          requires: {
            ...(parsed.value.requires.bins !== undefined
              ? { bins: parsed.value.requires.bins }
              : {}),
            ...(parsed.value.requires.env !== undefined ? { env: parsed.value.requires.env } : {}),
            ...(parsed.value.requires.tools !== undefined
              ? { tools: parsed.value.requires.tools }
              : {}),
          },
        }
      : {}),
    ...(parsed.value.configSchema !== undefined ? { configSchema: parsed.value.configSchema } : {}),
    ...(parsed.value.classification !== undefined
      ? { classification: parsed.value.classification }
      : {}),
    ...(parsed.value.contentMarkers !== undefined
      ? { contentMarkers: parsed.value.contentMarkers }
      : {}),
  };

  return runForgePipeline(forgeInput, deps, (id, report) => {
    const contentHash = computeContentHash(forgeInput.implementation, forgeInput.files);
    const artifact: ImplementationArtifact = {
      ...buildBaseFields(id, forgeInput, report, deps, contentHash),
      kind: "middleware",
      implementation: forgeInput.implementation,
      ...(forgeInput.testCases !== undefined ? { testCases: forgeInput.testCases } : {}),
      ...(forgeInput.files !== undefined ? { files: forgeInput.files } : {}),
      ...(forgeInput.requires !== undefined ? { requires: forgeInput.requires } : {}),
      ...(forgeInput.configSchema !== undefined ? { configSchema: forgeInput.configSchema } : {}),
    };
    return artifact;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createForgeMiddlewareTool(deps: ForgeDeps): Tool {
  return createForgeTool(FORGE_MIDDLEWARE_CONFIG, deps);
}
