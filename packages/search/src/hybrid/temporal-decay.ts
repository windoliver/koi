import type { SearchResult } from "../types.js";

export interface TemporalDecayConfig {
  /** Half-life in days. After this many days, score is halved. Default 30 */
  readonly halfLifeDays: number;
  /** Metadata field containing ISO timestamp or epoch ms. Default "indexedAt" */
  readonly timestampField: string;
  /** Reference time for age calculation. Default Date.now() */
  readonly now?: number;
}

const DEFAULT_HALF_LIFE_DAYS = 30;
const DEFAULT_TIMESTAMP_FIELD = "indexedAt";
const MS_PER_DAY = 86_400_000;

/**
 * Apply exponential temporal decay to search scores.
 *
 * score_final = score * e^(-λ * ageDays)
 * where λ = ln(2) / halfLifeDays
 *
 * Documents without a timestamp field are left unchanged (evergreen).
 */
export function applyTemporalDecay(
  results: readonly SearchResult[],
  config?: Partial<TemporalDecayConfig>,
): readonly SearchResult[] {
  const halfLife = config?.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const field = config?.timestampField ?? DEFAULT_TIMESTAMP_FIELD;
  const now = config?.now ?? Date.now();
  const lambda = Math.LN2 / halfLife;

  return results.map((result) => {
    if (result.metadata.evergreen === true) return result; // Explicitly evergreen
    const timestamp = result.metadata[field];
    if (timestamp === undefined) return result; // No timestamp — evergreen

    const ts = typeof timestamp === "number" ? timestamp : Date.parse(String(timestamp));
    if (Number.isNaN(ts)) return result;

    const ageDays = Math.max(0, (now - ts) / MS_PER_DAY);
    const decayFactor = Math.exp(-lambda * ageDays);

    return { ...result, score: result.score * decayFactor };
  });
}
