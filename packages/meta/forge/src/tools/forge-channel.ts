/**
 * forge_channel — Creates a new channel brick through the verification pipeline.
 */

import type { Result, Tool } from "@koi/core";
import { brickId } from "@koi/core";
import type { ForgeError } from "../errors.js";
import type { ForgeChannelInput, ForgeResult } from "../types.js";
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

const FORGE_CHANNEL_CONFIG: ForgeToolConfig = {
  name: "forge_channel",
  description:
    "Creates a new channel brick by running it through the 4-stage verification pipeline. " +
    "Channels require 'promoted' trust (HITL approval via promote_forge) before attachment.",
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
  handler: forgeChannelHandler,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function forgeChannelHandler(
  input: unknown,
  deps: ForgeDeps,
): Promise<Result<ForgeResult, ForgeError>> {
  const parsed = parseImplementationInput(input);
  if (!parsed.ok) {
    return parsed;
  }

  const mapped = mapParsedTestCases(parsed.value.testCases);
  const forgeInput: ForgeChannelInput = {
    kind: "channel",
    name: parsed.value.name,
    description: parsed.value.description,
    implementation: parsed.value.implementation,
    ...(mapped !== undefined ? { testCases: mapped } : {}),
    ...mapParsedBaseFields(parsed.value),
  };

  return runForgePipeline(forgeInput, deps, (report) => ({
    ...buildBaseFields(brickId("placeholder"), forgeInput, report, deps),
    kind: "channel" as const,
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

export function createForgeChannelTool(deps: ForgeDeps): Tool {
  return createForgeTool(FORGE_CHANNEL_CONFIG, deps);
}
