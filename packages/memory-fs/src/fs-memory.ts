/**
 * createFsMemory — factory wiring the L0 MemoryComponent contract.
 *
 * Composes: fact-store, dedup, decay, summary, session-log, optional DI search.
 */
import type { MemoryRecallOptions, MemoryResult, MemoryStoreOptions } from "@koi/core";
import { DEFAULT_CROSS_ENTITY_CONFIG, expandCrossEntity } from "./cross-entity.js";
import { classifyTier, computeDecayScore } from "./decay.js";
import { jaccard } from "./dedup.js";
import { createEntityIndex } from "./entity-index.js";
import { createFactStore } from "./fact-store.js";
import { DEFAULT_GRAPH_DECAY_FACTOR, expandCausalGraph } from "./graph-walk.js";
import { computeSalienceScores } from "./salience.js";
import { appendSessionLog } from "./session-log.js";
import { slugifyEntity } from "./slug.js";
import { rebuildSummary } from "./summary.js";
import type {
  FactStore,
  FsIndexDoc,
  FsMemory,
  FsMemoryConfig,
  MemoryFact,
  ScoredCandidate,
  TierDistribution,
} from "./types.js";

const DEFAULT_DEDUP_THRESHOLD = 0.7;
const DEFAULT_MERGE_THRESHOLD = 0.4;
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
    entityHopDecay = DEFAULT_CROSS_ENTITY_CONFIG.entityHopDecay,
    maxEntityHops = DEFAULT_CROSS_ENTITY_CONFIG.maxEntityHops,
    perEntityCap = DEFAULT_CROSS_ENTITY_CONFIG.perEntityCap,
    mergeHandler,
    mergeThreshold = DEFAULT_MERGE_THRESHOLD,
    salienceEnabled = true,
    categoryInferrer,
  } = config;

  if (baseDir.length === 0) {
    throw new Error("FsMemoryConfig.baseDir must be a non-empty string");
  }
  if (mergeHandler !== undefined && mergeThreshold >= dedupThreshold) {
    throw new Error(
      `FsMemoryConfig.mergeThreshold (${String(mergeThreshold)}) must be less than dedupThreshold (${String(dedupThreshold)})`,
    );
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
  const entityIndex = createEntityIndex();
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
    // let — reassigned in inferrer fallback path
    let category = options?.category;
    if (category === undefined && categoryInferrer !== undefined) {
      try {
        const inferred = await categoryInferrer(content);
        category = inferred.length > 0 ? inferred : "context";
      } catch (inferErr: unknown) {
        console.warn(`[memory-fs] Category inferrer failed, falling back to "context"`, {
          cause: inferErr,
        });
        category = "context";
      }
    }
    if (category === undefined) {
      category = "context";
    }

    const causalParents =
      options?.causalParents !== undefined && options.causalParents.length > 0
        ? options.causalParents
        : undefined;

    // let — reassigned in merge path when handler enriches content
    let newFact: MemoryFact = {
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

    // Jaccard dedup / merge: skip, merge, or supersede based on similarity zones
    // [dedupThreshold, 1.0] → skip/reinforce
    // [mergeThreshold, dedupThreshold) → merge (if handler provided)
    // [0, mergeThreshold) → new fact (fall through to supersede check)
    for (const old of activeInCategory) {
      const similarity = jaccard(content, old.fact);

      if (similarity >= dedupThreshold) {
        if (options?.reinforce === true) {
          // Reinforce: boost existing fact's salience instead of silently skipping
          await factStore.updateFact(entity, old.id, {
            lastAccessed: now.toISOString(),
            accessCount: old.accessCount + 1,
          });
        }
        return; // Duplicate — skip creating new fact
      }

      // Merge zone: handler decides whether to merge or fall through
      if (similarity >= mergeThreshold && mergeHandler !== undefined) {
        try {
          const merged = await mergeHandler(old.fact, content);
          if (merged !== undefined && merged.length > 0) {
            // Supersede old fact, store merged text
            await factStore.updateFact(entity, old.id, {
              status: "superseded",
              supersededBy: newFact.id,
            });
            // Combine causal parents from both facts
            const oldParents = old.causalParents ?? [];
            const newParents = causalParents ?? [];
            const combinedParents = [...new Set([...oldParents, ...newParents])];
            // Replace newFact content with merged text and combined parents
            newFact = {
              ...newFact,
              fact: merged,
              ...(combinedParents.length > 0 ? { causalParents: combinedParents } : {}),
            };
            break; // Merged — skip further dedup/merge checks
          }
          // Handler returned undefined or "" — fall through to supersede check
        } catch (mergeErr: unknown) {
          // Merge handler failed — fall through to supersede check (original fact not lost)
          console.warn(
            `[memory-fs] Merge handler failed for entity "${entity}", falling through to supersede`,
            { cause: mergeErr },
          );
        }
      }
    }

    // Explicit supersession: mark referenced facts as superseded
    if (options?.supersedes !== undefined && options.supersedes.length > 0) {
      const supersedIds = new Set(options.supersedes);
      for (const old of existing) {
        if (old.status === "active" && supersedIds.has(old.id)) {
          await factStore.updateFact(entity, old.id, {
            status: "superseded",
            supersededBy: newFact.id,
          });
        }
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

    // Incremental update: index cross-entity references for this fact
    entityIndex.addFact(newFact, entity);

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

  /** Expand candidates across entity boundaries via relatedEntities links. */
  async function applyCrossEntityExpansion(
    candidates: readonly ScoredCandidate[],
    facts: FactStore,
  ): Promise<readonly ScoredCandidate[]> {
    // Lazy init: build index from cached facts on first recall
    if (!entityIndex.isBuilt()) {
      await entityIndex.build(facts);
    }
    return expandCrossEntity(candidates, entityIndex, facts, {
      entityHopDecay,
      maxEntityHops,
      perEntityCap,
    });
  }

  /** Shared post-processing: tier filter, graph expansion, access-stat updates, limit. */
  async function processRecallCandidates(
    candidates: readonly ScoredCandidate[],
    options: MemoryRecallOptions | undefined,
    facts: FactStore,
  ): Promise<readonly MemoryResult[]> {
    const now = new Date();
    const limit = options?.limit ?? 10;
    const filtered = applyTierFilter(candidates, options?.tierFilter);

    const expanded =
      options?.graphExpand === true && filtered.length > 0
        ? await applyGraphExpansion(filtered, options.maxHops ?? 2, facts)
        : filtered;

    // Phase 2: cross-entity expansion (also gated on graphExpand)
    const crossExpanded =
      options?.graphExpand === true && expanded.length > 0
        ? await applyCrossEntityExpansion(expanded, facts)
        : expanded;

    // Apply composite salience scoring (similarity × log(accessCount+2) × decay)
    const scored = salienceEnabled
      ? computeSalienceScores(crossExpanded, now, { halfLifeDays: decayHalfLifeDays })
      : crossExpanded;

    // Sort by score descending, apply limit
    const sorted = [...scored].sort((a, b) => b.score - a.score).slice(0, limit);

    // Map to results and batch update access stats
    const nowIso = now.toISOString();
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

    // Resolve namespace slug for filtering (undefined = no filter)
    const nsSlug = options?.namespace !== undefined ? slugifyEntity(options.namespace) : undefined;

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
        const entity = resolveEntity({ relatedEntities: fact.relatedEntities });
        // Namespace filter: skip facts that don't belong to the requested namespace
        if (nsSlug !== undefined && entity !== nsSlug) continue;
        candidates.push({ fact, entity, score: hit.score });
      }

      return processRecallCandidates(candidates, options, factStore);
    }

    // Fallback: scan all cached facts, sort by recency
    const allEntities = await factStore.listEntities();
    // Namespace filter: only scan entities matching the namespace slug
    const filteredEntities =
      nsSlug !== undefined ? allEntities.filter((ent) => ent === nsSlug) : allEntities;
    const entityFactArrays = await Promise.all(
      filteredEntities.map(async (ent) => ({ ent, facts: await factStore.readFacts(ent) })),
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
