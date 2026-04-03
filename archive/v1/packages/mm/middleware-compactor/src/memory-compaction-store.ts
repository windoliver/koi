/**
 * In-memory CompactionStore — default implementation.
 *
 * Stores compaction results in a Map keyed by session ID.
 * Suitable for single-process use; inject a persistent store
 * (e.g., backed by ~/nexus) for cross-session durability.
 */

import type { CompactionResult } from "@koi/core/context";
import type { CompactionStore } from "./types.js";

export function createMemoryCompactionStore(): CompactionStore {
  const data = new Map<string, CompactionResult>();

  return {
    save(sessionId: string, result: CompactionResult): void {
      data.set(sessionId, result);
    },
    load(sessionId: string): CompactionResult | undefined {
      return data.get(sessionId);
    },
  };
}
