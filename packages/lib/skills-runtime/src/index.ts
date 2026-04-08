/**
 * @koi/skills-runtime — Multi-source skill discovery and loading for Koi agents.
 *
 * L2 package. Imports from @koi/core (L0) and L0u utilities only.
 *
 * Usage:
 *   import { createSkillsRuntime } from "@koi/skills-runtime";
 *   const runtime = createSkillsRuntime({ blockOnSeverity: "HIGH" });
 *   const meta = await runtime.discover();   // frontmatter only, no body
 *   const result = await runtime.load("code-review");  // full body + scan
 *   const filtered = await runtime.query({ tags: ["typescript"] });
 */

import type { KoiError, Result } from "@koi/core";
import type { ScanFinding } from "@koi/skill-scanner";
import { createScanner } from "@koi/skill-scanner";
import type { Severity } from "@koi/validation";
import type { DiscoverConfig, DiscoveredSkillEntry } from "./discover.js";
import { discoverSkills } from "./discover.js";
import type { LoaderContext } from "./loader.js";
import { loadSkill } from "./loader.js";
import type {
  SkillDefinition,
  SkillMetadata,
  SkillQuery,
  SkillSource,
  SkillsRuntime,
  SkillsRuntimeConfig,
} from "./types.js";

export type { SkillInjectorConfig } from "./middleware.js";
export { createSkillInjectorMiddleware } from "./middleware.js";
export { createSkillProvider, skillDefinitionToComponent } from "./provider.js";
export type { ValidatedSkillRequires } from "./types.js";
export type { ValidatedFrontmatter } from "./validate.js";
export type {
  SkillDefinition,
  SkillMetadata,
  SkillQuery,
  SkillSource,
  SkillsRuntime,
  SkillsRuntimeConfig,
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an instance-scoped SkillsRuntime.
 *
 * The scanner, body cache, and discovered entries all live inside this instance —
 * no global state (Decision 2A, 13A).
 *
 * Concurrency safety (Issue 2A): discover() and load() both use inflight promise
 * deduplication — concurrent calls for the same resource join a single in-flight
 * operation rather than triggering duplicate filesystem scans or loads.
 */
export function createSkillsRuntime(config?: SkillsRuntimeConfig): SkillsRuntime {
  const resolvedConfig: {
    readonly blockOnSeverity: Severity;
    readonly onShadowedSkill?: (name: string, shadowedBy: SkillSource) => void;
    readonly onSecurityFinding?: (name: string, findings: readonly ScanFinding[]) => void;
  } = {
    blockOnSeverity: (config?.blockOnSeverity ?? "HIGH") as Severity,
    ...(config?.onShadowedSkill !== undefined ? { onShadowedSkill: config.onShadowedSkill } : {}),
    ...(config?.onSecurityFinding !== undefined
      ? { onSecurityFinding: config.onSecurityFinding }
      : {}),
  };

  // Decision 13A: instance-scoped scanner (no module-level global)
  const scanner = createScanner();

  // Decision 2A: instance-scoped body cache
  const cache = new Map<string, Result<SkillDefinition, KoiError>>();

  // Issue 4A: single merged map (source + dirPath + skillsRoot + metadata)
  // replaces the previous two separate Maps (discoveredSkills + discoveredDirPaths).
  let discoveredEntry: ReadonlyMap<string, DiscoveredSkillEntry> | undefined;
  // Projected metadata map cached to preserve reference identity across discover() calls
  let discoveredMetaMap: ReadonlyMap<string, SkillMetadata> | undefined;

  // Issue 2A: inflight deduplication for discover()
  let discoverInflight:
    | Promise<Result<ReadonlyMap<string, DiscoveredSkillEntry>, KoiError>>
    | undefined;

  // Issue 2A: inflight deduplication for load() — one promise per skill name
  const loadInflight = new Map<string, Promise<Result<SkillDefinition, KoiError>>>();

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
  // Internal helpers
  // ---------------------------------------------------------------------------

  function buildMetaMap(
    entries: ReadonlyMap<string, DiscoveredSkillEntry>,
  ): ReadonlyMap<string, SkillMetadata> {
    return new Map([...entries.entries()].map(([k, v]) => [k, v.metadata]));
  }

  // ---------------------------------------------------------------------------
  // discover()
  // ---------------------------------------------------------------------------

  const discover = async (): Promise<Result<ReadonlyMap<string, SkillMetadata>, KoiError>> => {
    // Cache hit: return the same map reference (reference identity preserved)
    if (discoveredEntry !== undefined && discoveredMetaMap !== undefined) {
      return { ok: true, value: discoveredMetaMap };
    }

    // Inflight dedup: join the in-flight promise if discovery is already running.
    // This check + the assignment below are both synchronous — no interleave possible.
    if (discoverInflight !== undefined) {
      const result = await discoverInflight;
      if (!result.ok) return result;
      // discoveredMetaMap was set by the in-flight promise's then() handler.
      // If result.ok is true, the .then() handler already assigned discoveredMetaMap.
      if (discoveredMetaMap === undefined) {
        return {
          ok: false,
          error: {
            code: "INTERNAL",
            message: "Discovery succeeded but metadata map was not built",
            retryable: false,
            context: {},
          },
        };
      }
      return { ok: true, value: discoveredMetaMap };
    }

    // No cache, no in-flight — start discovery. Set discoverInflight synchronously
    // before any await so concurrent callers see it immediately.
    discoverInflight = discoverSkills(discoverConfig).then(
      (result) => {
        if (result.ok) {
          discoveredEntry = result.value;
          discoveredMetaMap = buildMetaMap(result.value);
        }
        discoverInflight = undefined;
        return result;
      },
      (err: unknown) => {
        discoverInflight = undefined;
        throw err;
      },
    );

    const result = await discoverInflight;
    if (!result.ok) return result;
    // After successful discovery, discoveredMetaMap is guaranteed to be set by the .then() handler.
    if (discoveredMetaMap === undefined) {
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: "Discovery succeeded but metadata map was not built",
          retryable: false,
          context: {},
        },
      };
    }
    return { ok: true, value: discoveredMetaMap };
  };

  // ---------------------------------------------------------------------------
  // load()
  // ---------------------------------------------------------------------------

  const load = async (name: string): Promise<Result<SkillDefinition, KoiError>> => {
    // 1. Body cache hit
    const cached = cache.get(name);
    if (cached !== undefined) return cached;

    // 2. Inflight dedup: join if this skill is already loading.
    // Both checks below are synchronous — no interleave between check and registration.
    const inflight = loadInflight.get(name);
    if (inflight !== undefined) return inflight;

    // 3. Create the load promise and register it synchronously before any await.
    //    This closes the race window: any concurrent caller arriving after this
    //    point will find the promise in loadInflight and join it.
    const promise: Promise<Result<SkillDefinition, KoiError>> = (async () => {
      // Ensure discovery has run
      const discoverResult = await discover();
      if (!discoverResult.ok) return discoverResult;

      const entry = discoveredEntry?.get(name);
      if (entry === undefined) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Skill "${name}" not found. Run discover() first or check that the skill directory exists with a SKILL.md file.`,
            retryable: false,
            context: { name },
          },
        } satisfies Result<SkillDefinition, KoiError>;
      }

      const ctx: LoaderContext = {
        cache,
        scanner,
        skillsRoot: entry.skillsRoot, // pre-resolved at discovery time (Decision 6A)
        config: resolvedConfig,
      };

      return loadSkill(name, entry.dirPath, entry.source, ctx);
    })().finally(() => {
      loadInflight.delete(name);
    });

    loadInflight.set(name, promise);
    return promise;
  };

  // ---------------------------------------------------------------------------
  // loadAll()
  // ---------------------------------------------------------------------------

  const loadAll = async (): Promise<
    Result<ReadonlyMap<string, Result<SkillDefinition, KoiError>>, KoiError>
  > => {
    const discoverResult = await discover();
    if (!discoverResult.ok) {
      // Discovery failed — surface as outer Result error (Issue 3A)
      return { ok: false, error: discoverResult.error };
    }

    const names = Array.from(discoveredEntry?.keys() ?? []);

    // Promise.allSettled — partial failures don't block other skills
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

    return { ok: true, value: resultMap };
  };

  // ---------------------------------------------------------------------------
  // query()
  // ---------------------------------------------------------------------------

  const query = async (
    filter?: SkillQuery,
  ): Promise<Result<readonly SkillMetadata[], KoiError>> => {
    const discoverResult = await discover();
    if (!discoverResult.ok) return discoverResult;

    // Linear scan over metadata (Issue 16A: no secondary indexes needed at N ≤ 50)
    let entries =
      discoveredEntry !== undefined ? [...discoveredEntry.values()].map((e) => e.metadata) : [];

    if (filter === undefined) {
      return { ok: true, value: entries };
    }

    if (filter.source !== undefined) {
      const src = filter.source;
      entries = entries.filter((m) => m.source === src);
    }

    if (filter.tags !== undefined && filter.tags.length > 0) {
      // AND semantics: skill must have ALL specified tags (Issue 9A)
      const requiredTags = filter.tags;
      entries = entries.filter((m) => {
        if (m.tags === undefined) return false;
        const skillTags = m.tags;
        return requiredTags.every((tag) => skillTags.includes(tag));
      });
    }

    if (filter.capability !== undefined) {
      const cap = filter.capability;
      entries = entries.filter((m) => m.allowedTools?.includes(cap) ?? false);
    }

    return { ok: true, value: entries };
  };

  // ---------------------------------------------------------------------------
  // invalidate()
  // ---------------------------------------------------------------------------

  const invalidate = (name?: string): void => {
    if (name === undefined) {
      // Full reset: clear discovery cache + all body caches (Issue 14A)
      discoveredEntry = undefined;
      discoveredMetaMap = undefined;
      discoverInflight = undefined;
      cache.clear();
      loadInflight.clear();
    } else {
      // Skill-only reset: clear just this skill's body entry (Issue 14A)
      // Discovery metadata is preserved — re-discover not needed.
      cache.delete(name);
      loadInflight.delete(name);
    }
  };

  return { discover, load, loadAll, query, invalidate };
}
