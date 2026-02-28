/**
 * Catalog integration — maps discovered SKILL.md files to CatalogEntry objects.
 *
 * Enables auto-discovery of bundled skills for the catalog system.
 * The consumer merges these entries with static bundled entries and passes
 * them to createBundledAdapter() from @koi/catalog.
 *
 * Layer-safe: imports only from @koi/core (L0), not from @koi/catalog (L2 peer).
 */

import type { CatalogEntry, KoiError, Result } from "@koi/core";
import { discoverSkillDirs, loadSkillMetadata } from "./loader.js";
import type { SkillMetadataEntry } from "./types.js";

/**
 * Maps a loaded skill metadata entry to a CatalogEntry for the catalog system.
 *
 * Uses source "bundled" since these are filesystem-bundled skills shipped with
 * the codebase. Names are prefixed with "bundled:" following the catalog naming
 * convention.
 */
export function mapSkillToCatalogEntry(entry: SkillMetadataEntry): CatalogEntry {
  return {
    name: `bundled:${entry.name}`,
    kind: "skill",
    source: "bundled",
    description: entry.description,
    ...(entry.allowedTools !== undefined && entry.allowedTools.length > 0
      ? { tags: [...entry.allowedTools] }
      : {}),
  };
}

/**
 * Discovers SKILL.md files under a base path and returns CatalogEntry objects.
 *
 * Partial success: skills that fail to load are skipped without error (the
 * caller can use discoverSkillDirs + loadSkillMetadata directly for more control).
 * Loads are parallelized for performance.
 */
export async function discoverSkillCatalogEntries(
  basePath: string,
): Promise<Result<readonly CatalogEntry[], KoiError>> {
  const dirsResult = await discoverSkillDirs(basePath);
  if (!dirsResult.ok) return dirsResult;

  const results = await Promise.all(dirsResult.value.map((dirPath) => loadSkillMetadata(dirPath)));

  const entries = results
    .filter((r): r is { readonly ok: true; readonly value: SkillMetadataEntry } => r.ok)
    .map((r) => mapSkillToCatalogEntry(r.value));

  return { ok: true, value: entries };
}
