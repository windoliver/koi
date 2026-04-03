/**
 * @koi/skill-stack — Skill composition meta-package (Layer 3)
 *
 * Composes skill providers with progressive loading, gating, hot-plug, and file watching.
 *
 * Usage:
 * ```typescript
 * import { createSkillStack } from "@koi/skill-stack";
 *
 * const { provider, middleware, mount, unmount, dispose } = await createSkillStack({
 *   skills: manifest.skills,
 *   basePath: manifestDir,
 *   preset: "standard",
 *   watch: true,
 *   overrideDirs: ["/path/to/custom-skills"],
 * });
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────────
export type { SkillStackPresetSpec } from "./presets.js";
// ── Constants ───────────────────────────────────────────────────────────
export { SKILL_STACK_PRESET_SPECS } from "./presets.js";
export { createSkillStack } from "./skill-stack.js";
export type {
  ResolvedSkillStackMeta,
  SkillStackBundle,
  SkillStackConfig,
  SkillStackPreset,
  SkillUserConfig,
} from "./types.js";
