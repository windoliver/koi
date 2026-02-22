/**
 * forge_skill — Creates a new SKILL.md (markdown-based knowledge unit).
 * Lighter verification — no sandbox stage for markdown content.
 */

import type { Result, Tool } from "@koi/core";
import type { ForgeError } from "../errors.js";
import type { BrickArtifact, ForgeResult, ForgeSkillInput } from "../types.js";
import { verify } from "../verify.js";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import { createForgeTool, validateInputFields } from "./shared.js";

// ---------------------------------------------------------------------------
// Tool config
// ---------------------------------------------------------------------------

const FORGE_SKILL_CONFIG: ForgeToolConfig = {
  name: "forge_skill",
  description: "Creates a new skill (SKILL.md) — a reusable markdown-based knowledge unit",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      content: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["name", "description", "content"],
  },
  handler: forgeSkillHandler,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const FORGE_SKILL_FIELDS = [
  { name: "name", type: "string", required: true },
  { name: "description", type: "string", required: true },
  { name: "content", type: "string", required: true },
  { name: "tags", type: "array", required: false },
] as const;

async function forgeSkillHandler(
  input: unknown,
  deps: ForgeDeps,
): Promise<Result<ForgeResult, ForgeError>> {
  const validationErr = validateInputFields(input, FORGE_SKILL_FIELDS);
  if (validationErr !== undefined) {
    return { ok: false, error: validationErr };
  }
  const skillInput = input as ForgeSkillInput;
  const forgeInput: ForgeSkillInput = {
    kind: "skill",
    name: skillInput.name,
    description: skillInput.description,
    content: skillInput.content,
    ...(skillInput.tags !== undefined ? { tags: skillInput.tags } : {}),
  };

  // Run verification pipeline (sandbox and self-test will skip for skills)
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

  const artifact: BrickArtifact = {
    id,
    kind: "skill",
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
    content: forgeInput.content,
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
    kind: "skill",
    name: forgeInput.name,
    descriptor: {
      name: forgeInput.name,
      description: forgeInput.description,
      inputSchema: {},
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

export function createForgeSkillTool(deps: ForgeDeps): Tool {
  return createForgeTool(FORGE_SKILL_CONFIG, deps);
}
