/**
 * LSP client pool — manages a pool of warm LSP clients keyed by server name.
 *
 * Provides idle timeout eviction to prevent resource leaks while keeping
 * frequently-used clients warm for fast diagnostics.
 */

import type { LspClient } from "./client.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface LspClientPoolConfig {
  /** Whether the pool is enabled. When false, acquire() always returns undefined. */
  readonly enabled: boolean;
  /** Maximum number of pooled clients. */
  readonly maxClients: number;
  /** Idle timeout in ms before a client is evicted. Default: 5 minutes. */
  readonly idleTimeoutMs: number;
}

export const DEFAULT_LSP_CLIENT_POOL_CONFIG: LspClientPoolConfig = {
  enabled: true,
  maxClients: 4,
  idleTimeoutMs: 5 * 60 * 1000, // 5 minutes
} as const;

// ---------------------------------------------------------------------------
// Pool entry
// ---------------------------------------------------------------------------

interface PoolEntry {
  readonly client: LspClient;
  readonly serverName: string;
  lastAccessedAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

// ---------------------------------------------------------------------------
// Pool interface
// ---------------------------------------------------------------------------

export interface LspClientPool {
  /** Acquire a pooled client by server name. Returns undefined if not pooled. */
  readonly acquire: (serverName: string) => LspClient | undefined;
  /** Return a client to the pool (with idle timeout). */
  readonly release: (serverName: string, client: LspClient) => void;
  /** Number of clients currently in the pool. */
  readonly size: () => number;
  /** Evict a specific client from the pool and close it. */
  readonly evict: (serverName: string) => Promise<void>;
  /** Dispose all pooled clients. */
  readonly dispose: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLspClientPool(config: LspClientPoolConfig): LspClientPool {
  const pool = new Map<string, PoolEntry>();

  const resetTimer = (entry: PoolEntry): void => {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
    }
    entry.timer = setTimeout(() => {
      void evict(entry.serverName);
    }, config.idleTimeoutMs);
  };

  const acquire = (serverName: string): LspClient | undefined => {
    if (!config.enabled) {
      return undefined;
    }
    const entry = pool.get(serverName);
    if (entry === undefined) {
      return undefined;
    }
    // Remove from pool on acquire (caller owns it now)
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    pool.delete(serverName);
    return entry.client;
  };

  const release = (serverName: string, client: LspClient): void => {
    if (!config.enabled) {
      void client.close();
      return;
    }
    // If pool is at capacity, evict the oldest entry
    if (pool.size >= config.maxClients) {
      let oldestName: string | undefined;
      let oldestTime = Infinity;
      for (const [name, entry] of pool) {
        if (entry.lastAccessedAt < oldestTime) {
          oldestTime = entry.lastAccessedAt;
          oldestName = name;
        }
      }
      if (oldestName !== undefined) {
        void evict(oldestName);
      }
    }

    const entry: PoolEntry = {
      client,
      serverName,
      lastAccessedAt: Date.now(),
      timer: undefined,
    };
    pool.set(serverName, entry);
    resetTimer(entry);
  };

  const size = (): number => pool.size;

  const evict = async (serverName: string): Promise<void> => {
    const entry = pool.get(serverName);
    if (entry === undefined) {
      return;
    }
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
    }
    pool.delete(serverName);
    await entry.client.close();
  };

  const dispose = async (): Promise<void> => {
    const entries = [...pool.values()];
    for (const entry of entries) {
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer);
      }
    }
    pool.clear();
    await Promise.all(entries.map((e) => e.client.close()));
  };

  return { acquire, release, size, evict, dispose };
}
