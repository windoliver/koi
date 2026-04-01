/**
 * Exponential decay scoring + Hot/Warm/Cold tiering.
 */
import type { MemoryTier } from "@koi/core";

const MS_PER_DAY = 86_400_000;

export function computeDecayScore(
  lastAccessedIso: string,
  now: Date,
  halfLifeDays: number,
): number {
  const ageDays = (now.getTime() - new Date(lastAccessedIso).getTime()) / MS_PER_DAY;
  const lambda = Math.LN2 / halfLifeDays;
  return Math.exp(-lambda * Math.max(0, ageDays));
}

export function classifyTier(
  decayScore: number,
  accessCount: number,
  freqProtectThreshold: number,
): MemoryTier {
  if (decayScore >= 0.7) return "hot";
  if (decayScore >= 0.3 || accessCount >= freqProtectThreshold) return "warm";
  return "cold";
}
