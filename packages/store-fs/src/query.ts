/**
 * Pure query matching logic for ForgeStore.search().
 *
 * Operates on BrickArtifactBase (metadata) — does not require
 * kind-specific content fields. Duplicated from @koi/forge
 * per Rule of Three (2 occurrences — extract on 3rd).
 */

import type { BrickArtifactBase, ForgeQuery } from "@koi/core";

/** Returns true if the brick metadata matches all non-undefined query filters. */
export function matchesQuery(brick: BrickArtifactBase, query: ForgeQuery): boolean {
  if (query.kind !== undefined && brick.kind !== query.kind) {
    return false;
  }
  if (query.scope !== undefined && brick.scope !== query.scope) {
    return false;
  }
  if (query.trustTier !== undefined && brick.trustTier !== query.trustTier) {
    return false;
  }
  if (query.lifecycle !== undefined && brick.lifecycle !== query.lifecycle) {
    return false;
  }
  if (query.createdBy !== undefined && brick.createdBy !== query.createdBy) {
    return false;
  }
  // Tags use AND-subset matching: brick must contain all query tags
  if (query.tags !== undefined && query.tags.length > 0) {
    for (const tag of query.tags) {
      if (!brick.tags.includes(tag)) {
        return false;
      }
    }
  }
  // Case-insensitive substring match against name + description
  if (query.text !== undefined && query.text.length > 0) {
    const lower = query.text.toLowerCase();
    if (
      !brick.name.toLowerCase().includes(lower) &&
      !brick.description.toLowerCase().includes(lower)
    ) {
      return false;
    }
  }
  return true;
}
