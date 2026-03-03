/**
 * Filesystem-backed ForgeStore implementation.
 *
 * Hybrid architecture:
 * - In-memory metadata index (BrickArtifactBase) for fast search/exists
 * - On-demand disk reads for load/search results (full BrickArtifact)
 * - Atomic write-temp-rename for crash safety
 * - Git-style hash-sharded directory layout
 */

import { type FSWatcher, watch as fsWatch } from "node:fs";
import { mkdir, readdir, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrickArtifact,
  BrickArtifactBase,
  BrickId,
  BrickUpdate,
  ForgeQuery,
  ForgeStore,
  KoiError,
  Result,
  StoreChangeEvent,
} from "@koi/core";
import { notFound } from "@koi/core";
import {
  applyBrickUpdate,
  createMemoryStoreChangeNotifier,
  sortBricks,
  validateBrickArtifact,
} from "@koi/validation";
import { mapFsError, mapParseError } from "./errors.js";
import { brickPath, shardDir, tmpPath } from "./paths.js";
import { matchesBrickQuery } from "./query.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WATCHER_DEBOUNCE_MS = 100;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface FsForgeStoreConfig {
  /** Root directory for brick storage. Created if it does not exist. */
  readonly baseDir: string;
  /** Delete orphaned .tmp files on startup. Default: true. */
  readonly cleanOrphanedTmp?: boolean;
  /** Watch the store directory for external changes (cross-process notification). Default: false. */
  readonly watch?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract metadata (BrickArtifactBase fields) from a full artifact. */
function extractMetadata(brick: BrickArtifact): BrickArtifactBase {
  return {
    id: brick.id,
    kind: brick.kind,
    name: brick.name,
    description: brick.description,
    scope: brick.scope,
    trustTier: brick.trustTier,
    lifecycle: brick.lifecycle,
    provenance: brick.provenance,
    version: brick.version,
    tags: brick.tags,
    usageCount: brick.usageCount,
    // Include requires (small, useful for resolver filtering) but NOT files (large, on-demand only)
    ...(brick.requires !== undefined ? { requires: brick.requires } : {}),
    ...(brick.fitness !== undefined ? { fitness: brick.fitness } : {}),
    ...(brick.trailStrength !== undefined ? { trailStrength: brick.trailStrength } : {}),
    ...(brick.lastVerifiedAt !== undefined ? { lastVerifiedAt: brick.lastVerifiedAt } : {}),
    ...(brick.lastPromotedAt !== undefined ? { lastPromotedAt: brick.lastPromotedAt } : {}),
    ...(brick.lastDemotedAt !== undefined ? { lastDemotedAt: brick.lastDemotedAt } : {}),
  };
}

/** Read and validate a brick JSON file from disk. */
async function readBrick(filePath: string): Promise<Result<BrickArtifact, KoiError>> {
  try {
    const file = Bun.file(filePath);
    const text = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (parseErr: unknown) {
      return { ok: false, error: mapParseError(parseErr, filePath) };
    }
    return validateBrickArtifact(parsed, filePath);
  } catch (err: unknown) {
    return { ok: false, error: mapFsError(err, filePath) };
  }
}

/** Atomic write: write to .tmp, then rename to final path. */
async function atomicWrite(finalPath: string, tempPath: string, content: string): Promise<void> {
  await Bun.write(tempPath, content);
  await rename(tempPath, finalPath);
}

/** Ensure a directory exists (mkdir -p). */
async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

