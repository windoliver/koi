/**
 * forge_tool — Creates a new tool through the verification pipeline.
 */

import type { Result, Tool } from "@koi/core";
import { brickId } from "@koi/core";
import type { ForgeError, ForgeResult, ForgeToolInput } from "@koi/forge-types";
import { staticError } from "@koi/forge-types";
import { delegateImplementation } from "./delegate.js";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import {
  buildBaseFields,
  createForgeTool,
  mapParsedBaseFields,
  mapParsedTestCases,
  parseToolInput,
  runForgePipeline,
} from "./shared.js";

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
      delegateTo: {
        type: "string",
        description: "Name of an external coding agent to delegate implementation to",
      },
      delegateOptions: {
        type: "object",
        description: "Options for the delegation (model, timeoutMs, retries)",
        properties: {
          model: { type: "string" },
          timeoutMs: { type: "number" },
          retries: { type: "number" },
        },
      },
    },
    required: ["name", "description", "inputSchema"],
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

  // Resolve implementation: either provided directly or via delegation
  // let justified: implementation may come from delegation below
  let implementation = parsed.value.implementation ?? "";

  if (parsed.value.delegateTo !== undefined) {
    // Build a ForgeToolInput for delegation prompt generation.
    // Use satisfies to validate shape without exactOptionalPropertyTypes conflict.
    const mappedForDelegation = mapParsedTestCases(parsed.value.testCases);
    const delegationInput = {
      kind: "tool" as const,
      name: parsed.value.name,
      description: parsed.value.description,
      inputSchema: parsed.value.inputSchema,
      implementation: "",
      ...(mappedForDelegation !== undefined ? { testCases: mappedForDelegation } : {}),
      ...(parsed.value.outputSchema !== undefined
        ? { outputSchema: parsed.value.outputSchema }
        : {}),
    } satisfies ForgeToolInput;
    const delegated = await delegateImplementation(
      parsed.value.delegateTo,
      delegationInput,
      deps,
      parsed.value.delegateOptions,
    );
    if (!delegated.ok) {
      return delegated;
    }
    implementation = delegated.value;
  } else if (implementation === "") {
    return {
      ok: false,
      error: staticError("MISSING_FIELD", "Either implementation or delegateTo must be provided"),
    };
  }

  const mapped = mapParsedTestCases(parsed.value.testCases);
  const forgeInput: ForgeToolInput = {
    kind: "tool",
    name: parsed.value.name,
    description: parsed.value.description,
    inputSchema: parsed.value.inputSchema,
    implementation,
    ...(mapped !== undefined ? { testCases: mapped } : {}),
    ...mapParsedBaseFields(parsed.value),
    ...(parsed.value.outputSchema !== undefined ? { outputSchema: parsed.value.outputSchema } : {}),
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
