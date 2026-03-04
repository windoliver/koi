/**
 * Compaction — delegates to @koi/validation pure functions.
 *
 * Provides a thin wrapper that bridges middleware config defaults
 * to the validation layer's compactEntries function.
 */

import type { CollectiveMemory, CollectiveMemoryDefaults } from "@koi/core";
import { COLLECTIVE_MEMORY_DEFAULTS } from "@koi/core";
import { compactEntries } from "@koi/validation";

/**
 * Returns true when collective memory exceeds either entry count or token thresholds.
 */
export function shouldCompact(
  memory: CollectiveMemory,
  maxEntries: number = COLLECTIVE_MEMORY_DEFAULTS.maxEntries,
  maxTokens: number = COLLECTIVE_MEMORY_DEFAULTS.maxTokens,
): boolean {
  return memory.entries.length > maxEntries || memory.totalTokens > maxTokens;
}

/**
 * Runs Phase 1 compaction: prune → dedup → trim.
 * Thin wrapper over @koi/validation's compactEntries.
 */
export function compactCollectiveMemory(
  memory: CollectiveMemory,
  overrides?: Partial<CollectiveMemoryDefaults>,
): CollectiveMemory {
  const defaults: CollectiveMemoryDefaults = {
    ...COLLECTIVE_MEMORY_DEFAULTS,
    ...overrides,
  };
  return compactEntries(memory, defaults);
}
