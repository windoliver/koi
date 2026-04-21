import type { CollectiveMemory, CollectiveMemoryDefaults } from "@koi/core";
import { COLLECTIVE_MEMORY_DEFAULTS } from "@koi/core";
import { compactEntries } from "@koi/validation";

export function shouldCompact(
  memory: CollectiveMemory,
  maxEntries: number = COLLECTIVE_MEMORY_DEFAULTS.maxEntries,
  maxTokens: number = COLLECTIVE_MEMORY_DEFAULTS.maxTokens,
): boolean {
  return memory.entries.length > maxEntries || memory.totalTokens > maxTokens;
}

export function compactCollectiveMemory(
  memory: CollectiveMemory,
  overrides?: Partial<CollectiveMemoryDefaults>,
): CollectiveMemory {
  const defaults: CollectiveMemoryDefaults = { ...COLLECTIVE_MEMORY_DEFAULTS, ...overrides };
  return compactEntries(memory, defaults);
}
