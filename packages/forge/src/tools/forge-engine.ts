/**
 * forge_engine — Creates a new engine brick through the verification pipeline.
 */

import type { Result, Tool } from "@koi/core";
import type { ForgeError } from "../errors.js";
import type { ForgeEngineInput, ForgeResult, ImplementationArtifact } from "../types.js";
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

const FORGE_ENGINE_CONFIG: ForgeToolConfig = {
  name: "forge_engine",
  description:
    "Creates a new engine brick by running it through the 4-stage verification pipeline. " +
    "Engines require 'verified' trust before attachment.",
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
  handler: forgeEngineHandler,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function forgeEngineHandler(
  input: unknown,
  deps: ForgeDeps,
): Promise<Result<ForgeResult, ForgeError>> {
  const parsed = parseImplementationInput(input);
  if (!parsed.ok) {
    return parsed;
  }

  const forgeInput: ForgeEngineInput = {
    kind: "engine",
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
  };

  return runForgePipeline(forgeInput, deps, (id, report) => {
    const contentHash = computeContentHash(forgeInput.implementation, forgeInput.files);
    const artifact: ImplementationArtifact = {
      ...buildBaseFields(id, forgeInput, report, deps, contentHash),
      kind: "engine",
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

export function createForgeEngineTool(deps: ForgeDeps): Tool {
  return createForgeTool(FORGE_ENGINE_CONFIG, deps);
}
