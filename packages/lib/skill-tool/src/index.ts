/**
 * @koi/skill-tool — SkillTool meta-tool for on-demand skill loading and dispatch.
 *
 * L2 package. Imports from @koi/core (L0) only.
 *
 * Usage:
 *   import { createSkillTool } from "@koi/skill-tool";
 *   const result = await createSkillTool({ resolver: runtime, signal });
 *   if (result.ok) { // result.value is a Tool }
 */

export { createSkillTool } from "./create-skill-tool.js";
export { formatSkillDescription } from "./format-description.js";
export { extractSpawnConfig, mapSkillToSpawnRequest } from "./map-spawn.js";
export { substituteVariables } from "./substitute.js";
export type {
  LoadedSkill,
  SkillMeta,
  SkillResolver,
  SkillToolConfig,
  SkillVariables,
  SpawnConfig,
} from "./types.js";
