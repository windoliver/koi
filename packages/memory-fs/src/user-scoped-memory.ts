/**
 * Per-user memory isolation via LRU cache of FsMemory instances.
 *
 * Each userId gets a dedicated FactStore on disk at `<baseDir>/users/<slugifiedUserId>/`.
 * A shared FsMemory at `<baseDir>/` serves as the fallback when no userId is available.
 */
import { join } from "node:path";
import { createFsMemory } from "./fs-memory.js";
import { slugifyEntity } from "./slug.js";
import type { FsMemory, FsMemoryConfig } from "./types.js";

export interface UserScopedMemoryConfig {
  readonly baseDir: string;
  /** Maximum number of per-user FsMemory instances to cache. Default: 100. */
  readonly maxCachedUsers?: number | undefined;
  /** Config forwarded to each per-user FsMemory (baseDir is overridden per user). */
  readonly memoryConfig?: Partial<Omit<FsMemoryConfig, "baseDir">> | undefined;
}

export interface UserScopedMemory {
  /** Get or create an isolated FsMemory for a specific user. */
  readonly getOrCreate: (userId: string) => Promise<FsMemory>;
  /** Get the shared (non-user-scoped) FsMemory fallback. */
  readonly getShared: () => Promise<FsMemory>;
  /** Flush and close all cached FsMemory instances (including shared). */
  readonly closeAll: () => Promise<void>;
}

const DEFAULT_MAX_CACHED_USERS = 100;

export function createUserScopedMemory(config: UserScopedMemoryConfig): UserScopedMemory {
  const { baseDir, maxCachedUsers = DEFAULT_MAX_CACHED_USERS, memoryConfig = {} } = config;

  // Map — internal mutable cache required for LRU eviction tracking (insertion order = access order)
  const cache = new Map<string, FsMemory>();
  // let — lazy-initialized shared instance
  let shared: FsMemory | undefined;

  async function evictLru(): Promise<void> {
    if (cache.size <= maxCachedUsers) return;
    // Map iterator yields in insertion order; first entry = least recently used
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) return;
    const evicted = cache.get(firstKey);
    cache.delete(firstKey);
    if (evicted !== undefined) {
      await evicted.rebuildSummaries();
      await evicted.close();
    }
  }

  const getOrCreate = async (userId: string): Promise<FsMemory> => {
    const slug = slugifyEntity(userId);

    // LRU touch: delete + re-insert to move to end
    const existing = cache.get(slug);
    if (existing !== undefined) {
      cache.delete(slug);
      cache.set(slug, existing);
      return existing;
    }

    const userDir = join(baseDir, "users", slug);
    const mem = await createFsMemory({ ...memoryConfig, baseDir: userDir });
    cache.set(slug, mem);
    await evictLru();
    return mem;
  };

  const getShared = async (): Promise<FsMemory> => {
    if (shared !== undefined) return shared;
    shared = await createFsMemory({ ...memoryConfig, baseDir });
    return shared;
  };

  const closeAll = async (): Promise<void> => {
    const instances = [...cache.values()];
    cache.clear();
    for (const mem of instances) {
      await mem.rebuildSummaries();
      await mem.close();
    }
    if (shared !== undefined) {
      await shared.rebuildSummaries();
      await shared.close();
      shared = undefined;
    }
  };

  return { getOrCreate, getShared, closeAll };
}