/** Compute per-brick diff events between two metadata indexes. */
function computeIndexDiff(
  prev: ReadonlyMap<BrickId, BrickArtifactBase>,
  next: ReadonlyMap<BrickId, BrickArtifactBase>,
): readonly StoreChangeEvent[] {
  const events: StoreChangeEvent[] = [];

  // Detect additions and updates
  for (const [id, meta] of next) {
    const prevMeta = prev.get(id);
    if (prevMeta === undefined) {
      events.push({ kind: "saved", brickId: id });
    } else if (
      prevMeta.lifecycle !== meta.lifecycle ||
      prevMeta.trustTier !== meta.trustTier ||
      prevMeta.scope !== meta.scope ||
      prevMeta.usageCount !== meta.usageCount ||
      prevMeta.trailStrength !== meta.trailStrength ||
      prevMeta.fitness?.lastUsedAt !== meta.fitness?.lastUsedAt
    ) {
      events.push({ kind: "updated", brickId: id });
    }
  }

  // Detect removals
  for (const id of prev.keys()) {
    if (!next.has(id)) {
      events.push({ kind: "removed", brickId: id });
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Lazy index — scan file names only, load metadata on demand
// ---------------------------------------------------------------------------

const METADATA_CACHE_MAX = 5000;

/**
 * Scan shard directories for .json file names only (no content reads).
 * Returns a set of file paths for deferred metadata loading.
 * Optionally cleans orphaned .tmp files.
 */
async function scanFileNames(baseDir: string, cleanTmp: boolean): Promise<Set<string>> {
  const filePaths = new Set<string>();

  // List shard directories
  // let justified: mutable array from readdir
  let shardDirs: string[];
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    shardDirs = entries.filter((e) => e.isDirectory()).map((e) => join(baseDir, e.name));
  } catch {
    return filePaths;
  }

  // Process each shard directory in parallel (names only, no content)
  const shardPromises = shardDirs.map(async (dir) => {
    const files = await readdir(dir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp")).map((f) => join(dir, f));
    const jsonFiles = files.filter((f) => f.endsWith(".json")).map((f) => join(dir, f));

    if (cleanTmp) {
      await Promise.all(tmpFiles.map((f) => unlink(f).catch(() => undefined)));
    }

    return jsonFiles;
  });

  const results = await Promise.all(shardPromises);
  for (const jsonFiles of results) {
    for (const f of jsonFiles) {
      filePaths.add(f);
    }
  }
  return filePaths;
}

/**
 * Legacy full scan — still used for rescan where diff detection needs metadata.
 * Reads all files and builds a full metadata index.
 */
async function scanAndBuildIndex(
  baseDir: string,
  cleanTmp: boolean,
): Promise<Map<BrickId, BrickArtifactBase>> {
  const index = new Map<BrickId, BrickArtifactBase>();

  // List shard directories
  // let justified: mutable array from readdir
  let shardDirs: string[];
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    shardDirs = entries.filter((e) => e.isDirectory()).map((e) => join(baseDir, e.name));
  } catch {
    return index;
  }

  const shardPromises = shardDirs.map(async (dir) => {
    const files = await readdir(dir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp")).map((f) => join(dir, f));
    const jsonFiles = files.filter((f) => f.endsWith(".json")).map((f) => join(dir, f));

    if (cleanTmp) {
      await Promise.all(tmpFiles.map((f) => unlink(f).catch(() => undefined)));
    }

    const loadResults = await Promise.all(jsonFiles.map((filePath) => readBrick(filePath)));
    return loadResults
      .filter((r): r is { ok: true; value: BrickArtifact } => r.ok)
      .map((r) => ({ id: r.value.id, meta: extractMetadata(r.value) }));
  });

  const shardResults = await Promise.all(shardPromises);
  for (const results of shardResults) {
    for (const { id, meta } of results) {
      index.set(id, meta);
    }
  }

  return index;
}

/** Extract a BrickId from a file name (e.g., "/base/ab/abc-123.json" → "abc-123"). */
function fileNameToBrickId(filePath: string): BrickId {
  const base = filePath.split("/").pop() ?? filePath;
  return base.replace(/\.json$/, "") as BrickId;
}

// ---------------------------------------------------------------------------
// Extended interface (internal — used by overlay store for two-phase search)
// ---------------------------------------------------------------------------

/**
 * Extended ForgeStore with metadata-only search for efficient overlay composition.
 * Returned by `createFsForgeStore`; callers needing only `ForgeStore` can ignore it.
 */
export interface FsForgeStoreExtended extends ForgeStore {
  /** Search the in-memory index without loading full artifacts from disk. */
  readonly searchIndex: (query: ForgeQuery) => readonly BrickArtifactBase[];
  /** Load a single brick from disk by ID (bypasses index check). */
  readonly loadFromDisk: (id: BrickId) => Promise<Result<BrickArtifact, KoiError>>;
  /** Ensure all known bricks have their metadata cached (lazy load trigger). */
  readonly ensureAllMetadata: () => Promise<void>;
  /** Clean up filesystem watcher, timers, and listeners. */
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a filesystem-backed ForgeStore.
 *
 * Scans the base directory on construction to build the in-memory metadata index.
 * Uses atomic write-temp-rename for crash safety and git-style hash sharding
 * for directory scalability.
 */
export async function createFsForgeStore(
  config: FsForgeStoreConfig,
): Promise<FsForgeStoreExtended> {
  const { baseDir, cleanOrphanedTmp = true } = config;

  // Ensure base directory exists
  await ensureDir(baseDir);

  // Lazy startup: scan file names only (no content reads)
  const knownFiles = await scanFileNames(baseDir, cleanOrphanedTmp);
  // Map/Set — mutable set of known BrickIds derived from file names
  const knownIds = new Set<BrickId>();
  for (const f of knownFiles) {
    knownIds.add(fileNameToBrickId(f));
  }

  // Map/Set — mutable LRU metadata cache, populated on demand
  const metadataCache = new Map<BrickId, BrickArtifactBase>();

  /** Load and cache metadata for a brick (on-demand). */
  async function ensureMetadata(id: BrickId): Promise<BrickArtifactBase | undefined> {
    const cached = metadataCache.get(id);
    if (cached !== undefined) return cached;
    if (!knownIds.has(id)) return undefined;

    const result = await readBrick(brickPath(baseDir, id));
    if (!result.ok) {
      knownIds.delete(id); // Self-heal: remove broken entries
      return undefined;
    }
    const meta = extractMetadata(result.value);
    // LRU eviction for metadata cache
    metadataCache.delete(id); // Ensure fresh insertion at end
    metadataCache.set(id, meta);
    while (metadataCache.size > METADATA_CACHE_MAX) {
      const oldest = metadataCache.keys().next().value;
      if (oldest !== undefined) metadataCache.delete(oldest);
    }
    return meta;
  }

  // --- watch notification (delegated to shared notifier) -------------------
  const notifier = createMemoryStoreChangeNotifier();

  // --- Filesystem watcher (opt-in) ------------------------------------------
  // let justified: mutable watcher handle for cleanup
  let fsWatcher: FSWatcher | undefined;
  // let justified: mutable timer for watcher debounce
  let watcherTimer: ReturnType<typeof setTimeout> | undefined;

  if (config.watch === true) {
    fsWatcher = fsWatch(baseDir, { recursive: true }, () => {
      if (watcherTimer !== undefined) clearTimeout(watcherTimer);
      watcherTimer = setTimeout(() => {
        watcherTimer = undefined;
        void rescanDisk();
      }, WATCHER_DEBOUNCE_MS);
    });
    fsWatcher.on("error", () => {
      /* watcher errors are non-fatal */
    });
  }

  async function rescanDisk(): Promise<void> {
    try {
      const snapshot = new Map(metadataCache); // shallow copy for comparison
      const fresh = await scanAndBuildIndex(baseDir, false); // don't clean .tmp on rescan
      const events = computeIndexDiff(snapshot, fresh);
      if (events.length > 0) {
        // Rebuild knownIds from fresh scan
        knownIds.clear();
        metadataCache.clear();
        for (const [k, v] of fresh) {
          knownIds.add(k);
          metadataCache.set(k, v);
        }
        for (const event of events) {
          notifier.notify(event);
        }
      }
    } catch (_err: unknown) {
      // Rescan failure is non-fatal — index stays stale until next event
    }
  }

  // --- Dispose ---------------------------------------------------------------

  const dispose = (): void => {
    if (fsWatcher !== undefined) {
      fsWatcher.close();
      fsWatcher = undefined;
    }
    if (watcherTimer !== undefined) {
      clearTimeout(watcherTimer);
      watcherTimer = undefined;
    }
  };

  // -- ForgeStore methods ---------------------------------------------------

  const save = async (brick: BrickArtifact): Promise<Result<void, KoiError>> => {
    const shard = shardDir(baseDir, brick.id);
    const final = brickPath(baseDir, brick.id);
    const temp = tmpPath(baseDir, brick.id);

    try {
      await ensureDir(shard);
      const json = JSON.stringify(brick, null, 2);
      await atomicWrite(final, temp, json);
      knownIds.add(brick.id);
      metadataCache.set(brick.id, extractMetadata(brick));
      notifier.notify({ kind: "saved", brickId: brick.id });
      return { ok: true, value: undefined };
    } catch (err: unknown) {
      return { ok: false, error: mapFsError(err, final) };
    }
  };

  const load = async (id: BrickId): Promise<Result<BrickArtifact, KoiError>> => {
    if (!knownIds.has(id)) {
      return { ok: false, error: notFound(id, `Brick not found: ${id}`) };
    }
    const filePath = brickPath(baseDir, id);
    return readBrick(filePath);
  };

  const search = async (query: ForgeQuery): Promise<Result<readonly BrickArtifact[], KoiError>> => {
    // Ensure metadata is loaded for all known IDs (lazy population)
    await Promise.all([...knownIds].map((id) => ensureMetadata(id)));

    // Filter metadata index in memory (no limit here — apply after sort)
    const matchingIds: BrickId[] = [];
    for (const [id, meta] of metadataCache) {
      if (matchesBrickQuery(meta, query)) {
        matchingIds.push(id);
      }
    }

    // Batch-load matching bricks from disk
    const loadResults = await Promise.all(
      matchingIds.map(async (id) => ({ id, result: await readBrick(brickPath(baseDir, id)) })),
    );

    // Collect successful loads; self-heal for corrupted entries
    const loaded = loadResults
      .filter(({ id, result }) => {
        if (!result.ok) {
          knownIds.delete(id);
          metadataCache.delete(id);
          return false;
        }
        return true;
      })
      .map(({ result }) => (result as { ok: true; value: BrickArtifact }).value);

    // Sort + minFitnessScore filter, then apply limit
    const sorted = sortBricks(loaded, query, { nowMs: Date.now() });
    return { ok: true, value: query.limit !== undefined ? sorted.slice(0, query.limit) : sorted };
  };

  const remove = async (id: BrickId): Promise<Result<void, KoiError>> => {
    if (!knownIds.has(id)) {
      return { ok: false, error: notFound(id, `Brick not found: ${id}`) };
    }
    const filePath = brickPath(baseDir, id);
    try {
      await rm(filePath);
      knownIds.delete(id);
      metadataCache.delete(id);
      notifier.notify({ kind: "removed", brickId: id });
      return { ok: true, value: undefined };
    } catch (err: unknown) {
      return { ok: false, error: mapFsError(err, filePath) };
    }
  };

  const update = async (id: BrickId, updates: BrickUpdate): Promise<Result<void, KoiError>> => {
    if (!knownIds.has(id)) {
      return { ok: false, error: notFound(id, `Brick not found: ${id}`) };
    }
    // Read full artifact from disk
    const filePath = brickPath(baseDir, id);
    const readResult = await readBrick(filePath);
    if (!readResult.ok) {
      return readResult;
    }

    // Merge updates immutably
    const updated = applyBrickUpdate(readResult.value, updates);

    // Atomic write back
    const temp = tmpPath(baseDir, id);
    try {
      const json = JSON.stringify(updated, null, 2);
      await atomicWrite(filePath, temp, json);
      metadataCache.set(id, extractMetadata(updated));
      notifier.notify({ kind: "updated", brickId: id });
      return { ok: true, value: undefined };
    } catch (err: unknown) {
      return { ok: false, error: mapFsError(err, filePath) };
    }
  };

  const exists = async (id: BrickId): Promise<Result<boolean, KoiError>> => {
    return { ok: true, value: knownIds.has(id) };
  };

  // -- Extended methods (internal, used by overlay for two-phase search) -----

  /** Search the in-memory metadata cache without touching disk. */
  const searchIndex = (query: ForgeQuery): readonly BrickArtifactBase[] => {
    const results: BrickArtifactBase[] = [];
    for (const [, meta] of metadataCache) {
      if (matchesBrickQuery(meta, query)) {
        results.push(meta);
        if (query.limit !== undefined && results.length >= query.limit) {
          break;
        }
      }
    }
    return results;
  };

  /** Load a single brick from disk by ID (bypasses index check for overlay use). */
  const loadFromDisk = async (id: BrickId): Promise<Result<BrickArtifact, KoiError>> => {
    return readBrick(brickPath(baseDir, id));
  };

  /** Ensure all known bricks have their metadata cached. */
  const ensureAllMetadata = async (): Promise<void> => {
    await Promise.all([...knownIds].map((id) => ensureMetadata(id)));
  };

  return {
    save,
    load,
    search,
    remove,
    update,
    exists,
    watch: notifier.subscribe,
    searchIndex,
    loadFromDisk,
    ensureAllMetadata,
    dispose,
  };
}
