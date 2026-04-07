/**
 * @koi/skills-runtime — Multi-source skill discovery and loading for Koi agents.
 *
 * L2 package. Imports from @koi/core (L0) and L0u utilities only.
 *
 * Usage:
 *   import { createSkillsRuntime } from "@koi/skills-runtime";
 *   const runtime = createSkillsRuntime({ blockOnSeverity: "HIGH" });
 *   const result = await runtime.load("code-review");
 */

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { KoiError, Result } from "@koi/core";
import type { ScanFinding } from "@koi/skill-scanner";
import { createScanner } from "@koi/skill-scanner";
import type { DiscoverConfig } from "./discover.js";
import { discoverSkills } from "./discover.js";
import type { LoaderContext } from "./loader.js";
import { loadSkill } from "./loader.js";
import type { SkillDefinition, SkillSource, SkillsRuntime, SkillsRuntimeConfig } from "./types.js";

export { createSkillProvider, skillDefinitionToComponent } from "./provider.js";
export type { ValidatedSkillRequires } from "./types.js";
export type { ValidatedFrontmatter } from "./validate.js";
export type { SkillDefinition, SkillSource, SkillsRuntime, SkillsRuntimeConfig };

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an instance-scoped SkillsRuntime.
 *
 * The scanner, cache, and resolved base paths all live inside this instance —
 * no global state (Decision 2A, 13A).
 */
export function createSkillsRuntime(config?: SkillsRuntimeConfig): SkillsRuntime {
  const resolvedConfig: {
    readonly blockOnSeverity: string;
    readonly onShadowedSkill?: (name: string, shadowedBy: SkillSource) => void;
    readonly onSecurityFinding?: (name: string, findings: readonly ScanFinding[]) => void;
  } = {
    blockOnSeverity: config?.blockOnSeverity ?? "HIGH",
    ...(config?.onShadowedSkill !== undefined ? { onShadowedSkill: config.onShadowedSkill } : {}),
    ...(config?.onSecurityFinding !== undefined
      ? { onSecurityFinding: config.onSecurityFinding }
      : {}),
  };

  // Decision 13A: instance-scoped scanner (no module-level global)
  const scanner = createScanner();

  // Decision 2A: instance-scoped cache
  const cache = new Map<string, Result<SkillDefinition, KoiError>>();

  // Lazily computed discovered skills map
  let discoveredSkills: ReadonlyMap<string, SkillSource> | undefined;
  let discoveredDirPaths: ReadonlyMap<string, string> | undefined;

  const discoverConfig: DiscoverConfig = {
    ...(config?.projectRoot !== undefined ? { projectRoot: config.projectRoot } : {}),
    ...(config?.userRoot !== undefined ? { userRoot: config.userRoot } : {}),
    // bundledRoot: null means disabled; undefined means use default
    ...(config?.bundledRoot !== undefined ? { bundledRoot: config.bundledRoot } : {}),
    ...(resolvedConfig.onShadowedSkill !== undefined
      ? { onShadowedSkill: resolvedConfig.onShadowedSkill }
      : {}),
  };

  // ---------------------------------------------------------------------------
  // discover()
  // ---------------------------------------------------------------------------

  const discover = async (): Promise<Result<ReadonlyMap<string, SkillSource>, KoiError>> => {
    if (discoveredSkills !== undefined) {
      return { ok: true, value: discoveredSkills };
    }

    const result = await discoverSkills(discoverConfig);
    if (!result.ok) return result;

    discoveredSkills = result.value.skills;
    discoveredDirPaths = result.value.dirPaths;

    return { ok: true, value: discoveredSkills };
  };

  // ---------------------------------------------------------------------------
  // load()
  // ---------------------------------------------------------------------------

  const load = async (name: string): Promise<Result<SkillDefinition, KoiError>> => {
    // Ensure discovery has run
    const discoverResult = await discover();
    if (!discoverResult.ok) return discoverResult;

    const source = discoveredSkills?.get(name);
    if (source === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Skill "${name}" not found. Run discover() first or check that the skill directory exists with a SKILL.md file.`,
          retryable: false,
          context: { name },
        },
      };
    }

    const dirPath = discoveredDirPaths?.get(name);
    if (dirPath === undefined) {
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: `Internal error: skill "${name}" has source but no dirPath`,
          retryable: false,
          context: { name, source },
        },
      };
    }

    // Decision 15A: pre-resolve skillsRoot once
    const skillsRoot = await resolveSkillsRoot(dirPath);

    const ctx: LoaderContext = {
      cache,
      scanner,
      skillsRoot,
      config: resolvedConfig,
    };

    return loadSkill(name, dirPath, source, ctx);
  };

  // ---------------------------------------------------------------------------
  // loadAll()
  // ---------------------------------------------------------------------------

  const loadAll = async (): Promise<ReadonlyMap<string, Result<SkillDefinition, KoiError>>> => {
    const discoverResult = await discover();
    if (!discoverResult.ok) {
      // Can't load anything if discovery failed
      return new Map([
        [
          "__discover__",
          {
            ok: false as const,
            error: discoverResult.error,
          },
        ],
      ]);
    }

    const names = Array.from(discoveredSkills?.keys() ?? []);

    // Decision 6A: Promise.allSettled rejections → skipped entries
    const settled = await Promise.allSettled(names.map((name) => load(name)));

    const resultMap = new Map<string, Result<SkillDefinition, KoiError>>();
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const outcome = settled[i];
      if (name === undefined || outcome === undefined) continue;

      if (outcome.status === "fulfilled") {
        resultMap.set(name, outcome.value);
      } else {
        // Unexpected rejection (shouldn't happen — load() catches all errors)
        resultMap.set(name, {
          ok: false,
          error: {
            code: "INTERNAL",
            message: `Unexpected error loading skill "${name}": ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
            retryable: false,
            context: { name },
          },
        });
      }
    }

    return resultMap;
  };

  return { discover, load, loadAll };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Decision 15A: pre-resolve the skillsRoot from a dirPath.
 * We use the parent of the skill's directory as the root boundary.
 */
async function resolveSkillsRoot(dirPath: string): Promise<string> {
  // dirPath is like /home/user/.claude/skills/my-skill
  // skillsRoot should be /home/user/.claude/skills
  const parent = resolve(dirPath, "..");
  try {
    return await realpath(parent);
  } catch {
    return parent;
  }
}
