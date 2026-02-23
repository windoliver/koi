/**
 * forge_skill — Creates a new SKILL.md (markdown-based knowledge unit).
 * Lighter verification — no sandbox stage for markdown content.
 */

import type { Result, Tool } from "@koi/core";
import type { ForgeError } from "../errors.js";
import type { ForgeResult, ForgeSkillInput, SkillArtifact } from "../types.js";
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

const FORGE_SKILL_CONFIG: ForgeToolConfig = {
  name: "forge_skill",
  description: "Creates a new skill (SKILL.md) — a reusable markdown-based knowledge unit",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      body: { type: "string" },
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
    },
    required: ["name", "description", "body"],
  },
  handler: forgeSkillHandler,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const FORGE_SKILL_FIELDS = [
  { name: "name", type: "string", required: true },
  { name: "description", type: "string", required: true },
  { name: "body", type: "string", required: true },
  { name: "tags", type: "array", required: false },
  { name: "files", type: "object", required: false },
  { name: "requires", type: "object", required: false },
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
    body: skillInput.body,
    ...(skillInput.tags !== undefined ? { tags: skillInput.tags } : {}),
    ...(skillInput.files !== undefined ? { files: skillInput.files } : {}),
    ...(skillInput.requires !== undefined ? { requires: skillInput.requires } : {}),
  };

  return runForgePipeline(forgeInput, deps, (id, report) => {
    const artifact: SkillArtifact = {
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
      contentHash: computeContentHash(forgeInput.body, forgeInput.files),
      content: forgeInput.body,
      ...(forgeInput.files !== undefined ? { files: forgeInput.files } : {}),
      ...(forgeInput.requires !== undefined ? { requires: forgeInput.requires } : {}),
    };
    return artifact;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createForgeSkillTool(deps: ForgeDeps): Tool {
  return createForgeTool(FORGE_SKILL_CONFIG, deps);
}
