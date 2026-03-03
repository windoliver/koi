/**
 * @koi/skills — Agent Skills Standard parser and progressive loader (Layer 2).
 *
 * Parses SKILL.md files (YAML frontmatter + markdown body) with 3-level
 * progressive loading (metadata → body → bundled) to minimize context window usage.
 */

// Catalog integration
export { discoverSkillCatalogEntries, mapSkillToCatalogEntry } from "./catalog.js";
// Loader
export {
  clearSkillCache,
  discoverSkillDirs,
  loadSkill,
  loadSkillBody,
  loadSkillBundled,
  loadSkillMetadata,
} from "./loader.js";
// Parse
export type { ParsedSkillMd } from "./parse.js";
export { parseSkillMd } from "./parse.js";
// Provider
export type { SkillProviderConfig } from "./provider.js";
export { createSkillComponentProvider } from "./provider.js";
// Include resolution
export { resolveIncludes } from "./resolve-includes.js";
// Skill activator middleware
export type { SkillActivatorConfig } from "./skill-activator-middleware.js";
export { createSkillActivatorMiddleware } from "./skill-activator-middleware.js";
// Types
export type {
  IncludeResolutionOptions,
  ProgressiveSkillProvider,
  ResolvedInclude,
  SkillBodyEntry,
  SkillBundledEntry,
  SkillEntry,
  SkillLoadLevel,
  SkillMetadataEntry,
  SkillReference,
  SkillScript,
} from "./types.js";
export { isAtOrAbove, LEVEL_ORDER } from "./types.js";
// Validate
export type { ValidatedSkillFrontmatter } from "./validate.js";
export { validateSkillFrontmatter } from "./validate.js";
