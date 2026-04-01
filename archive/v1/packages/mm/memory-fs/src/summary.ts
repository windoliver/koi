/**
 * Rebuild summary.md for a single entity.
 *
 * Keeps Hot + Warm facts sorted by recency, capped at maxFacts.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyTier, computeDecayScore } from "./decay.js";
import type { MemoryFact } from "./types.js";

interface SummaryConfig {
  readonly decayHalfLifeDays: number;
  readonly freqProtectThreshold: number;
}

export async function rebuildSummary(
  baseDir: string,
  entity: string,
  facts: readonly MemoryFact[],
  maxFacts: number,
  config: SummaryConfig,
): Promise<void> {
  const now = new Date();
  const active = facts.filter((f) => f.status === "active");

  const scored = active
    .map((f) => ({
      fact: f,
      decay: computeDecayScore(f.lastAccessed, now, config.decayHalfLifeDays),
    }))
    .map((s) => ({
      ...s,
      tier: classifyTier(s.decay, s.fact.accessCount, config.freqProtectThreshold),
    }));

  const kept = scored
    .filter((s) => s.tier === "hot" || s.tier === "warm")
    .sort((a, b) => new Date(b.fact.timestamp).getTime() - new Date(a.fact.timestamp).getTime())
    .slice(0, maxFacts);

  const lines =
    kept.length === 0 ? "" : `${kept.map((s) => `- [${s.tier}] ${s.fact.fact}`).join("\n")}\n`;

  const entityDir = join(baseDir, "entities", entity);
  await mkdir(entityDir, { recursive: true });
  await writeFile(join(entityDir, "summary.md"), lines, "utf-8");
}
