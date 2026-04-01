/**
 * assembleToolPool() — Normalize, deduplicate, and sort a collection of tools.
 *
 * Dedup rule: when two tools share a name, the one with higher origin
 * precedence wins (primordial > operator > forged). Ties keep the first
 * occurrence. Result is sorted alphabetically by name.
 */

import type { Tool, ToolOrigin } from "@koi/core";

// ---------------------------------------------------------------------------
// Origin precedence (lower = higher priority)
// ---------------------------------------------------------------------------

const ORIGIN_PRECEDENCE: Readonly<Record<ToolOrigin, number>> = {
  primordial: 0,
  operator: 1,
  forged: 2,
} as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deduplicate and sort tools into a deterministic pool.
 *
 * - Dedup by `descriptor.name`: higher origin precedence wins.
 * - Sort alphabetically by name.
 * - Returns a new array (never mutates input).
 */
export function assembleToolPool(tools: readonly Tool[]): readonly Tool[] {
  if (tools.length === 0) return [];

  // Dedup: keep the tool with highest origin precedence per name
  const byName = new Map<string, Tool>();

  for (const tool of tools) {
    const name = tool.descriptor.name;
    const existing = byName.get(name);

    if (existing === undefined) {
      byName.set(name, tool);
      continue;
    }

    const existingPrecedence = ORIGIN_PRECEDENCE[existing.origin];
    const newPrecedence = ORIGIN_PRECEDENCE[tool.origin];

    // Lower number = higher precedence; on tie keep existing (first-wins)
    if (newPrecedence < existingPrecedence) {
      byName.set(name, tool);
    }
  }

  // Sort alphabetically by name
  const result = [...byName.values()];
  result.sort((a, b) => a.descriptor.name.localeCompare(b.descriptor.name));

  return result;
}
