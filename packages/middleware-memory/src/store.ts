/**
 * Memory store interfaces and default implementations.
 */

import type { JsonObject } from "@koi/core/common";

export interface MemoryEntry {
  readonly content: string;
  readonly score?: number;
  readonly timestamp: number;
  readonly metadata?: JsonObject;
}

export interface MemoryStore {
  readonly recall: (query: string, maxTokens: number) => Promise<readonly MemoryEntry[]>;
  readonly store: (sessionId: string, content: string, metadata?: JsonObject) => Promise<void>;
}

/**
 * Estimate token count from text length.
 * Rough heuristic: ~4 chars per token.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * In-memory store with recency-based recall and token budget.
 */
export function createInMemoryStore(): MemoryStore {
  const entries: MemoryEntry[] = [];

  return {
    async recall(_query: string, maxTokens: number): Promise<readonly MemoryEntry[]> {
      // Recency-based: start from most recent
      const sorted = [...entries].sort((a, b) => b.timestamp - a.timestamp);
      const result: MemoryEntry[] = [];
      let tokensUsed = 0;

      for (const entry of sorted) {
        const entryTokens = estimateTokens(entry.content);
        if (tokensUsed + entryTokens > maxTokens) break;
        tokensUsed += entryTokens;
        result.push(entry);
      }

      return result;
    },

    async store(_sessionId: string, content: string, metadata?: JsonObject): Promise<void> {
      const entry: MemoryEntry =
        metadata !== undefined
          ? { content, timestamp: Date.now(), metadata }
          : { content, timestamp: Date.now() };
      entries.push(entry);
    },
  };
}
