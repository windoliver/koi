/**
 * Default consolidator — turns curation candidates into playbooks.
 *
 * For each candidate:
 *   - If a matching playbook exists: blend confidence via EMA, update strategy.
 *   - Otherwise: create a new playbook from the candidate stats.
 */

import type { CurationCandidate, Playbook } from "./types.js";

export interface DefaultConsolidatorOptions {
  /** EMA blending factor (0–1). Higher = more weight on new score. Default 0.3. */
  readonly alpha?: number;
  /** Timestamp source. Default Date.now. */
  readonly clock?: () => number;
}

const DEFAULT_ALPHA = 0.3;

/**
 * Creates a synchronous consolidation function compatible with `AceConfig.consolidate`.
 *
 * Returned function accepts curated candidates + existing playbooks, and returns
 * only the changed/new playbooks (not the full list).
 */
export function createDefaultConsolidator(
  options?: DefaultConsolidatorOptions,
): (
  candidates: readonly CurationCandidate[],
  existing: readonly Playbook[],
) => readonly Playbook[] {
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
