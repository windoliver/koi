/**
 * Failure aggregation pipeline — transforms raw failures into qualified
 * synthesis input by deduplicating, filtering stale data, checking
 * sufficiency, and clustering by error pattern.
 *
 * All functions are pure — no side effects, no I/O.
 */

import { computeContentHash } from "@koi/hash";
import type { AggregatorConfig, QualifiedFailures, ToolFailureRecord } from "./types.js";
import { DEFAULT_AGGREGATOR_CONFIG } from "./types.js";

// ---------------------------------------------------------------------------
// Recursion filter (Issue 6A)
// ---------------------------------------------------------------------------

/**
 * Exclude failures from harness-synthesized middleware to prevent
 * infinite synthesis loops. Uses the provenance `forgedBy` tag.
 */
export function filterRecursive(
  records: readonly ToolFailureRecord[],
  excludeForgedBy: readonly string[],
): readonly ToolFailureRecord[] {
  if (excludeForgedBy.length === 0) return records;
  const excludeSet = new Set(excludeForgedBy);
  return records.filter((r) => r.forgedBy === undefined || !excludeSet.has(r.forgedBy));
}

// ---------------------------------------------------------------------------
// Staleness filter
// ---------------------------------------------------------------------------

/** Remove failures older than maxAgeMs from now. */
export function filterStale(
  records: readonly ToolFailureRecord[],
  now: number,
  maxAgeMs: number,
): { readonly fresh: readonly ToolFailureRecord[]; readonly staleCount: number } {
  const fresh = records.filter((r) => now - r.timestamp <= maxAgeMs);
  return { fresh, staleCount: records.length - fresh.length };
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Dedup key: (toolName, errorCode, paramHash).
 * Keeps the most recent failure per group.
 */
function computeDedupKey(record: ToolFailureRecord): string {
  const paramStr = JSON.stringify(record.parameters);
  const paramHash = computeContentHash(paramStr);
  return `${record.toolName}::${record.errorCode}::${paramHash}`;
}

/** Deduplicate failures, keeping the most recent per (tool, error, params). */
export function deduplicateFailures(records: readonly ToolFailureRecord[]): {
  readonly deduplicated: readonly ToolFailureRecord[];
  readonly removedCount: number;
} {
  const seen = new Map<string, ToolFailureRecord>();
  for (const record of records) {
    const key = computeDedupKey(record);
    const existing = seen.get(key);
    if (existing === undefined || record.timestamp > existing.timestamp) {
      seen.set(key, record);
    }
  }
  const deduplicated = [...seen.values()];
  return { deduplicated, removedCount: records.length - deduplicated.length };
}

// ---------------------------------------------------------------------------
// Error pattern clustering
// ---------------------------------------------------------------------------

/** Group failures by errorCode to identify distinct failure modes. */
export function clusterByErrorPattern(
  records: readonly ToolFailureRecord[],
): ReadonlyMap<string, readonly ToolFailureRecord[]> {
  const clusters = new Map<string, ToolFailureRecord[]>();
  for (const record of records) {
    const existing = clusters.get(record.errorCode);
    if (existing !== undefined) {
      existing.push(record);
    } else {
      clusters.set(record.errorCode, [record]);
    }
  }
  return clusters;
}

// ---------------------------------------------------------------------------
// Main aggregation pipeline
// ---------------------------------------------------------------------------

/**
 * Full aggregation pipeline:
 * 1. Filter recursive (provenance-based exclusion)
 * 2. Filter stale (time-based)
 * 3. Deduplicate (by tool + error + params)
 * 4. Check sufficiency (minimum distinct failures)
 * 5. Cluster by error pattern
 *
 * Returns null if insufficient data for synthesis.
 */
export function aggregateFailures(
  raw: readonly ToolFailureRecord[],
  now: number,
  config: AggregatorConfig = DEFAULT_AGGREGATOR_CONFIG,
): QualifiedFailures | null {
  // Step 1: Recursion prevention
  const nonRecursive = filterRecursive(raw, config.excludeForgedBy);

  // Step 2: Staleness filter
  const { fresh, staleCount } = filterStale(nonRecursive, now, config.maxAgeMs);

  // Step 3: Deduplication
  const { deduplicated, removedCount } = deduplicateFailures(fresh);

  // Step 4: Sufficiency check
  if (deduplicated.length < config.minFailures) {
    return null;
  }

  // Step 5: Clustering
  const clusters = clusterByErrorPattern(deduplicated);

  return {
    failures: deduplicated,
    rawCount: raw.length,
    deduplicatedCount: removedCount,
    staleCount,
    clusterCount: clusters.size,
  };
}
