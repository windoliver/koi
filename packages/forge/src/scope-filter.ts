/**
 * Scope-based visibility filtering for forge bricks.
 *
 * Pure functions used by search_forge and ForgeResolver to enforce
 * agent-scoped brick visibility.
 */

import type { BrickArtifact } from "@koi/core";

/**
 * Returns true if the given brick is visible to the specified agent.
 * - `global` scoped bricks are visible to all agents.
 * - `zone` scoped bricks are visible to all agents when zoneId is undefined
 *   (backward compat). When zoneId is provided, the brick must have a
 *   matching `zone:<zoneId>` tag.
 * - `agent` scoped bricks are only visible to their creator.
 *
 * Fail-closed: unknown scope values deny access.
 */
export function isVisibleToAgent(
  brick: BrickArtifact,
  agentId: string,
  zoneId?: string | undefined,
): boolean {
  switch (brick.scope) {
    case "global":
      return true;
    case "zone":
      // No zoneId → backward compat: zone bricks visible to all
      if (zoneId === undefined) return true;
      // Check for matching zone tag
      return brick.tags.includes(`zone:${zoneId}`);
    case "agent":
      return brick.provenance.metadata.agentId === agentId;
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
  zoneId?: string | undefined,
): readonly BrickArtifact[] {
  return bricks.filter((b) => isVisibleToAgent(b, agentId, zoneId));
}
