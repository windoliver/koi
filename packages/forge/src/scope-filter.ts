/**
 * Scope-based visibility filtering for forge bricks.
 *
 * Pure functions used by search_forge and ForgeResolver to enforce
 * agent-scoped brick visibility. Zone scope is deferred (Phase 2).
 */

import type { BrickArtifact } from "@koi/core";

/**
 * Returns true if the given brick is visible to the specified agent.
 * - `global` and `zone` scoped bricks are visible to all agents.
 * - `agent` scoped bricks are only visible to their creator.
 *
 * Fail-closed: unknown scope values deny access.
 */
export function isVisibleToAgent(brick: BrickArtifact, agentId: string): boolean {
  switch (brick.scope) {
    case "global":
      return true;
    case "zone":
      return true; // Phase 2: add zone-level check
    case "agent":
      return brick.createdBy === agentId;
    default: {
      // Fail closed: unknown scope denies access
      const _exhaustive: never = brick.scope;
      void _exhaustive;
      return false;
    }
  }
}

/**
 * Filters an array of bricks to only those visible to the specified agent.
 */
export function filterByAgentScope(
  bricks: readonly BrickArtifact[],
  agentId: string,
): readonly BrickArtifact[] {
  return bricks.filter((b) => isVisibleToAgent(b, agentId));
}
