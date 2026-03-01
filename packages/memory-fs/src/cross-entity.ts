/**
 * Cross-entity expansion: discover facts stored under other entities
 * that reference entities mentioned in the seed facts' relatedEntities.
 *
 * Called as phase 2 after causal BFS (expandCausalGraph) in the recall pipeline.
 * Uses the EntityIndex reverse lookup to avoid additional I/O.
 */

import type { EntityIndex } from "./entity-index.js";
import type { FactStore, MemoryFact, ScoredCandidate } from "./types.js";

export interface CrossEntityConfig {
  readonly entityHopDecay: number; // Score multiplier per entity hop (default 0.5)
  readonly maxEntityHops: number; // Max depth of entity-hop traversal (default 1)
  readonly perEntityCap: number; // Max results per entity (default 10)
}

export const DEFAULT_CROSS_ENTITY_CONFIG: CrossEntityConfig = {
  entityHopDecay: 0.5,
  maxEntityHops: 1,
  perEntityCap: 10,
};

/**
 * Expand seed candidates across entity boundaries via relatedEntities links.
 *
 * Algorithm:
 * 1. Seed entities form the initial lookup frontier
 * 2. BFS by entity-hop level (1 to maxEntityHops)
 * 3. At each hop: lookup reverse index, load facts, apply decay + cap
 * 4. Visited-entity set prevents cycles; maxEntityHops bounds depth
 * 5. Dedup by fact ID (higher score wins)
 */
export async function expandCrossEntity(
  seeds: readonly ScoredCandidate[],
  entityIndex: EntityIndex,
  factStore: FactStore,
  config: CrossEntityConfig,
): Promise<readonly ScoredCandidate[]> {
  const { entityHopDecay, maxEntityHops, perEntityCap } = config;

  if (maxEntityHops <= 0 || seeds.length === 0) return seeds;

  // Dedup map: fact ID → best candidate (higher score wins)
  const bestByFactId = new Map<string, ScoredCandidate>();
  for (const seed of seeds) {
    upsertCandidate(bestByFactId, seed);
  }

  // Track which entities we've already looked up (to prevent A→B→A cycles)
  const visitedEntities = new Set<string>();

  // Initial frontier: seed entities — lookup reverse index for each
  // let — frontier changes each hop level
  let frontier = collectUniqueEntities(seeds);

  for (let hop = 1; hop <= maxEntityHops; hop++) {
    if (frontier.length === 0) break;

    const decayMultiplier = entityHopDecay ** hop;
    const hopCandidates = await processHopFrontier(
      frontier,
      visitedEntities,
      entityIndex,
      factStore,
      seeds,
      decayMultiplier,
    );

    const capped = applyPerEntityCap(hopCandidates, perEntityCap);
    for (const c of capped) {
      upsertCandidate(bestByFactId, c);
    }

    frontier = collectReferencedEntities(capped, visitedEntities);
  }

  return [...bestByFactId.values()];
}

/** Keep higher-scoring candidate when the same fact appears multiple times. */
function upsertCandidate(map: Map<string, ScoredCandidate>, candidate: ScoredCandidate): void {
  const existing = map.get(candidate.fact.id);
  if (existing === undefined || candidate.score > existing.score) {
    map.set(candidate.fact.id, candidate);
  }
}

/** Process one hop level: lookup reverse index, load facts, apply decay. */
async function processHopFrontier(
  frontier: readonly string[],
  visitedEntities: Set<string>,
  entityIndex: EntityIndex,
  factStore: FactStore,
  seeds: readonly ScoredCandidate[],
  decayMultiplier: number,
): Promise<readonly ScoredCandidate[]> {
  const factsCache = new Map<string, readonly MemoryFact[]>();
  const candidates: ScoredCandidate[] = [];

  for (const targetEntity of frontier) {
    visitedEntities.add(targetEntity);

    const bestSeedScore = computeBestSeedScore(seeds, targetEntity);
    const refs = entityIndex.lookup(targetEntity);

    for (const ref of refs) {
      const sourceFacts = await loadFactsCached(factsCache, factStore, ref.sourceEntity);
      const fact = sourceFacts.find((f) => f.id === ref.factId);
      if (fact === undefined || fact.status !== "active") continue;

      const score = bestSeedScore * decayMultiplier;
      candidates.push({ fact, entity: ref.sourceEntity, score });
    }
  }

  return candidates;
}

/** Load facts with a per-hop cache to avoid redundant reads. */
async function loadFactsCached(
  cache: Map<string, readonly MemoryFact[]>,
  factStore: FactStore,
  entity: string,
): Promise<readonly MemoryFact[]> {
  const cached = cache.get(entity);
  if (cached !== undefined) return cached;
  const facts = await factStore.readFacts(entity);
  cache.set(entity, facts);
  return facts;
}

/** Collect unique entity names (storage entities) from candidates. */
function collectUniqueEntities(candidates: readonly ScoredCandidate[]): readonly string[] {
  const entities = new Set<string>();
  for (const c of candidates) {
    entities.add(c.entity);
  }
  return [...entities];
}

/** Collect unique entity names from candidates' relatedEntities, excluding visited. */
function collectReferencedEntities(
  candidates: readonly ScoredCandidate[],
  visited: ReadonlySet<string>,
): readonly string[] {
  const entities = new Set<string>();
  for (const c of candidates) {
    for (const entity of c.fact.relatedEntities) {
      if (!visited.has(entity)) {
        entities.add(entity);
      }
    }
  }
  return [...entities];
}

/**
 * Find the highest seed score among seeds that reference the given entity.
 * Falls back to the max seed score if no seed directly references the entity
 * (can happen at hop 2+ when the frontier comes from newly discovered facts).
 */
function computeBestSeedScore(seeds: readonly ScoredCandidate[], targetEntity: string): number {
  // let — accumulator for max score
  let best = 0;
  for (const seed of seeds) {
    if (seed.fact.relatedEntities.includes(targetEntity) && seed.score > best) {
      best = seed.score;
    }
  }
  // Fallback for hop 2+: no seed directly references this entity
  if (best === 0) {
    for (const seed of seeds) {
      if (seed.score > best) best = seed.score;
    }
  }
  return best;
}

/** Group candidates by entity, keep top N by score per entity. */
function applyPerEntityCap(
  candidates: readonly ScoredCandidate[],
  cap: number,
): readonly ScoredCandidate[] {
  const byEntity = new Map<string, readonly ScoredCandidate[]>();
  for (const c of candidates) {
    const existing = byEntity.get(c.entity) ?? [];
    byEntity.set(c.entity, [...existing, c]);
  }

  const result: ScoredCandidate[] = [];
  for (const [, group] of byEntity) {
    const sorted = [...group].sort((a, b) => b.score - a.score).slice(0, cap);
    result.push(...sorted);
  }
  return result;
}
