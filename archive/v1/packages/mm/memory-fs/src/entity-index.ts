/**
 * In-memory reverse index: entity name → facts stored in *other* entities.
 *
 * Built lazily on first recall, maintained incrementally on store().
 * Enables cross-entity graph traversal without additional I/O.
 */

import type { FactStore, MemoryFact } from "./types.js";

export interface EntityIndexEntry {
  readonly factId: string;
  readonly sourceEntity: string;
}

export interface EntityIndex {
  /** Lazy init: scan all entities, populate index from relatedEntities arrays. */
  readonly build: (factStore: FactStore) => Promise<void>;
  /** Incremental update: index a newly stored fact. */
  readonly addFact: (fact: MemoryFact, sourceEntity: string) => void;
  /** Query: get all facts from other entities that reference the given entity. */
  readonly lookup: (entity: string) => readonly EntityIndexEntry[];
  /** Check whether lazy init has been performed. */
  readonly isBuilt: () => boolean;
}

export function createEntityIndex(): EntityIndex {
  // Map — internal mutable index required for O(1) lookup
  const index = new Map<string, readonly EntityIndexEntry[]>();
  // Set — O(1) dedup check keyed by "entity:factId:sourceEntity"
  const seen = new Set<string>();
  // let — tracks whether build() has been called
  let built = false;

  function addEntry(entity: string, factId: string, sourceEntity: string): void {
    const key = `${entity}:${factId}:${sourceEntity}`;
    if (seen.has(key)) return;
    seen.add(key);
    const existing = index.get(entity) ?? [];
    index.set(entity, [...existing, { factId, sourceEntity }]);
  }

  function indexFact(fact: MemoryFact, sourceEntity: string): void {
    if (fact.relatedEntities.length === 0) return;
    for (const entity of fact.relatedEntities) {
      // Skip self-referencing: fact is already stored under sourceEntity
      if (entity === sourceEntity) continue;
      addEntry(entity, fact.id, sourceEntity);
    }
  }

  const build = async (factStore: FactStore): Promise<void> => {
    if (built) return;
    const entities = await factStore.listEntities();
    const entityFactPairs = await Promise.all(
      entities.map(async (ent) => ({ ent, facts: await factStore.readFacts(ent) })),
    );
    for (const { ent, facts } of entityFactPairs) {
      for (const fact of facts) {
        indexFact(fact, ent);
      }
    }
    built = true;
  };

  const addFact = (fact: MemoryFact, sourceEntity: string): void => {
    indexFact(fact, sourceEntity);
  };

  const lookup = (entity: string): readonly EntityIndexEntry[] => {
    return index.get(entity) ?? [];
  };

  const isBuilt = (): boolean => built;

  return { build, addFact, lookup, isBuilt };
}
