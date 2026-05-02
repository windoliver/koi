/**
 * Local TTL cache for MCP registry queries.
 *
 * Stored as a single JSON file (default: `~/.koi/cache/mcp-registry.json`,
 * override via `KOI_CACHE_DIR`). Aligns with the official registry's
 * aggregator guidance: poll on a regular but infrequent basis and persist
 * locally.
 *
 * Corrupt cache files are silently dropped — opportunistic by design,
 * never throws on a bad cache.
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RegistryServer } from "./schema.js";

export const DEFAULT_REGISTRY_CACHE_TTL_MS: number = 60 * 60 * 1000; // 1 hour
const CACHE_FILENAME = "mcp-registry.json";

export interface CachedSearchResult {
  readonly servers: readonly RegistryServer[];
  readonly nextCursor: string | undefined;
}

export interface RegistryCache {
  readonly getSearch: (query: string) => Promise<CachedSearchResult | undefined>;
  readonly putSearch: (query: string, value: CachedSearchResult) => Promise<void>;
  readonly getServer: (name: string, version?: string) => Promise<RegistryServer | undefined>;
  readonly putServer: (name: string, detail: RegistryServer, version?: string) => Promise<void>;
  readonly clear: () => Promise<void>;
}

export interface RegistryCacheOptions {
  readonly dir?: string;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

interface CacheEntry<T> {
  readonly storedAt: number;
  readonly value: T;
}

interface CacheFile {
  readonly searches: Record<string, CacheEntry<CachedSearchResult>>;
  readonly servers: Record<string, CacheEntry<RegistryServer>>;
}

const EMPTY_FILE: CacheFile = { searches: {}, servers: {} };

export function defaultRegistryCacheDir(): string {
  const override = process.env.KOI_CACHE_DIR;
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), ".koi", "cache");
}

export function createRegistryCache(options: RegistryCacheOptions = {}): RegistryCache {
  const dir = options.dir ?? defaultRegistryCacheDir();
  const ttlMs = options.ttlMs ?? DEFAULT_REGISTRY_CACHE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const path = join(dir, CACHE_FILENAME);

  async function read(): Promise<CacheFile> {
    try {
      const text = await Bun.file(path).text();
      const parsed = JSON.parse(text) as unknown;
      if (!isCacheFile(parsed)) return { searches: {}, servers: {} };
      return parsed;
    } catch {
      return { searches: {}, servers: {} };
    }
  }

  async function write(file: CacheFile): Promise<void> {
    // Best effort: cache write failures must not break the CLI, but they
    // *are* observable — silently failing every write makes the offline
    // path appear functional when it is not. Surface a one-line warning
    // to stderr (suppressible via KOI_CACHE_QUIET=1) so operators can
    // diagnose a broken cache directory.
    try {
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, JSON.stringify(file));
    } catch (error: unknown) {
      if (process.env.KOI_CACHE_QUIET !== "1") {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[koi] warning: registry cache write failed (${detail})\n`);
      }
    }
  }

  function isFresh(entry: CacheEntry<unknown>): boolean {
    return now() - entry.storedAt < ttlMs;
  }

  function serverKey(name: string, version: string): string {
    return `${name}@${version}`;
  }

  return {
    async getSearch(query) {
      const file = await read();
      const entry = file.searches[query];
      if (entry === undefined || !isFresh(entry)) return undefined;
      return entry.value;
    },
    async putSearch(query, value) {
      const file = await read();
      const next: CacheFile = {
        searches: { ...file.searches, [query]: { storedAt: now(), value } },
        servers: file.servers,
      };
      await write(next);
    },
    async getServer(name, version = "latest") {
      const file = await read();
      const entry = file.servers[serverKey(name, version)];
      if (entry === undefined || !isFresh(entry)) return undefined;
      return entry.value;
    },
    async putServer(name, detail, version = "latest") {
      const file = await read();
      const next: CacheFile = {
        searches: file.searches,
        servers: {
          ...file.servers,
          [serverKey(name, version)]: { storedAt: now(), value: detail },
        },
      };
      await write(next);
    },
    async clear() {
      await write(EMPTY_FILE);
    },
  };
}

function isCacheFile(value: unknown): value is CacheFile {
  return (
    value !== null &&
    typeof value === "object" &&
    "searches" in value &&
    "servers" in value &&
    typeof (value as { searches: unknown }).searches === "object" &&
    typeof (value as { servers: unknown }).servers === "object"
  );
}
