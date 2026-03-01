/**
 * createFsMemory — factory wiring the L0 MemoryComponent contract.
 *
 * Composes: fact-store, dedup, decay, summary, session-log, optional DI search.
 */
import type { MemoryRecallOptions, MemoryResult, MemoryStoreOptions } from "@koi/core";
import { classifyTier, computeDecayScore } from "./decay.js";
import { jaccard } from "./dedup.js";
import { createFactStore } from "./fact-store.js";
import { DEFAULT_GRAPH_DECAY_FACTOR, expandCausalGraph } from "./graph-walk.js";
import { appendSessionLog } from "./session-log.js";
import { slugifyEntity } from "./slug.js";
import { rebuildSummary } from "./summary.js";
import type {
  FactStore,
  FsIndexDoc,
  FsMemory,
  FsMemoryConfig,
  MemoryFact,
  TierDistribution,
} from "./types.js";

const DEFAULT_DEDUP_THRESHOLD = 0.7;
const DEFAULT_FREQ_PROTECT = 10;
const DEFAULT_HALF_LIFE_DAYS = 30;
const DEFAULT_MAX_SUMMARY_FACTS = 10;

export async function createFsMemory(config: FsMemoryConfig): Promise<FsMemory> {
  const {
    baseDir,
    retriever,
    indexer,
    dedupThreshold = DEFAULT_DEDUP_THRESHOLD,
    freqProtectThreshold = DEFAULT_FREQ_PROTECT,
    decayHalfLifeDays = DEFAULT_HALF_LIFE_DAYS,
    maxSummaryFacts = DEFAULT_MAX_SUMMARY_FACTS,
  } = config;

  if (baseDir.length === 0) {
    throw new Error("FsMemoryConfig.baseDir must be a non-empty string");
  }

  // let — instance-scoped counter for unique fact IDs
  let factCounter = 0;

  function generateId(): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    factCounter++;
    return `${ts}-${rand}-${factCounter.toString(36)}`;
  }

  const factStore = createFactStore(baseDir);
  // let — mutable set tracking entities modified since last summary rebuild
  let dirtyEntities = new Set<string>();
  // let — deferred index docs accumulate between store() and recall()
  let deferredIndexDocs: readonly FsIndexDoc[] = [];

  function resolveEntity(options?: MemoryStoreOptions): string {
    const raw =
      (options?.relatedEntities !== undefined && options.relatedEntities.length > 0
        ? options.relatedEntities[0]
        : undefined) ??
      options?.namespace ??
      "_default";
    return slugifyEntity(raw ?? "_default");
  }

  async function flushDeferredIndex(): Promise<void> {
    if (indexer === undefined || deferredIndexDocs.length === 0) return;
    const docs = deferredIndexDocs;
    deferredIndexDocs = [];
    await indexer.index(docs);
  }

  function mapFactToResult(fact: MemoryFact, score: number): MemoryResult {
    const now = new Date();
    const decay = computeDecayScore(fact.lastAccessed, now, decayHalfLifeDays);
    const tier = classifyTier(decay, fact.accessCount, freqProtectThreshold);
    return {
      content: fact.fact,
      score,
      metadata: {
        id: fact.id,
        category: fact.category,
        relatedEntities: fact.relatedEntities,
      },
      tier,
      decayScore: decay,
      lastAccessed: fact.lastAccessed,
      causalParents: fact.causalParents,
      causalChildren: fact.causalChildren,
    };
  }

  function entitiesMatch(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    const sorted1 = [...a].sort();
    const sorted2 = [...b].sort();
    return sorted1.every((v, i) => v === sorted2[i]);
  }

  async function loadAllFacts(): Promise<Map<string, MemoryFact>> {
    const allEntities = await factStore.listEntities();
    const entityFactArrays = await Promise.all(
      allEntities.map(async (ent) => ({ ent, facts: await factStore.readFacts(ent) })),
    );
    const allFacts = new Map<string, MemoryFact>();
    for (const { facts } of entityFactArrays) {
      for (const f of facts) {
        allFacts.set(f.id, f);
      }
    }
    return allFacts;
  }

  const store = async (content: string, options?: MemoryStoreOptions): Promise<void> => {
    const entity = resolveEntity(options);
    const now = new Date();
    const category = options?.category ?? "context";

    const causalParents =
      options?.causalParents !== undefined && options.causalParents.length > 0
        ? options.causalParents
        : undefined;

    const newFact: MemoryFact = {
      id: generateId(),
      fact: content,
      category,
      timestamp: now.toISOString(),
      status: "active",
      supersededBy: null,
      relatedEntities: options?.relatedEntities ? [...options.relatedEntities] : [],
      lastAccessed: now.toISOString(),
      accessCount: 0,
      ...(causalParents !== undefined ? { causalParents } : {}),
    };

    // Read existing active facts for dedup
    const existing = await factStore.readFacts(entity);
    const activeInCategory = existing.filter(
      (f) => f.status === "active" && f.category === category,
    );

    // Jaccard dedup: skip if too similar (or reinforce if requested)
    for (const old of activeInCategory) {
      if (jaccard(content, old.fact) >= dedupThreshold) {
        if (options?.reinforce === true) {
          // Reinforce: boost existing fact's salience instead of silently skipping
          await factStore.updateFact(entity, old.id, {
            lastAccessed: now.toISOString(),
            accessCount: old.accessCount + 1,
          });
        }
        return; // Duplicate — skip creating new fact
      }
    }

    // Contradiction: supersede same-category facts with same relatedEntities (order-insensitive)
    const entities = newFact.relatedEntities;
    if (entities.length > 0) {
      for (const old of activeInCategory) {
        if (entitiesMatch(old.relatedEntities, entities)) {
          await factStore.updateFact(entity, old.id, {
            status: "superseded",
            supersededBy: newFact.id,
          });
        }
      }
    }

    await factStore.appendFact(entity, newFact);

    // Bidirectional causal edge: update each parent's causalChildren to include newFact.id
    if (causalParents !== undefined && causalParents.length > 0) {
      const entityFacts = await factStore.readFacts(entity);
      const parentIds = new Set(causalParents);
      await Promise.all(
        entityFacts
          .filter((f) => parentIds.has(f.id))
          .map((parent) => {
            const existingChildren = parent.causalChildren ?? [];
            // Only add if not already present
            if (existingChildren.includes(newFact.id)) return Promise.resolve();
            return factStore.updateFact(entity, parent.id, {
              causalChildren: [...existingChildren, newFact.id],
            });
          }),
      );
    }

    // Defer index update (flushed on recall)
    if (indexer !== undefined) {
      deferredIndexDocs = [
        ...deferredIndexDocs,
        {
          id: newFact.id,
          content: newFact.fact,
          metadata: { category: newFact.category, entity },
        },
      ];
    }

    // Session log
    await appendSessionLog(baseDir, content, now);

    dirtyEntities = new Set([...dirtyEntities, entity]);
  };

  type ScoredCandidate = {
    readonly fact: MemoryFact;
    readonly entity: string;
    readonly score: number;
  };

  /** Apply tier filter and keep only active candidates. */
  function applyTierFilter(
    candidates: readonly ScoredCandidate[],
    tierFilter: MemoryRecallOptions["tierFilter"],
  ): readonly ScoredCandidate[] {
    const filtered: ScoredCandidate[] = [];
    for (const c of candidates) {
      if (c.fact.status !== "active") continue;
      const result = mapFactToResult(c.fact, c.score);
      if (tierFilter !== undefined && tierFilter !== "all" && result.tier !== tierFilter) {
        continue;
      }
      filtered.push(c);
    }
    return filtered;
  }

  /** Expand candidates along causal edges, dedup by fact ID (higher score wins). */
  async function applyGraphExpansion(
    filtered: readonly ScoredCandidate[],
    maxHops: number,
    facts: FactStore,
  ): Promise<readonly ScoredCandidate[]> {
    // Group candidates by entity for entity-scoped expansion
    const byEntity = new Map<
      string,
      Array<{ readonly fact: MemoryFact; readonly score: number }>
    >();
    for (const c of filtered) {
      const existing = byEntity.get(c.entity);
      if (existing !== undefined) {
        existing.push({ fact: c.fact, score: c.score });
      } else {
        byEntity.set(c.entity, [{ fact: c.fact, score: c.score }]);
      }
    }

    const all: ScoredCandidate[] = [];
    for (const [entity, seeds] of byEntity) {
      const entityFacts = await facts.readFacts(entity);
      const graphResults = expandCausalGraph(seeds, entityFacts, {
        maxHops,
        decayFactor: DEFAULT_GRAPH_DECAY_FACTOR,
      });
      for (const gr of graphResults) {
        if (gr.fact.status === "active") {
          all.push({ fact: gr.fact, entity, score: gr.score });
        }
      }
    }

    // Dedup by fact ID — keep higher score
    const deduped = new Map<string, ScoredCandidate>();
    for (const item of all) {
      const existing = deduped.get(item.fact.id);
      if (existing === undefined || item.score > existing.score) {
        deduped.set(item.fact.id, item);
      }
    }
    return [...deduped.values()];
  }

  /** Shared post-processing: tier filter, graph expansion, access-stat updates, limit. */
  async function processRecallCandidates(
    candidates: readonly ScoredCandidate[],
    options: MemoryRecallOptions | undefined,
    facts: FactStore,
  ): Promise<readonly MemoryResult[]> {
    const limit = options?.limit ?? 10;
    const filtered = applyTierFilter(candidates, options?.tierFilter);

    const expanded =
      options?.graphExpand === true && filtered.length > 0
        ? await applyGraphExpansion(filtered, options.maxHops ?? 2, facts)
        : filtered;

    // Sort by score descending, apply limit
    const sorted = [...expanded].sort((a, b) => b.score - a.score).slice(0, limit);

    // Map to results and batch update access stats
    const nowIso = new Date().toISOString();
    const results = sorted.map((c) => mapFactToResult(c.fact, c.score));
    await Promise.all(
      sorted.map((c) =>
        facts.updateFact(c.entity, c.fact.id, {
          lastAccessed: nowIso,
          accessCount: c.fact.accessCount + 1,
        }),
      ),
    );

    return results;
  }

  const recall = async (
    query: string,
    options?: MemoryRecallOptions,
  ): Promise<readonly MemoryResult[]> => {
    await flushDeferredIndex();

    if (retriever !== undefined) {
      const limit = options?.limit ?? 10;
      const hits = await retriever.retrieve(query, limit * 2);
      const allFacts = await loadAllFacts();

      const candidates: Array<{
        readonly fact: MemoryFact;
        readonly entity: string;
        readonly score: number;
      }> = [];
      for (const hit of hits) {
        const fact = allFacts.get(hit.id);
        if (fact === undefined) continue;
        candidates.push({
          fact,
          entity: resolveEntity({ relatedEntities: fact.relatedEntities }),
          score: hit.score,
        });
      }

      return processRecallCandidates(candidates, options, factStore);
    }

    // Fallback: scan all cached facts, sort by recency
    const allEntities = await factStore.listEntities();
    const entityFactArrays = await Promise.all(
      allEntities.map(async (ent) => ({ ent, facts: await factStore.readFacts(ent) })),
    );

    const candidates: Array<{
      readonly fact: MemoryFact;
      readonly entity: string;
      readonly score: number;
    }> = [];
    for (const { ent, facts } of entityFactArrays) {
      for (const f of facts) {
        candidates.push({ fact: f, entity: ent, score: 1.0 });
      }
    }

    // Sort by recency (recency is the primary signal when no retriever)
    candidates.sort(
      (a, b) => new Date(b.fact.timestamp).getTime() - new Date(a.fact.timestamp).getTime(),
    );

    return processRecallCandidates(candidates, options, factStore);
  };

  const rebuildSummaries = async (): Promise<void> => {
    for (const entity of dirtyEntities) {
      const facts = await factStore.readFacts(entity);
      await rebuildSummary(baseDir, entity, facts, maxSummaryFacts, {
        decayHalfLifeDays,
        freqProtectThreshold,
      });
    }
    dirtyEntities = new Set();
  };

  const getTierDistribution = async (): Promise<TierDistribution> => {
    const now = new Date();
    const entities = await factStore.listEntities();
    // let — needed for mutable counters
    let hot = 0;
    let warm = 0;
    let cold = 0;

    for (const ent of entities) {
      const facts = await factStore.readFacts(ent);
      for (const f of facts) {
        if (f.status !== "active") continue;
        const decay = computeDecayScore(f.lastAccessed, now, decayHalfLifeDays);
        const tier = classifyTier(decay, f.accessCount, freqProtectThreshold);
        if (tier === "hot") hot++;
        else if (tier === "warm") warm++;
        else cold++;
      }
    }

    return { hot, warm, cold, total: hot + warm + cold };
  };

  const listEntities = (): Promise<readonly string[]> => factStore.listEntities();

  const close = async (): Promise<void> => {
    await flushDeferredIndex();
    await factStore.close();
    dirtyEntities = new Set();
  };

  return {
    component: { recall, store },
    rebuildSummaries,
    getTierDistribution,
    listEntities,
    close,
  };
}
