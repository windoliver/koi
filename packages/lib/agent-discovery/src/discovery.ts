import type { ExternalAgentDescriptor } from "@koi/core";
import type { DiscoveryFilter, DiscoveryHandle, DiscoverySource } from "./types.js";

interface CacheState {
  readonly value: readonly ExternalAgentDescriptor[];
  readonly expiresAt: number;
}

export function createDiscovery(
  sources: readonly DiscoverySource[],
  cacheTtlMs: number,
): DiscoveryHandle {
  let cache: CacheState | null = null;
  let inflight: Promise<readonly ExternalAgentDescriptor[]> | null = null;

  function dedupByName(
    descriptors: readonly ExternalAgentDescriptor[],
  ): readonly ExternalAgentDescriptor[] {
    const byName = new Map<string, { d: ExternalAgentDescriptor; pri: number }>();
    for (const d of descriptors) {
      const sourcePri = sources.find((s) => s.id === d.source)?.priority ?? 99;
      const existing = byName.get(d.name);
      if (!existing || sourcePri < existing.pri) {
        byName.set(d.name, { d, pri: sourcePri });
      }
    }
    return [...byName.values()].map((v) => v.d);
  }

  async function fetchAll(): Promise<readonly ExternalAgentDescriptor[]> {
    const settled = await Promise.allSettled(sources.map((s) => s.discover()));
    const flat: ExternalAgentDescriptor[] = [];
    for (const r of settled) {
      if (r.status === "fulfilled") flat.push(...r.value);
    }
    return dedupByName(flat);
  }

  function applyFilter(
    arr: readonly ExternalAgentDescriptor[],
    f?: DiscoveryFilter,
  ): readonly ExternalAgentDescriptor[] {
    if (!f) return arr;
    return arr.filter((d) => {
      if (f.transport !== undefined && d.transport !== f.transport) return false;
      if (f.source !== undefined && d.source !== f.source) return false;
      if (f.capability !== undefined && !d.capabilities.includes(f.capability)) return false;
      return true;
    });
  }

  return {
    async discover(opts) {
      if (cache !== null && cache.expiresAt > Date.now()) {
        return applyFilter(cache.value, opts?.filter);
      }
      if (inflight !== null) {
        const value = await inflight;
        return applyFilter(value, opts?.filter);
      }
      inflight = fetchAll();
      try {
        const value = await inflight;
        cache = { value, expiresAt: Date.now() + cacheTtlMs };
        return applyFilter(value, opts?.filter);
      } finally {
        inflight = null;
      }
    },
    invalidate() {
      cache = null;
    },
  };
}
