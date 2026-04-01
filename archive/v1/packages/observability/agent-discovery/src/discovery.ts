/**
 * Core discovery logic — aggregates sources, deduplicates, filters, caches.
 *
 * Uses `Promise.allSettled()` for partial success: if one source fails,
 * results from other sources are still returned.
 *
 * Deduplication priority: MCP > filesystem > PATH (lower number wins).
 */

import type { ExternalAgentDescriptor } from "@koi/core";
import { SOURCE_PRIORITY } from "./constants.js";
import type { DiscoveryFilter, DiscoverySource } from "./types.js";

export interface DiscoverAgentsOptions {
  readonly filter?: DiscoveryFilter | undefined;
}

export interface DiscoveryHandle {
  readonly discover: (
    options?: DiscoverAgentsOptions,
  ) => Promise<readonly ExternalAgentDescriptor[]>;
  readonly invalidate: () => void;
}

/** Deduplicate descriptors by name — lower priority number wins. */
function deduplicateByName(
  descriptors: readonly ExternalAgentDescriptor[],
): readonly ExternalAgentDescriptor[] {
  const byName = new Map<string, ExternalAgentDescriptor>();
  for (const descriptor of descriptors) {
    const existing = byName.get(descriptor.name);
    if (existing === undefined) {
      byName.set(descriptor.name, descriptor);
    } else {
      const existingPriority = SOURCE_PRIORITY[existing.source];
      const newPriority = SOURCE_PRIORITY[descriptor.source];
      if (newPriority < existingPriority) {
        byName.set(descriptor.name, descriptor);
      }
    }
  }
  return [...byName.values()];
}

/**
 * Creates a discovery handle that aggregates results from multiple sources
 * with caching, deduplication, and filtering.
 */
export function createDiscovery(
  sources: readonly DiscoverySource[],
  cacheTtlMs: number,
): DiscoveryHandle {
  // let justified: mutable cache state for TTL expiry
  let cachedResult: readonly ExternalAgentDescriptor[] | undefined;
  let cacheTimestamp = 0;
  // let justified: tracks in-flight fetch to prevent duplicate concurrent requests
  let inflightFetch: Promise<readonly ExternalAgentDescriptor[]> | undefined;

  const fetchAll = async (): Promise<readonly ExternalAgentDescriptor[]> => {
    const now = Date.now();
    if (cachedResult !== undefined && now - cacheTimestamp < cacheTtlMs) {
      return cachedResult;
    }
    if (inflightFetch !== undefined) return inflightFetch;

    inflightFetch = (async () => {
      const settled = await Promise.allSettled(sources.map((s) => s.discover()));

      const all = settled.flatMap((result) =>
        result.status === "fulfilled" ? [...result.value] : [],
      );

      const deduped = deduplicateByName(all);
      cachedResult = deduped;
      cacheTimestamp = Date.now();
      inflightFetch = undefined;
      return deduped;
    })();

    return inflightFetch;
  };

  return {
    discover: async (
      options?: DiscoverAgentsOptions,
    ): Promise<readonly ExternalAgentDescriptor[]> => {
      const all = await fetchAll();
      const filter = options?.filter;
      if (filter === undefined) return all;

      return all.filter((d) => {
        if (filter.capability !== undefined && !d.capabilities.includes(filter.capability)) {
          return false;
        }
        if (filter.transport !== undefined && d.transport !== filter.transport) {
          return false;
        }
        if (filter.source !== undefined && d.source !== filter.source) {
          return false;
        }
        return true;
      });
    },

    invalidate: (): void => {
      cachedResult = undefined;
      cacheTimestamp = 0;
      inflightFetch = undefined;
    },
  };
}
