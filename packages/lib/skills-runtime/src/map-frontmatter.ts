/**
 * Shared helper to map ValidatedFrontmatter → SkillMetadata / SkillDefinition.
 *
 * DRY extraction (Decision 5A): this pattern was duplicated in discover.ts,
 * loader.ts, and provider.ts. Now all three call this single helper.
 */

import type { SkillDefinition, SkillMetadata, SkillSource, ValidatedFrontmatter } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Maps validated frontmatter fields + source context into a SkillMetadata.
 * Only includes optional fields when they are defined (no undefined spreading).
 */
export function mapFrontmatterToMetadata(
  fm: ValidatedFrontmatter,
  source: SkillSource,
  dirPath: string,
): SkillMetadata {
  return {
    name: fm.name,
    description: fm.description,
    source,
    dirPath,
    ...(fm.tags !== undefined ? { tags: fm.tags } : {}),
    ...(fm.license !== undefined ? { license: fm.license } : {}),
    ...(fm.compatibility !== undefined ? { compatibility: fm.compatibility } : {}),
    ...(fm.allowedTools !== undefined ? { allowedTools: fm.allowedTools } : {}),
    ...(fm.requires !== undefined ? { requires: fm.requires } : {}),
    ...(fm.metadata !== undefined ? { metadata: fm.metadata } : {}),
    ...(fm.executionMode !== undefined ? { executionMode: fm.executionMode } : {}),
    ...(fm.references !== undefined ? { references: fm.references } : {}),
  };
}

/**
 * Maps validated frontmatter + body + source context into a SkillDefinition.
 * Builds on mapFrontmatterToMetadata(), adding the body field.
 */
export function mapFrontmatterToDefinition(
  fm: ValidatedFrontmatter,
  body: string,
  source: SkillSource,
  dirPath: string,
): SkillDefinition {
  return {
    ...mapFrontmatterToMetadata(fm, source, dirPath),
    body,
  };
}
