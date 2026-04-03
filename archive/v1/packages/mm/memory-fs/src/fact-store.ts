/**
 * Fact storage with pluggable persistence backend.
 *
 * Wraps a FactPersistenceBackend with:
 * - In-memory LRU cache (lazy load, write-through)
 * - Per-entity async write queue (prevents interleaving)
 *
 * Default backend: filesystem via createFsFactBackend().
 */
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FactPersistenceBackend, FactStore, FactUpdates, MemoryFact } from "./types.js";

function isMemoryFact(v: unknown): v is MemoryFact {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.fact === "string" &&
    typeof o.category === "string" &&
    typeof o.timestamp === "string" &&
    (o.status === "active" || o.status === "superseded") &&
    Array.isArray(o.relatedEntities) &&
    typeof o.lastAccessed === "string" &&
    typeof o.accessCount === "number"
  );
}

// ---------------------------------------------------------------------------
// Filesystem persistence backend (default)
// ---------------------------------------------------------------------------

/** Create a filesystem-backed persistence backend for memory facts. */
export function createFsFactBackend(baseDir: string): FactPersistenceBackend {
  const entitiesDir = join(baseDir, "entities");

  function entityDir(entity: string): string {
    return join(entitiesDir, entity);
  }

  function itemsPath(entity: string): string {
    return join(entityDir(entity), "items.json");
  }

  async function ensureDir(entity: string): Promise<void> {
    await mkdir(entityDir(entity), { recursive: true });
  }

  const readFacts = async (entity: string): Promise<readonly MemoryFact[]> => {
    try {
      const raw = await readFile(itemsPath(entity), "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const validated = (parsed as readonly unknown[]).filter(isMemoryFact);
      if (validated.length < parsed.length) {
        console.warn(
          `[memory-fs] Dropped ${parsed.length - validated.length} malformed facts for entity "${entity}"`,
        );
      }
      return validated;
    } catch (e: unknown) {
      if (e instanceof SyntaxError) {
        console.warn(`[memory-fs] Corrupted items.json for entity "${entity}", resetting`);
        return [];
      }
      if (typeof e === "object" && e !== null && "code" in e) {
        const code = (e as { readonly code: string }).code;
        if (code === "ENOENT") return [];
      }
      throw e;
    }
  };

  const writeFacts = async (entity: string, facts: readonly MemoryFact[]): Promise<void> => {
    await ensureDir(entity);
    const target = itemsPath(entity);
    const tmp = `${target}.${Date.now()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(facts, null, 2), "utf-8");
      await rename(tmp, target);
    } catch (e: unknown) {
      // Best-effort cleanup of orphaned temp file
      try {
        await unlink(tmp);
      } catch {
        // Temp file may not exist if writeFile failed
      }
      throw e;
    }
  };

  const listEntities = async (): Promise<readonly string[]> => {
    try {
      const entries = await readdir(entitiesDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (e: unknown) {
      if (typeof e === "object" && e !== null && "code" in e) {
        const code = (e as { readonly code: string }).code;
        if (code === "ENOENT") return [];
      }
      throw e;
    }
  };

  const close = async (): Promise<void> => {
    // No persistent resources to release for filesystem backend
  };

  return { readFacts, writeFacts, listEntities, close };
}

// ---------------------------------------------------------------------------
// FactStore with caching + write queue
// ---------------------------------------------------------------------------

const MAX_CACHE_ENTRIES = 100;

/**
 * Create a FactStore backed by a persistence backend.
 *
 * @param baseDirOrBackend - Either a directory path (uses FS backend) or a FactPersistenceBackend
 */
export function createFactStore(baseDirOrBackend: string | FactPersistenceBackend): FactStore {
  const backend: FactPersistenceBackend =
    typeof baseDirOrBackend === "string" ? createFsFactBackend(baseDirOrBackend) : baseDirOrBackend;

  // Map/Set — internal mutable LRU cache required for write-through I/O.
  // Map insertion order tracks recency; most-recent entries are re-inserted on access.
  const cache = new Map<string, readonly MemoryFact[]>();
  const queues = new Map<string, Promise<void>>();

  /** Touch an entry to mark it as recently used (move to end of Map). */
  function touchCache(entity: string, facts: readonly MemoryFact[]): void {
    cache.delete(entity);
    cache.set(entity, facts);
    // Evict oldest entries if over limit
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  function enqueue(entity: string, op: () => Promise<void>): Promise<void> {
    const prev = queues.get(entity) ?? Promise.resolve();
    const next = prev.then(op, op);
    queues.set(entity, next);
    return next;
  }

  const readFacts = async (entity: string): Promise<readonly MemoryFact[]> => {
    const cached = cache.get(entity);
    if (cached !== undefined) {
      touchCache(entity, cached); // Mark as recently used
      return cached;
    }
    const facts = await backend.readFacts(entity);
    touchCache(entity, facts);
    return facts;
  };

  const appendFact = (entity: string, fact: MemoryFact): Promise<void> =>
    enqueue(entity, async () => {
      const existing = await readFacts(entity);
      const updated = [...existing, fact];
      await backend.writeFacts(entity, updated);
      touchCache(entity, updated);
    });

  const updateFact = (entity: string, id: string, updates: FactUpdates): Promise<void> =>
    enqueue(entity, async () => {
      const existing = await readFacts(entity);
      const updated = existing.map((f) => (f.id === id ? { ...f, ...updates } : f));
      await backend.writeFacts(entity, updated);
      touchCache(entity, updated);
    });

  const listEntities = async (): Promise<readonly string[]> => {
    return backend.listEntities();
  };

  const close = async (): Promise<void> => {
    await Promise.all([...queues.values()]);
    cache.clear();
    queues.clear();
    await backend.close();
  };

  return { readFacts, appendFact, updateFact, listEntities, close };
}
