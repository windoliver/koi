/**
 * Pure query-matching logic for ForgeStore.search().
 *
 * Operates on BrickArtifactBase (metadata) — all filter dimensions
 * including classification and contentMarkers. Extracted from
 * duplicate implementations in @koi/forge and @koi/store-fs.
 */

import type { BrickArtifactBase, ForgeQuery } from "@koi/core";

/** Returns true if the brick metadata matches all non-undefined query filters. */
export function matchesBrickQuery(brick: BrickArtifactBase, query: ForgeQuery): boolean {
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
  if (query.createdBy !== undefined && brick.provenance.metadata.agentId !== query.createdBy) {
    return false;
  }
  if (
    query.classification !== undefined &&
    brick.provenance.classification !== query.classification
  ) {
    return false;
  }
  if (query.contentMarkers !== undefined && query.contentMarkers.length > 0) {
    for (const marker of query.contentMarkers) {
      if (!brick.provenance.contentMarkers.includes(marker)) {
        return false;
      }
    }
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
