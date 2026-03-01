/**
 * forge_tool — Creates a new tool through the verification pipeline.
 */

import type { Result, Tool } from "@koi/core";
import { brickId } from "@koi/core";
import type { ForgeError } from "../errors.js";
import type { ForgeResult, ForgeToolInput } from "../types.js";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import { buildBaseFields, createForgeTool, parseToolInput, runForgePipeline } from "./shared.js";

// ---------------------------------------------------------------------------
// Tool config
// ---------------------------------------------------------------------------

const FORGE_TOOL_CONFIG: ForgeToolConfig = {
  name: "forge_tool",
  description: "Creates a new tool by running it through the 4-stage verification pipeline",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      inputSchema: { type: "object" },
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
        description: "Runtime requirements (bins, env, tools, npm packages)",
        properties: {
          bins: { type: "array", items: { type: "string" } },
          env: { type: "array", items: { type: "string" } },
          tools: { type: "array", items: { type: "string" } },
          packages: {
            type: "object",
            description:
              'npm packages: package name → exact semver version (e.g. { "zod": "3.22.0" })',
          },
          network: {
            type: "boolean",
            description: "Whether this brick requires network access at runtime (default: false)",
          },
        },
      },
      configSchema: { type: "object", description: "JSON Schema for brick config parameters" },
      outputSchema: {
        type: "object",
        description: "JSON Schema describing the tool's output shape",
      },
    },
    required: ["name", "description", "inputSchema", "implementation"],
  },
  handler: forgeToolHandler,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function forgeToolHandler(
  input: unknown,
  deps: ForgeDeps,
): Promise<Result<ForgeResult, ForgeError>> {
  const parsed = parseToolInput(input);
  if (!parsed.ok) {
    return parsed;
  }

  const forgeInput: ForgeToolInput = {
    kind: "tool",
    name: parsed.value.name,
    description: parsed.value.description,
    inputSchema: parsed.value.inputSchema,
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
            ...(parsed.value.requires.packages !== undefined
              ? { packages: parsed.value.requires.packages }
              : {}),
            ...(parsed.value.requires.network !== undefined
              ? { network: parsed.value.requires.network }
              : {}),
          },
        }
      : {}),
    ...(parsed.value.outputSchema !== undefined ? { outputSchema: parsed.value.outputSchema } : {}),
    ...(parsed.value.configSchema !== undefined ? { configSchema: parsed.value.configSchema } : {}),
    ...(parsed.value.classification !== undefined
      ? { classification: parsed.value.classification }
      : {}),
    ...(parsed.value.contentMarkers !== undefined
      ? { contentMarkers: parsed.value.contentMarkers }
      : {}),
  };

  // Placeholder id — pipeline replaces with content-addressed hash
  return runForgePipeline(forgeInput, deps, (report) => ({
    ...buildBaseFields(brickId("placeholder"), forgeInput, report, deps),
    kind: "tool" as const,
    implementation: forgeInput.implementation,
    inputSchema: forgeInput.inputSchema,
    ...(forgeInput.outputSchema !== undefined ? { outputSchema: forgeInput.outputSchema } : {}),
    ...(forgeInput.testCases !== undefined ? { testCases: forgeInput.testCases } : {}),
    ...(forgeInput.files !== undefined ? { files: forgeInput.files } : {}),
    ...(forgeInput.requires !== undefined ? { requires: forgeInput.requires } : {}),
    ...(forgeInput.configSchema !== undefined ? { configSchema: forgeInput.configSchema } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createForgeToolTool(deps: ForgeDeps): Tool {
  return createForgeTool(FORGE_TOOL_CONFIG, deps);
}
