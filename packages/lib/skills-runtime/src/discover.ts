/**
 * Multi-source skill discovery — walks bundled/user/project roots.
 *
 * Precedence (highest first): project > user > bundled.
 * When two tiers define the same skill name, the higher-priority tier wins.
 * Decision 4A: shadow warning emitted via onShadowedSkill callback.
 *
 * Progressive loading: reads frontmatter during discovery so SkillMetadata
 * (description, tags, allowedTools, etc.) is available without calling load().
 * Skills with unparseable frontmatter get minimal metadata (name from dirname).
 *
 * Decision 6A (extended): skillsRoot is resolved once per tier root here,
 * stored in DiscoveredSkillEntry, and reused by the loader (no per-load realpath).
 */

import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { KoiError, Result } from "@koi/core";
import { mapFrontmatterToMetadata } from "./map-frontmatter.js";
import { parseSkillMd } from "./parse.js";
import type { SkillMetadata, SkillSource } from "./types.js";
import { validateFrontmatter } from "./validate.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Ordered tiers from lowest to highest priority. */
const TIER_ORDER: readonly SkillSource[] = ["bundled", "user", "project"] as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A fully resolved entry for a discovered skill.
 * Merges source, dirPath, pre-resolved skillsRoot (Decision 6A),
 * and frontmatter-derived metadata (progressive loading).
 */
export interface DiscoveredSkillEntry {
  readonly source: SkillSource;
  readonly dirPath: string;
  /** Pre-resolved absolute path to the tier root. Used by loader for path traversal check. */
  readonly skillsRoot: string;
  /** Frontmatter metadata (no body, no security scan). May be minimal if frontmatter fails. */
  readonly metadata: SkillMetadata;
}

export interface DiscoverConfig {
  readonly projectRoot?: string;
  readonly userRoot?: string;
  readonly bundledRoot?: string | null;
  readonly onShadowedSkill?: (name: string, shadowedBy: SkillSource) => void;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discovers all available skill directories across the three source tiers.
 *
 * Returns a map of skill name → DiscoveredSkillEntry, which includes:
 * - The winning SkillSource tier
 * - The absolute dirPath
 * - The pre-resolved skillsRoot (Decision 6A)
 * - SkillMetadata from frontmatter (progressive loading — no body)
 *
 * Decision 4A: calls onShadowedSkill for each skill shadowed by a higher tier.
 */
export async function discoverSkills(
  config: DiscoverConfig,
): Promise<Result<ReadonlyMap<string, DiscoveredSkillEntry>, KoiError>> {
  const tiers = buildTierMap(config);

  // First pass: resolve shadow precedence and build raw (name → source + dirPath + skillsRoot) map.
  // We do this before reading frontmatter so that shadow logic runs only once.
  type RawEntry = { source: SkillSource; dirPath: string; skillsRoot: string };
  const rawEntries = new Map<string, RawEntry>();

  for (const tier of TIER_ORDER) {
    const root = tiers.get(tier);
    if (root === undefined || root === null) continue;

    let resolvedRoot: string; // let: assigned in try/catch
    try {
      resolvedRoot = await realpath(resolve(root));
    } catch {
      // Root directory doesn't exist — tier has no skills
      continue;
    }

    const skillNames = await listSkillDirs(resolvedRoot);

    for (const name of skillNames) {
      const existingSource = rawEntries.get(name)?.source;
      if (existingSource !== undefined) {
        // Shadow: current tier has higher priority, so overwrite and warn
        config.onShadowedSkill?.(name, tier);
      }
      rawEntries.set(name, {
        source: tier,
        dirPath: join(resolvedRoot, name),
        skillsRoot: resolvedRoot, // pre-resolved (Decision 6A)
      });
    }
  }

  // Second pass: read frontmatter in parallel for each winning skill (progressive loading).
  const rawList = [...rawEntries.entries()];
  const metadataResults = await Promise.all(
    rawList.map(async ([name, raw]) => ({
      name,
      raw,
      metadata: await readSkillMetadata(name, raw.dirPath, raw.source),
    })),
  );

  const entries = new Map<string, DiscoveredSkillEntry>();
  for (const { name, raw, metadata } of metadataResults) {
    entries.set(name, {
      source: raw.source,
      dirPath: raw.dirPath,
      skillsRoot: raw.skillsRoot,
      metadata,
    });
  }

  return { ok: true, value: entries as ReadonlyMap<string, DiscoveredSkillEntry> };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Reads and parses frontmatter from a skill's SKILL.md to produce SkillMetadata.
 *
 * Fails gracefully: if the file can't be read or frontmatter is invalid,
 * returns minimal metadata (name from dirName, empty description).
 * The full load() will still fail with a proper VALIDATION error in that case.
 */
async function readSkillMetadata(
  dirName: string,
  dirPath: string,
  source: SkillSource,
): Promise<SkillMetadata> {
  const fallback: SkillMetadata = { name: dirName, description: "", source, dirPath };
  const skillMdPath = join(dirPath, "SKILL.md");

  let content: string; // let: assigned in try/catch
  try {
    content = await Bun.file(skillMdPath).text();
  } catch {
    return fallback;
  }

  const parseResult = parseSkillMd(content, skillMdPath);
  if (!parseResult.ok) return fallback;

  const fmResult = validateFrontmatter(parseResult.value.frontmatter, skillMdPath);
  if (!fmResult.ok) return fallback;

  return mapFrontmatterToMetadata(fmResult.value, source, dirPath);
}

function buildTierMap(config: DiscoverConfig): ReadonlyMap<SkillSource, string | null | undefined> {
  return new Map<SkillSource, string | null | undefined>([
    ["project", config.projectRoot ?? join(process.cwd(), ".claude", "skills")],
    ["user", config.userRoot ?? join(homedir(), ".claude", "skills")],
    ["bundled", config.bundledRoot !== undefined ? config.bundledRoot : defaultBundledRoot()],
  ]);
}

/**
 * Lists subdirectory names within a root that contain a SKILL.md file.
 * Non-directory entries and directories without SKILL.md are skipped.
 */
async function listSkillDirs(root: string): Promise<readonly string[]> {
  const names: string[] = [];
  const glob = new Bun.Glob("*/SKILL.md");

  try {
    for await (const match of glob.scan({ cwd: root, dot: false })) {
      // match is like "my-skill/SKILL.md" — extract the directory name
      const slashIdx = match.indexOf("/");
      if (slashIdx > 0) {
        const name = match.substring(0, slashIdx);
        if (isValidSkillName(name)) {
          names.push(name);
        }
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable — return empty list
  }

  return names;
}

/** Skill name: lowercase alphanumeric + hyphens, starts and ends with alphanumeric. */
function isValidSkillName(name: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name);
}

/** Returns the default bundled skills root relative to this package. */
function defaultBundledRoot(): string {
  // `import.meta.dir` is the directory of this source file (src/)
  return join(import.meta.dir, "..", "bundled");
}

/** Cross-platform home directory. */
function homedir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "~";
}
