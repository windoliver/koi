/**
 * Shared metadata accessor for rule checks.
 *
 * Centralizes access to manifest.metadata (JsonObject | undefined) so rule
 * files don't each define their own inline type guards.
 */

import type { JsonObject } from "@koi/core";

/**
 * Safely retrieves a top-level key from manifest.metadata.
 * Returns undefined if metadata is absent or the key is not present.
 */
export function getMetadataKey(metadata: JsonObject | undefined, key: string): unknown {
  if (metadata === undefined) return undefined;
  return metadata[key];
}
