/**
 * Demo pack runner — looks up a pack by ID and runs its seed function.
 */

import { BASE_PACK } from "./packs/base.js";
import { CONNECTED_PACK } from "./packs/connected.js";
import type { DemoPack, SeedContext, SeedResult } from "./types.js";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const PACK_REGISTRY: Readonly<Record<string, DemoPack>> = {
  base: BASE_PACK,
  connected: CONNECTED_PACK,
} as const;

/** All known pack IDs. */
export const PACK_IDS: readonly string[] = Object.keys(PACK_REGISTRY);

/**
 * Looks up a demo pack by ID. Returns undefined for unknown IDs.
 */
export function getPack(id: string): DemoPack | undefined {
  return PACK_REGISTRY[id];
}

/**
 * Lists all available demo packs with their metadata.
 */
export function listPacks(): readonly DemoPack[] {
  return Object.values(PACK_REGISTRY);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Runs a demo pack's seed function.
 *
 * First runs the base pack (bootstrap files), then the requested pack.
 * Returns a combined SeedResult.
 */
export async function runSeed(packId: string, ctx: SeedContext): Promise<SeedResult> {
  const pack = PACK_REGISTRY[packId];
  if (pack === undefined) {
    return {
      ok: false,
      counts: {},
      summary: [`Unknown demo pack: "${packId}". Available: ${PACK_IDS.join(", ")}`],
    };
  }

  // Always run base pack first for bootstrap files
  const baseResult =
    packId !== "base" ? await BASE_PACK.seed(ctx) : { ok: true, counts: {}, summary: [] };

  // Run the requested pack
  const packResult = await pack.seed(ctx);

  // Merge results
  const counts = { ...baseResult.counts, ...packResult.counts };
  const summary = [...baseResult.summary, ...packResult.summary];

  return {
    ok: baseResult.ok && packResult.ok,
    counts,
    summary,
  };
}
