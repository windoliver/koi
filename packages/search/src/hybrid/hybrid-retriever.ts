import type { Retriever } from "../contracts.js";
import type {
  FusionStrategy,
  SearchOutcome,
  SearchPage,
  SearchQuery,
  SearchResult,
} from "../types.js";
import { applyFusion } from "./fusion.js";
import type { MmrConfig } from "./mmr.js";
import { applyMmr } from "./mmr.js";
import type { TemporalDecayConfig } from "./temporal-decay.js";
import { applyTemporalDecay } from "./temporal-decay.js";

export interface HybridRetrieverConfig {
  readonly retrievers: readonly Retriever[];
  readonly fusion: FusionStrategy;
  readonly candidateMultiplier?: number;
  readonly timeoutMs?: number;
  readonly mmr?: Partial<MmrConfig>;
  readonly temporalDecay?: Partial<TemporalDecayConfig>;
}

const DEFAULT_CANDIDATE_MULTIPLIER = 2;
const DEFAULT_TIMEOUT_MS = 5000;

export function createHybridRetriever(config: HybridRetrieverConfig): Retriever {
  const multiplier = config.candidateMultiplier ?? DEFAULT_CANDIDATE_MULTIPLIER;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    retrieve: async (query: SearchQuery): Promise<SearchOutcome<SearchPage>> => {
      // Over-fetch from each retriever for better fusion
      // Omit offset/minScore — each retriever starts from 0; we paginate after fusion
      const expandedQuery: SearchQuery = {
        text: query.text,
        limit: query.limit * multiplier,
        ...(query.filter !== undefined ? { filter: query.filter } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      };

      // Run all retrievers in parallel with timeout
      const promises = config.retrievers.map((retriever) =>
        withTimeout(retriever.retrieve(expandedQuery), timeoutMs),
      );

      const settled = await Promise.allSettled(promises);

      // Collect successful results (graceful degradation)
      const rankedLists: (readonly SearchResult[])[] = [];
      for (const result of settled) {
        if (result.status === "fulfilled" && result.value.ok) {
          rankedLists.push(result.value.value.results);
        }
      }

      if (rankedLists.length === 0) {
        return {
          ok: false,
          error: {
            kind: "backend_unavailable",
            backend: "all",
            cause: "All retrievers failed or timed out",
          },
        };
      }

      // Apply fusion
      const fused = applyFusion(config.fusion, rankedLists, query.limit * multiplier);

      // Apply temporal decay (before MMR so recency affects diversity selection)
      let results: readonly SearchResult[] = config.temporalDecay
        ? applyTemporalDecay(fused, config.temporalDecay)
        : fused;

      // Apply MMR re-ranking for diversity
      if (config.mmr) {
        results = applyMmr(results, query.limit * multiplier, config.mmr);
      }

      // Apply minScore post-fusion
      let filtered = [...results];
      if (query.minScore !== undefined) {
        const min = query.minScore;
        filtered = filtered.filter((r) => r.score >= min);
      }

      // Apply offset and limit
      const offset = query.offset ?? 0;
      const paged = filtered.slice(offset, offset + query.limit);

      return {
        ok: true,
        value: {
          results: paged,
          total: filtered.length,
          hasMore: offset + query.limit < filtered.length,
        },
      };
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
