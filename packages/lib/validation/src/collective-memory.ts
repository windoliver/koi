/**
 * Collective memory — pure scoring, deduplication, and compaction functions.
 *
 * All functions are side-effect-free: they take entries + config, return new arrays.
 * Used by middleware-collective-memory (L2) for injection ordering and storage compaction.
 */

import type { CollectiveMemory, CollectiveMemoryDefaults, CollectiveMemoryEntry } from "@koi/core";
import { COLLECTIVE_MEMORY_DEFAULTS } from "@koi/core";

// ---------------------------------------------------------------------------
// Priority scoring
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/**
 * Computes a priority score for a memory entry using exponential decay.
 *
 * Formula: `accessCount * e^(-λ * elapsedDays)` where λ = ln(2) / halfLifeDays.
 * Higher score → more relevant for injection.
 */
export function computeMemoryPriority(
  entry: CollectiveMemoryEntry,
  nowMs: number,
  halfLifeDays = 7,
): number {
  const lambda = Math.LN2 / halfLifeDays;
  const elapsedDays = Math.max(0, nowMs - entry.lastAccessedAt) / MS_PER_DAY;
  // Entries with accessCount === 0 still get a base score of 1 so new entries are surfaced
  const weight = Math.max(entry.accessCount, 1);
  return weight * Math.exp(-lambda * elapsedDays);
}

// ---------------------------------------------------------------------------
// Deduplication (Jaccard similarity on word sets)
// ---------------------------------------------------------------------------

/** Tokenizes text into a set of lowercase words for Jaccard comparison. */
function wordSet(text: string): ReadonlySet<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0),
  );
}

/** Computes Jaccard similarity ∈ [0, 1] between two word sets. */
function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Removes near-duplicate entries based on Jaccard similarity.
 * When two entries are similar above `threshold`, keeps the one with higher priority.
 *
 * O(n²) — acceptable for ≤50 entries.
 */
export function deduplicateEntries(
  entries: readonly CollectiveMemoryEntry[],
  threshold: number = COLLECTIVE_MEMORY_DEFAULTS.dedupThreshold,
  nowMs: number = Date.now(),
): readonly CollectiveMemoryEntry[] {
  if (entries.length <= 1) return entries;

  const scored: readonly { readonly entry: CollectiveMemoryEntry; readonly priority: number }[] =
    entries.map((entry) => ({ entry, priority: computeMemoryPriority(entry, nowMs) }));

  // Sort descending by priority — higher-priority entries survive dedup
  const sorted = [...scored].sort((a, b) => b.priority - a.priority);

  const kept: CollectiveMemoryEntry[] = [];
  const keptWordSets: Set<string>[] = [];

  for (const { entry } of sorted) {
    const ws = wordSet(entry.content);
    const isDuplicate = keptWordSets.some(
      (existing) => jaccardSimilarity(ws, existing) >= threshold,
    );
    if (!isDuplicate) {
      kept.push(entry);
      keptWordSets.push(ws as unknown as Set<string>);
    }
  }

  return kept;
}

// ---------------------------------------------------------------------------
// Budget selection
// ---------------------------------------------------------------------------

const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * Selects entries that fit within a token budget, sorted by priority (highest first).
 * Uses a heuristic `chars / charsPerToken` estimate for token counting.
 */
export function selectEntriesWithinBudget(
  entries: readonly CollectiveMemoryEntry[],
  maxTokens: number,
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
  nowMs: number = Date.now(),
): readonly CollectiveMemoryEntry[] {
  if (entries.length === 0 || maxTokens <= 0) return [];

  const sorted = [...entries].sort(
    (a, b) => computeMemoryPriority(b, nowMs) - computeMemoryPriority(a, nowMs),
  );

  const selected: CollectiveMemoryEntry[] = [];
  // let justified: accumulator for consumed token budget
  let consumed = 0;

  for (const entry of sorted) {
    const tokens = Math.ceil(entry.content.length / charsPerToken);
    if (consumed + tokens > maxTokens) continue;
    selected.push(entry);
    consumed += tokens;
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Stale entry pruning
// ---------------------------------------------------------------------------

/**
 * Removes entries with `accessCount === 0` older than `coldAgeDays`.
 * Entries that have been accessed at least once are never pruned.
 */
export function pruneStaleEntries(
  entries: readonly CollectiveMemoryEntry[],
  coldAgeDays: number,
  nowMs: number = Date.now(),
): readonly CollectiveMemoryEntry[] {
  const cutoff = nowMs - coldAgeDays * MS_PER_DAY;
  return entries.filter((e) => e.accessCount > 0 || e.createdAt >= cutoff);
}

// ---------------------------------------------------------------------------
// Compaction (full Phase 1 pipeline)
// ---------------------------------------------------------------------------

/**
 * Estimates total tokens for a set of entries using chars-per-token heuristic.
 */
function estimateTotalTokens(
  entries: readonly CollectiveMemoryEntry[],
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
): number {
  return entries.reduce((sum, e) => sum + Math.ceil(e.content.length / charsPerToken), 0);
}

/**
 * Full Phase 1 compaction pipeline: prune → dedup → trim to maxEntries → update generation.
 *
 * Returns a new CollectiveMemory object with compacted entries and incremented generation.
 */
export function compactEntries(
  memory: CollectiveMemory,
  defaults: CollectiveMemoryDefaults = COLLECTIVE_MEMORY_DEFAULTS,
  nowMs: number = Date.now(),
): CollectiveMemory {
  // 1. Prune stale (never-accessed + old)
  const pruned = pruneStaleEntries(memory.entries, defaults.coldAgeDays, nowMs);

  // 2. Deduplicate
  const deduped = deduplicateEntries(pruned, defaults.dedupThreshold, nowMs);

  // 3. Trim to maxEntries — keep highest-priority entries
  const trimmed =
    deduped.length > defaults.maxEntries
      ? selectEntriesWithinBudget(
          deduped,
          defaults.maxTokens,
          DEFAULT_CHARS_PER_TOKEN,
          nowMs,
        ).slice(0, defaults.maxEntries)
      : deduped;

  return {
    entries: trimmed,
    totalTokens: estimateTotalTokens(trimmed),
    generation: memory.generation + 1,
    lastCompactedAt: nowMs,
  };
}
