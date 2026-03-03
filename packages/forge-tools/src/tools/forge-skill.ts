/**
 * forge_skill — Creates a new SKILL.md (markdown-based knowledge unit).
 * Lighter verification — no sandbox stage for markdown content.
 */

import type { Result, Tool } from "@koi/core";
import { brickId } from "@koi/core";
import type { ForgeError, ForgeResult, ForgeSkillInput } from "@koi/forge-types";
import { generateSkillMd } from "../generate-skill-md.js";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import {
  buildBaseFields,
  createForgeTool,
  mapParsedBaseFields,
  parseSkillInput,
  runForgePipeline,
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

async function forgeSkillHandler(
  input: unknown,
  deps: ForgeDeps,
): Promise<Result<ForgeResult, ForgeError>> {
  const parsed = parseSkillInput(input);
  if (!parsed.ok) {
    return parsed;
  }

  const forgeInput: ForgeSkillInput = {
    kind: "skill",
    name: parsed.value.name,
    description: parsed.value.description,
    body: parsed.value.body,
    ...mapParsedBaseFields(parsed.value),
  };

  // Generate full SKILL.md with YAML frontmatter
  const generatedContent = generateSkillMd({
    name: forgeInput.name,
    description: forgeInput.description,
    ...(forgeInput.tags !== undefined ? { tags: forgeInput.tags } : {}),
    agentId: deps.context.agentId,
    version: "0.0.1",
    body: forgeInput.body,
  });

  return runForgePipeline(forgeInput, deps, (report) => ({
    ...buildBaseFields(brickId("placeholder"), forgeInput, report, deps),
    kind: "skill" as const,
    content: generatedContent,
    ...(forgeInput.files !== undefined ? { files: forgeInput.files } : {}),
    ...(forgeInput.requires !== undefined ? { requires: forgeInput.requires } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createForgeSkillTool(deps: ForgeDeps): Tool {
  return createForgeTool(FORGE_SKILL_CONFIG, deps);
}
