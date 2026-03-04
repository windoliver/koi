/**
 * Brick update applicator — immutable merge of BrickUpdate onto a BrickArtifact.
 *
 * Replaces the repeated conditional-spread pattern across store implementations
 * (memory-store, fs-store, overlay-store). Single source of truth for which
 * BrickUpdate fields are applied and how.
 */

import type { BrickArtifactBase, BrickUpdate } from "@koi/core";

/**
 * Applies defined fields from `updates` to `existing`, returning a new object.
 * Never mutates either argument. Only fields explicitly present (not undefined)
 * in `updates` override the corresponding field in `existing`.
 */
export function applyBrickUpdate<T extends BrickArtifactBase>(
  existing: T,
  updates: BrickUpdate,
): T {
  return {
    ...existing,
    ...(updates.lifecycle !== undefined ? { lifecycle: updates.lifecycle } : {}),
    ...(updates.trustTier !== undefined ? { trustTier: updates.trustTier } : {}),
    ...(updates.scope !== undefined ? { scope: updates.scope } : {}),
    ...(updates.usageCount !== undefined ? { usageCount: updates.usageCount } : {}),
    ...(updates.tags !== undefined ? { tags: updates.tags } : {}),
    ...(updates.lastVerifiedAt !== undefined ? { lastVerifiedAt: updates.lastVerifiedAt } : {}),
    ...(updates.fitness !== undefined ? { fitness: updates.fitness } : {}),
    ...(updates.lastPromotedAt !== undefined ? { lastPromotedAt: updates.lastPromotedAt } : {}),
    ...(updates.lastDemotedAt !== undefined ? { lastDemotedAt: updates.lastDemotedAt } : {}),
    ...(updates.trailStrength !== undefined ? { trailStrength: updates.trailStrength } : {}),
    ...(updates.driftContext !== undefined ? { driftContext: updates.driftContext } : {}),
    ...(updates.collectiveMemory !== undefined
      ? { collectiveMemory: updates.collectiveMemory }
      : {}),
  };
}
