import type { LatencyStats } from "./types.js";

export function emptyStats(): LatencyStats {
  return { mean: 0, stddev: 0, count: 0, m2: 0 };
}

export function welfordUpdate(s: LatencyStats, x: number): LatencyStats {
  const count = s.count + 1;
  const delta = x - s.mean;
  const mean = s.mean + delta / count;
  const delta2 = x - mean;
  const m2 = s.m2 + delta * delta2;
  const variance = count > 0 ? m2 / count : 0;
  const stddev = Math.sqrt(variance);
  return { mean, stddev, count, m2 };
}
