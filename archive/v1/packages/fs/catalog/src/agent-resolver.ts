/**
 * Forge-backed AgentResolver — discovers, selects, and caches agent bricks.
 *
 * Queries ForgeStore for agent bricks matching the requested type tag,
 * selects by fitness, and parses manifest YAML into AgentManifest.
 */

import type {
  AgentManifest,
  AgentResolver,
  BrickArtifact,
  BrickId,
  DegeneracyConfig,
  ForgeStore,
  KoiError,
  Result,
  TaskableAgent,
  TaskableAgentSummary,
} from "@koi/core";
import { DEFAULT_DEGENERACY_CONFIG, RETRYABLE_DEFAULTS } from "@koi/core";
import { loadManifestFromString } from "@koi/manifest";
import { computeBrickFitness } from "@koi/validation";
import type {
  BreakerMap,
  SelectionContext,
  VariantEntry,
  VariantPool,
} from "@koi/variant-selection";
import { selectByFitness } from "@koi/variant-selection";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Configuration for the forge-backed agent resolver. */
export interface CatalogAgentResolverConfig {
  readonly forgeStore: ForgeStore;
  /** TTL for search cache in ms. Default: 5000. */
  readonly cacheTtlMs?: number | undefined;
  /** Degeneracy config for variant selection. Default: DEFAULT_DEGENERACY_CONFIG. */
  readonly degeneracyConfig?: DegeneracyConfig | undefined;
  /** Injectable random for testing. Default: Math.random. */
  readonly random?: (() => number) | undefined;
  /** Injectable clock for testing. Default: Date.now. */
  readonly clock?: (() => number) | undefined;
}

const DEFAULT_CACHE_TTL_MS = 5_000;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface CacheEntry {
  readonly bricks: readonly BrickArtifact[];
  readonly expiresAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAgentBrick(
  brick: BrickArtifact,
): brick is BrickArtifact & { readonly kind: "agent"; readonly manifestYaml: string } {
  return brick.kind === "agent" && "manifestYaml" in brick;
}

function resolveError(code: KoiError["code"], message: string): Result<TaskableAgent, KoiError> {
  return {
    ok: false,
    error: { code, message, retryable: RETRYABLE_DEFAULTS[code] },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Creates an AgentResolver backed by ForgeStore with caching and fitness selection. */
export function createCatalogAgentResolver(config: CatalogAgentResolverConfig): AgentResolver {
  const {
    forgeStore,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    degeneracyConfig = DEFAULT_DEGENERACY_CONFIG,
    random = Math.random,
    clock = Date.now,
  } = config;

  // Mutable caches (justified: TTL-based, bounded by query key set)
  const searchCache = new Map<string, CacheEntry>();
  const manifestCache = new Map<string, AgentManifest>(); // keyed by BrickId

  function cacheKey(agentType: string): string {
    return `agent:${agentType}`;
  }

  async function searchBricks(
    agentType: string,
  ): Promise<Result<readonly BrickArtifact[], KoiError>> {
    const key = cacheKey(agentType);
    const cached = searchCache.get(key);
    const now = clock();

    if (cached !== undefined && now < cached.expiresAt) {
      return { ok: true, value: cached.bricks };
    }

    const result = await forgeStore.search({
      kind: "agent",
      tags: [agentType],
      lifecycle: "active",
    });

    if (!result.ok) {
      return result;
    }

    const entry: CacheEntry = { bricks: result.value, expiresAt: now + cacheTtlMs };
    searchCache.set(key, entry);
    return { ok: true, value: result.value };
  }

  function parseManifest(brick: BrickArtifact): AgentManifest | undefined {
    if (!isAgentBrick(brick)) return undefined;

    const cachedManifest = manifestCache.get(brick.id);
    if (cachedManifest !== undefined) return cachedManifest;

    const parseResult = loadManifestFromString(brick.manifestYaml);
    if (!parseResult.ok) return undefined;

    const manifest = parseResult.value.manifest;
    manifestCache.set(brick.id, manifest);
    return manifest;
  }

  function selectBestVariant(
    bricks: readonly BrickArtifact[],
  ): VariantEntry<BrickArtifact> | undefined {
    const now = clock();
    const variants: readonly VariantEntry<BrickArtifact>[] = bricks.map((brick) => ({
      id: brick.id,
      value: brick,
      fitnessScore: brick.fitness !== undefined ? computeBrickFitness(brick.fitness, now) : 0.5,
    }));

    const pool: VariantPool<BrickArtifact> = {
      capability: "agent",
      variants,
      config: degeneracyConfig,
    };

    const emptyBreakers: BreakerMap = new Map();
    const ctx: SelectionContext = { clock, random };

    const selection = selectByFitness(pool, emptyBreakers, ctx);
    if (!selection.ok) return undefined;
    return selection.selected;
  }

  return {
    async resolve(agentType: string): Promise<Result<TaskableAgent, KoiError>> {
      const searchResult = await searchBricks(agentType);
      if (!searchResult.ok) {
        return resolveError("EXTERNAL", `ForgeStore search failed: ${searchResult.error.message}`);
      }

      const agentBricks = searchResult.value.filter(isAgentBrick);
      if (agentBricks.length === 0) {
        return resolveError("NOT_FOUND", `No active agent bricks found for type '${agentType}'`);
      }

      // Try each variant (highest fitness first) until one parses successfully
      if (agentBricks.length === 1) {
        const brick = agentBricks[0];
        if (brick === undefined) {
          return resolveError("NOT_FOUND", `No active agent bricks found for type '${agentType}'`);
        }
        const manifest = parseManifest(brick);
        if (manifest === undefined) {
          return resolveError(
            "VALIDATION",
            `Failed to parse manifest for agent brick '${brick.name}'`,
          );
        }
        return {
          ok: true,
          value: {
            name: brick.name,
            description: brick.description,
            manifest,
            brickId: brick.id as BrickId,
          },
        };
      }

      // Multiple bricks — select by fitness, skip broken manifests
      const selected = selectBestVariant(agentBricks);
      if (selected !== undefined) {
        const manifest = parseManifest(selected.value);
        if (manifest !== undefined) {
          return {
            ok: true,
            value: {
              name: selected.value.name,
              description: selected.value.description,
              manifest,
              brickId: selected.value.id as BrickId,
            },
          };
        }
      }

      // Selected variant had broken manifest — try remaining bricks
      for (const brick of agentBricks) {
        const manifest = parseManifest(brick);
        if (manifest !== undefined) {
          return {
            ok: true,
            value: {
              name: brick.name,
              description: brick.description,
              manifest,
              brickId: brick.id as BrickId,
            },
          };
        }
      }

      return resolveError(
        "VALIDATION",
        `All agent bricks for type '${agentType}' have invalid manifests`,
      );
    },

    async list(): Promise<readonly TaskableAgentSummary[]> {
      const result = await forgeStore.search({ kind: "agent", lifecycle: "active" });
      if (!result.ok) return [];

      const summaries: TaskableAgentSummary[] = [];
      const seen = new Set<string>();

      for (const brick of result.value) {
        if (!isAgentBrick(brick)) continue;
        // Use the first tag as the key (agent type identifier)
        const key = brick.tags[0] ?? brick.name;
        if (seen.has(key)) continue;
        seen.add(key);
        summaries.push({ key, name: brick.name, description: brick.description });
      }

      return summaries;
    },
  };
}
