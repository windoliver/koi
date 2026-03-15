/**
 * forge_middleware + forge_channel — Creates implementation bricks (middleware or channel)
 * through the verification pipeline.
 *
 * Both brick kinds share identical input schemas and handler logic — the only difference
 * is `kind` and the tool name/description. This file merges the two into a single factory.
 */

import type { Result, Tool } from "@koi/core";
import { brickId } from "@koi/core";
import type {
  ForgeChannelInput,
  ForgeError,
  ForgeMiddlewareInput,
  ForgeResult,
  VerificationReport,
} from "@koi/forge-types";
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
// Shared implementation input schema (identical for middleware and channel)
// ---------------------------------------------------------------------------

const IMPLEMENTATION_INPUT_SCHEMA: Readonly<Record<string, unknown>> = {
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
          input: { type: "object", description: "Test case input object" },
          expectedOutput: { type: "object", description: "Expected output object" },
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
};

// ---------------------------------------------------------------------------
// Unified factory
// ---------------------------------------------------------------------------

function createImplementationForgeHandler(
  kind: "middleware" | "channel",
): (input: unknown, deps: ForgeDeps) => Promise<Result<ForgeResult, ForgeError>> {
  return async (input, deps) => {
    const parsed = parseImplementationInput(input);
    if (!parsed.ok) {
      return parsed;
    }

    const mapped = mapParsedTestCases(parsed.value.testCases);
    const forgeInput: ForgeMiddlewareInput | ForgeChannelInput = {
      kind,
      name: parsed.value.name,
      description: parsed.value.description,
      implementation: parsed.value.implementation,
      ...(mapped !== undefined ? { testCases: mapped } : {}),
      ...mapParsedBaseFields(parsed.value),
    };

    return runForgePipeline(forgeInput, deps, (report: VerificationReport) => ({
      ...buildBaseFields(brickId("placeholder"), forgeInput, report, deps),
      kind: kind as "middleware" | "channel",
      implementation: forgeInput.implementation,
      ...(forgeInput.testCases !== undefined ? { testCases: forgeInput.testCases } : {}),
      ...(forgeInput.files !== undefined ? { files: forgeInput.files } : {}),
      ...(forgeInput.requires !== undefined ? { requires: forgeInput.requires } : {}),
      ...(forgeInput.configSchema !== undefined ? { configSchema: forgeInput.configSchema } : {}),
    }));
  };
}

// ---------------------------------------------------------------------------
// Public API — drop-in replacements for the original separate factories
// ---------------------------------------------------------------------------

export function createForgeMiddlewareTool(deps: ForgeDeps): Tool {
  const config: ForgeToolConfig = {
    name: "forge_middleware",
    description:
      "Creates a new middleware brick by running it through the 4-stage verification pipeline. " +
      "Middleware requires 'promoted' trust (HITL approval via promote_forge) before attachment.",
    inputSchema: IMPLEMENTATION_INPUT_SCHEMA,
    handler: createImplementationForgeHandler("middleware"),
  };
  return createForgeTool(config, deps);
}

export function createForgeChannelTool(deps: ForgeDeps): Tool {
  const config: ForgeToolConfig = {
    name: "forge_channel",
    description:
      "Creates a new channel brick by running it through the 4-stage verification pipeline. " +
      "Channels require 'promoted' trust (HITL approval via promote_forge) before attachment.",
    inputSchema: IMPLEMENTATION_INPUT_SCHEMA,
    handler: createImplementationForgeHandler("channel"),
  };
  return createForgeTool(config, deps);
}
