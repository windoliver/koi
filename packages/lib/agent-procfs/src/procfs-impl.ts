import type { ProcEntry, ProcFs, WritableProcEntry } from "@koi/core";

export interface ProcFsConfig {
  readonly cacheTtlMs?: number;
}

interface CacheEntry {
  readonly value: unknown;
  readonly expiresAt: number;
}

const DEFAULT_TTL_MS = 1_000;

function isWritable(e: ProcEntry | WritableProcEntry): e is WritableProcEntry {
  return "write" in e && typeof e.write === "function";
}

export function createProcFs(config: ProcFsConfig = {}): ProcFs {
  const ttl = config.cacheTtlMs ?? DEFAULT_TTL_MS;
  const entryMap = new Map<string, ProcEntry | WritableProcEntry>();
  const cache = new Map<string, CacheEntry>();

  function invalidate(path: string): void {
    cache.delete(path);
  }

  return {
    mount(path, entry) {
      entryMap.set(path, entry);
      invalidate(path);
    },
    unmount(path) {
      entryMap.delete(path);
      invalidate(path);
    },
    async read(path) {
      const entry = entryMap.get(path);
      if (!entry) {
        throw new Error(`NOT_FOUND: no entry mounted at ${path}`);
      }
      if (ttl > 0) {
        const cached = cache.get(path);
        if (cached !== undefined && cached.expiresAt > Date.now()) {
          return cached.value;
        }
      }
      const value = await entry.read();
      if (ttl > 0) {
        cache.set(path, { value, expiresAt: Date.now() + ttl });
      }
      return value;
    },
    async write(path, value) {
      const entry = entryMap.get(path);
      if (!entry) {
        throw new Error(`NOT_FOUND: no entry mounted at ${path}`);
      }
      if (!isWritable(entry)) {
        throw new Error(`not writable: ${path} is a read-only entry`);
      }
      await entry.write(value);
      invalidate(path);
    },
    async list(path) {
      const entry = entryMap.get(path);
      if (entry?.list !== undefined) return await entry.list();
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const seen = new Set<string>();
      for (const key of entryMap.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const next = rest.split("/")[0];
          if (next) seen.add(next);
        }
      }
      return [...seen];
    },
    entries() {
      return [...entryMap.keys()];
    },
  };
}
