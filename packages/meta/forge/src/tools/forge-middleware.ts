/**
 * forge_middleware — Creates a new middleware brick through the verification pipeline.
 */

import type { Result, Tool } from "@koi/core";
import { brickId } from "@koi/core";
import type { ForgeError } from "../errors.js";
import type { ForgeMiddlewareInput, ForgeResult } from "../types.js";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import {
  buildBaseFields,
  createForgeTool,
  mapParsedBaseFields,
  mapParsedTestCases,
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
        description: "Runtime requirements (bins, env, tools, agents, npm packages)",
        properties: {
          bins: { type: "array", items: { type: "string" } },
          env: { type: "array", items: { type: "string" } },
          tools: { type: "array", items: { type: "string" } },
          agents: {
            type: "array",
            items: { type: "string" },
            description: "Agent brick names required as peer dependencies",
          },
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

  const mapped = mapParsedTestCases(parsed.value.testCases);
  const forgeInput: ForgeMiddlewareInput = {
    kind: "middleware",
    name: parsed.value.name,
    description: parsed.value.description,
    implementation: parsed.value.implementation,
    ...(mapped !== undefined ? { testCases: mapped } : {}),
    ...mapParsedBaseFields(parsed.value),
  };

  return runForgePipeline(forgeInput, deps, (report) => ({
    ...buildBaseFields(brickId("placeholder"), forgeInput, report, deps),
    kind: "middleware" as const,
    implementation: forgeInput.implementation,
    ...(forgeInput.testCases !== undefined ? { testCases: forgeInput.testCases } : {}),
    ...(forgeInput.files !== undefined ? { files: forgeInput.files } : {}),
    ...(forgeInput.requires !== undefined ? { requires: forgeInput.requires } : {}),
    ...(forgeInput.configSchema !== undefined ? { configSchema: forgeInput.configSchema } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createForgeMiddlewareTool(deps: ForgeDeps): Tool {
  return createForgeTool(FORGE_MIDDLEWARE_CONFIG, deps);
}
