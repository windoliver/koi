/**
 * createFsMemory — factory wiring the L0 MemoryComponent contract.
 *
 * Composes: fact-store, dedup, decay, summary, session-log, optional DI search.
 */
import type { MemoryRecallOptions, MemoryResult, MemoryStoreOptions } from "@koi/core";
import { classifyTier, computeDecayScore } from "./decay.js";
import { jaccard } from "./dedup.js";
import { createFactStore } from "./fact-store.js";
import { appendSessionLog } from "./session-log.js";
import { slugifyEntity } from "./slug.js";
import { rebuildSummary } from "./summary.js";
import type {
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
    };

    // Read existing active facts for dedup
    const existing = await factStore.readFacts(entity);
    const activeInCategory = existing.filter(
      (f) => f.status === "active" && f.category === category,
    );

    // Jaccard dedup: skip if too similar
    for (const old of activeInCategory) {
      if (jaccard(content, old.fact) >= dedupThreshold) {
        return; // Duplicate — skip
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

  const recall = async (
    query: string,
    options?: MemoryRecallOptions,
  ): Promise<readonly MemoryResult[]> => {
    await flushDeferredIndex();

    const limit = options?.limit ?? 10;
    const tierFilter = options?.tierFilter;

    if (retriever !== undefined) {
      const hits = await retriever.retrieve(query, limit * 2);
      const allFacts = await loadAllFacts();

      // Collect results and batch access updates by entity
      const results: MemoryResult[] = [];
      const accessUpdates: Array<{
        readonly entity: string;
        readonly id: string;
        readonly accessCount: number;
      }> = [];

      for (const hit of hits) {
        const fact = allFacts.get(hit.id);
        if (fact === undefined || fact.status !== "active") continue;

        const result = mapFactToResult(fact, hit.score);
        if (tierFilter !== undefined && tierFilter !== "all" && result.tier !== tierFilter) {
          continue;
        }

        results.push(result);
        accessUpdates.push({
          entity: resolveEntity({ relatedEntities: fact.relatedEntities }),
          id: fact.id,
          accessCount: fact.accessCount + 1,
        });
      }

      // Batch update access stats
      const nowIso = new Date().toISOString();
      await Promise.all(
        accessUpdates.map((u) =>
          factStore.updateFact(u.entity, u.id, {
            lastAccessed: nowIso,
            accessCount: u.accessCount,
          }),
        ),
      );

      return results.slice(0, limit);
    }

    // Fallback: scan all cached facts, sort by recency, filter by tier
    const allEntities = await factStore.listEntities();
    const entityFactArrays = await Promise.all(
      allEntities.map(async (ent) => ({ ent, facts: await factStore.readFacts(ent) })),
    );

    const scored: Array<{ readonly fact: MemoryFact; readonly entity: string }> = [];
    for (const { ent, facts } of entityFactArrays) {
      for (const f of facts) {
        if (f.status === "active") {
          scored.push({ fact: f, entity: ent });
        }
      }
    }

    // Sort by recency
    const sorted = [...scored].sort(
      (a, b) => new Date(b.fact.timestamp).getTime() - new Date(a.fact.timestamp).getTime(),
    );

    const results: MemoryResult[] = [];
    const accessUpdates: Array<{
      readonly entity: string;
      readonly id: string;
      readonly accessCount: number;
    }> = [];

    for (const { fact, entity } of sorted) {
      const result = mapFactToResult(fact, 1.0);
      if (tierFilter !== undefined && tierFilter !== "all" && result.tier !== tierFilter) {
        continue;
      }

      results.push(result);
      accessUpdates.push({
        entity,
        id: fact.id,
        accessCount: fact.accessCount + 1,
      });

      if (results.length >= limit) break;
    }

    // Batch update access stats
    const nowIso = new Date().toISOString();
    await Promise.all(
      accessUpdates.map((u) =>
        factStore.updateFact(u.entity, u.id, {
          lastAccessed: nowIso,
          accessCount: u.accessCount,
        }),
      ),
    );

    return results;
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
