/**
 * Default consolidator — turns curation candidates into playbooks via EMA blending.
 *
 * For each candidate:
 *   - matching playbook → blend confidence via EMA, refresh strategy, bump version
 *   - no match → new playbook seeded from candidate stats at version 1
 */

import type { CurationCandidate, Playbook } from "@koi/ace-types";

export interface DefaultConsolidatorOptions {
  /** EMA blending factor (0–1). Higher = more weight on new score. Default 0.3. */
  readonly alpha?: number;
  /** Timestamp source. Default `Date.now`. */
  readonly clock?: () => number;
}

const DEFAULT_ALPHA = 0.3;

export type ConsolidateFn = (
  candidates: readonly CurationCandidate[],
  existing: readonly Playbook[],
) => readonly Playbook[];

/**
 * Returns a synchronous consolidate function. Output contains only changed/new
 * playbooks — caller merges the result into the playbook store.
 */
export function createDefaultConsolidator(options?: DefaultConsolidatorOptions): ConsolidateFn {
  const alpha = options?.alpha ?? DEFAULT_ALPHA;
  const clock = options?.clock ?? Date.now;

  return (candidates, existing) => {
    const existingMap = new Map(existing.map((p) => [p.id, p]));
    const nowMs = clock();

    return candidates.map((c) => {
      const id = `ace:${c.kind}:${c.identifier}`;
      const prev = existingMap.get(id);

      if (prev !== undefined) {
        return {
          ...prev,
          confidence: clamp01(alpha * c.score + (1 - alpha) * prev.confidence),
          strategy: generateStrategy(c),
          updatedAt: nowMs,
          sessionCount: prev.sessionCount + 1,
          version: prev.version + 1,
        };
      }

      return {
        id,
        title: `${c.kind === "model_call" ? "Model" : "Tool"}: ${c.identifier}`,
        strategy: generateStrategy(c),
        tags: [c.kind],
        confidence: clamp01(c.score),
        source: "curated" as const,
        createdAt: nowMs,
        updatedAt: nowMs,
        sessionCount: 1,
        version: 1,
      };
    });
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function generateStrategy(c: CurationCandidate): string {
  const rate =
    c.stats.invocations > 0 ? ((c.stats.successes / c.stats.invocations) * 100).toFixed(0) : "0";
  const avgMs =
    c.stats.invocations > 0 ? (c.stats.totalDurationMs / c.stats.invocations).toFixed(0) : "0";
  return `${c.identifier}: ${rate}% success rate across ${c.stats.invocations} calls (avg ${avgMs}ms).`;
}
