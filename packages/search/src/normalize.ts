import type { ScoreNormalizer } from "./fusion-types.js";

/** Min-max normalization: scales scores to [0, 1] */
export function normalizeMinMax(scores: readonly number[]): readonly number[] {
  if (scores.length === 0) return [];
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const s of scores) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  const range = max - min;
  if (range === 0) return scores.map(() => 1);
  return scores.map((s) => (s - min) / range);
}

/** Z-score normalization: (x - mean) / stddev, then clamp to [0, 1] */
export function normalizeZScore(scores: readonly number[]): readonly number[] {
  if (scores.length === 0) return [];
  const n = scores.length;
  const mean = scores.reduce((sum, s) => sum + s, 0) / n;
  const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  if (stddev === 0) return scores.map(() => 1);
  return scores.map((s) => Math.max(0, Math.min(1, ((s - mean) / stddev) * 0.5 + 0.5)));
}

/** L2 normalization: x / ||x||_2 */
export function normalizeL2(scores: readonly number[]): readonly number[] {
  if (scores.length === 0) return [];
  const norm = Math.sqrt(scores.reduce((sum, s) => sum + s * s, 0));
  if (norm === 0) return scores.map(() => 0);
  return scores.map((s) => s / norm);
}

/** Dispatch to named normalizer */
export function normalize(scores: readonly number[], method: ScoreNormalizer): readonly number[] {
  switch (method) {
    case "min_max":
      return normalizeMinMax(scores);
    case "z_score":
      return normalizeZScore(scores);
    case "l2":
      return normalizeL2(scores);
  }
}
