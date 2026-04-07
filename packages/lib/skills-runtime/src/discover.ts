/**
 * Multi-source skill discovery — walks bundled/user/project roots.
 *
 * Precedence (highest first): project > user > bundled.
 * When two tiers define the same skill name, the higher-priority tier wins.
 * Decision 4A: shadow warning emitted via onShadowedSkill callback.
 */

import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { KoiError, Result } from "@koi/core";
import type { SkillSource } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Ordered tiers from lowest to highest priority. */
const TIER_ORDER: readonly SkillSource[] = ["bundled", "user", "project"] as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discovers all available skill directories across the three source tiers.
 *
 * Returns a map of skill name → winning SkillSource.
 * Also returns a parallel map of skill name → absolute dirPath.
 *
 * Decision 4A: calls onShadowedSkill for each skill shadowed by a higher tier.
 */
export async function discoverSkills(
  config: DiscoverConfig,
): Promise<Result<DiscoveredSkills, KoiError>> {
  const tiers = buildTierMap(config);
  const nameToSource = new Map<string, SkillSource>();
  const nameToDirPath = new Map<string, string>();

  // Process lowest-priority tiers first; higher tiers overwrite via shadow logic
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
      const existingSource = nameToSource.get(name);
      if (existingSource !== undefined) {
        // Shadow: current tier has higher priority, so overwrite and warn
        config.onShadowedSkill?.(name, tier);
      }
      nameToSource.set(name, tier);
      nameToDirPath.set(name, join(resolvedRoot, name));
    }
  }

  return {
    ok: true,
    value: {
      skills: nameToSource as ReadonlyMap<string, SkillSource>,
      dirPaths: nameToDirPath as ReadonlyMap<string, string>,
    },
  };
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface DiscoverConfig {
  readonly projectRoot?: string;
  readonly userRoot?: string;
  readonly bundledRoot?: string | null;
  readonly onShadowedSkill?: (name: string, shadowedBy: SkillSource) => void;
}

export interface DiscoveredSkills {
  readonly skills: ReadonlyMap<string, SkillSource>;
  readonly dirPaths: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
