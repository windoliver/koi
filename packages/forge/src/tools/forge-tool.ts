/**
 * forge_tool — Creates a new tool through the verification pipeline.
 */

import type { Result, Tool } from "@koi/core";
import type { ForgeError } from "../errors.js";
import type { ForgeResult, ForgeToolInput, ToolArtifact } from "../types.js";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import {
  computeContentHash,
  createForgeTool,
  runForgePipeline,
  validateInputFields,
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
    },
    required: ["name", "description", "inputSchema", "implementation"],
  },
  handler: forgeToolHandler,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const FORGE_TOOL_FIELDS = [
  { name: "name", type: "string", required: true },
  { name: "description", type: "string", required: true },
  { name: "inputSchema", type: "object", required: true },
  { name: "implementation", type: "string", required: true },
  { name: "testCases", type: "array", required: false },
  { name: "files", type: "object", required: false },
  { name: "requires", type: "object", required: false },
] as const;

async function forgeToolHandler(
  input: unknown,
  deps: ForgeDeps,
): Promise<Result<ForgeResult, ForgeError>> {
  const validationErr = validateInputFields(input, FORGE_TOOL_FIELDS);
  if (validationErr !== undefined) {
    return { ok: false, error: validationErr };
  }
  const toolInput = input as ForgeToolInput;
  const forgeInput: ForgeToolInput = {
    kind: "tool",
    name: toolInput.name,
    description: toolInput.description,
    inputSchema: toolInput.inputSchema,
    implementation: toolInput.implementation,
    ...(toolInput.testCases !== undefined ? { testCases: toolInput.testCases } : {}),
    ...(toolInput.files !== undefined ? { files: toolInput.files } : {}),
    ...(toolInput.requires !== undefined ? { requires: toolInput.requires } : {}),
  };

  return runForgePipeline(forgeInput, deps, (id, report) => {
    const artifact: ToolArtifact = {
      id,
      kind: "tool",
      name: forgeInput.name,
      description: forgeInput.description,
      scope: deps.config.defaultScope,
      trustTier: report.finalTrustTier,
      lifecycle: "active",
      createdBy: deps.context.agentId,
      createdAt: Date.now(),
      version: "0.0.1",
      tags: forgeInput.tags ?? [],
      usageCount: 0,
      contentHash: computeContentHash(forgeInput.implementation, forgeInput.files),
      implementation: forgeInput.implementation,
      inputSchema: forgeInput.inputSchema,
      ...(forgeInput.testCases !== undefined ? { testCases: forgeInput.testCases } : {}),
      ...(forgeInput.files !== undefined ? { files: forgeInput.files } : {}),
      ...(forgeInput.requires !== undefined ? { requires: forgeInput.requires } : {}),
    };
    return artifact;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createForgeToolTool(deps: ForgeDeps): Tool {
  return createForgeTool(FORGE_TOOL_CONFIG, deps);
}
