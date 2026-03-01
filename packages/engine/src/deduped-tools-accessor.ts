/**
 * Memoized accessor for deduplicating entity + forged tool descriptors.
 *
 * Forged descriptors take precedence over entity descriptors with the same name.
 * The result array reference is stable when the forged ref hasn't changed,
 * avoiding O(n) allocations on every access.
 */

import type { ToolDescriptor } from "@koi/core";

export interface DedupedToolsAccessor {
  /** Get the current merged + deduped descriptor list. */
  readonly get: () => readonly ToolDescriptor[];
  /** Update the forged descriptors. Invalidates memoization when ref changes. */
  readonly updateForged: (forged: readonly ToolDescriptor[]) => void;
}

export function createDedupedToolsAccessor(
  entityDescriptors: readonly ToolDescriptor[],
): DedupedToolsAccessor {
  // let justified: mutable memo for deduped tools — avoids O(n) alloc per access
  let memo: readonly ToolDescriptor[] = entityDescriptors;
  // let justified: mutable ref tracking for identity-based skip
  let currentForgedRef: readonly ToolDescriptor[] = [];
  // let justified: mutable cached forged descriptors
  let cachedForged: readonly ToolDescriptor[] = [];

  return {
    get(): readonly ToolDescriptor[] {
      if (cachedForged.length === 0) {
        return entityDescriptors;
      }
      // Memoized: recompute only when forged ref changes
      if (currentForgedRef !== cachedForged) {
        currentForgedRef = cachedForged;
        const forgedNames = new Set(cachedForged.map((d) => d.name));
        memo = [...cachedForged, ...entityDescriptors.filter((d) => !forgedNames.has(d.name))];
      }
      return memo;
    },
    updateForged(forged: readonly ToolDescriptor[]): void {
      cachedForged = forged;
    },
  };
}
