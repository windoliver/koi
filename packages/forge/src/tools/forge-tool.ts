/**
 * forge_tool — Creates a new tool through the verification pipeline.
 */

import type { Result, Tool } from "@koi/core";
import type { ForgeError } from "../errors.js";
import type { BrickArtifact, ForgeResult, ForgeToolInput } from "../types.js";
import { verify } from "../verify.js";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import { createForgeTool, validateInputFields } from "./shared.js";

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
  };

  // Run verification pipeline
  const verifyResult = await verify(
    forgeInput,
    deps.context,
    deps.executor,
    deps.verifiers,
    deps.config,
  );

  if (!verifyResult.ok) {
    return { ok: false, error: verifyResult.error };
  }

  const report = verifyResult.value;
  const id = `brick_${crypto.randomUUID()}`;

  // Save to store
  const artifact: BrickArtifact = {
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
    tags: [],
    usageCount: 0,
    implementation: forgeInput.implementation,
    inputSchema: forgeInput.inputSchema,
    ...(forgeInput.testCases !== undefined ? { testCases: forgeInput.testCases } : {}),
  };

  const saveResult = await deps.store.save(artifact);
  if (!saveResult.ok) {
    return {
      ok: false,
      error: {
        stage: "store",
        code: "SAVE_FAILED",
        message: `Failed to save artifact: ${saveResult.error.message}`,
      },
    };
  }

  const forgeResult: ForgeResult = {
    id,
    kind: "tool",
    name: forgeInput.name,
    descriptor: {
      name: forgeInput.name,
      description: forgeInput.description,
      inputSchema: forgeInput.inputSchema,
    },
    trustTier: report.finalTrustTier,
    scope: deps.config.defaultScope,
    lifecycle: "active",
    verificationReport: report,
    metadata: {
      forgedAt: artifact.createdAt,
      forgedBy: deps.context.agentId,
      sessionId: deps.context.sessionId,
      depth: deps.context.depth,
    },
    forgesConsumed: 1,
  };

  return { ok: true, value: forgeResult };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createForgeToolTool(deps: ForgeDeps): Tool {
  return createForgeTool(FORGE_TOOL_CONFIG, deps);
}
