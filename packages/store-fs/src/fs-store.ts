/**
 * Filesystem-backed ForgeStore implementation.
 *
 * Hybrid architecture:
 * - In-memory metadata index (BrickArtifactBase) for fast search/exists
 * - On-demand disk reads for load/search results (full BrickArtifact)
 * - Atomic write-temp-rename for crash safety
 * - Git-style hash-sharded directory layout
 */

import { mkdir, readdir, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrickArtifact,
  BrickArtifactBase,
  BrickUpdate,
  ForgeQuery,
  ForgeStore,
  KoiError,
  Result,
} from "@koi/core";
import { notFound } from "@koi/core";
import { validateBrickArtifact } from "@koi/validation";
import { mapFsError, mapParseError } from "./errors.js";
import { brickPath, shardDir, tmpPath } from "./paths.js";
import { matchesQuery } from "./query.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface FsForgeStoreConfig {
  /** Root directory for brick storage. Created if it does not exist. */
  readonly baseDir: string;
  /** Delete orphaned .tmp files on startup. Default: true. */
  readonly cleanOrphanedTmp?: boolean;
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
    createdBy: brick.createdBy,
    createdAt: brick.createdAt,
    version: brick.version,
    tags: brick.tags,
    usageCount: brick.usageCount,
    contentHash: brick.contentHash,
    // Include requires (small, useful for resolver filtering) but NOT files (large, on-demand only)
    ...(brick.requires !== undefined ? { requires: brick.requires } : {}),
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

/** Scan all .json files under baseDir and build the metadata index. */
async function scanAndBuildIndex(
  baseDir: string,
  cleanTmp: boolean,
): Promise<Map<string, BrickArtifactBase>> {
  const index = new Map<string, BrickArtifactBase>();

  // List shard directories
  let shardDirs: string[];
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    shardDirs = entries.filter((e) => e.isDirectory()).map((e) => join(baseDir, e.name));
  } catch {
    // Empty or missing directory — return empty index
    return index;
  }

  // Process each shard directory in parallel
  const shardPromises = shardDirs.map(async (dir) => {
    const files = await readdir(dir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp")).map((f) => join(dir, f));
    const jsonFiles = files.filter((f) => f.endsWith(".json")).map((f) => join(dir, f));

    // Clean orphaned .tmp files
    if (cleanTmp) {
      await Promise.all(tmpFiles.map((f) => unlink(f).catch(() => undefined)));
    }

    // Load and validate .json files in parallel, skip corrupted
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
export async function createFsForgeStore(config: FsForgeStoreConfig): Promise<ForgeStore> {
  const { baseDir, cleanOrphanedTmp = true } = config;

  // Ensure base directory exists
  await ensureDir(baseDir);

  // Build metadata index from existing files
  const index = await scanAndBuildIndex(baseDir, cleanOrphanedTmp);

  // -- ForgeStore methods ---------------------------------------------------

  const save = async (brick: BrickArtifact): Promise<Result<void, KoiError>> => {
    const shard = shardDir(baseDir, brick.id);
    const final = brickPath(baseDir, brick.id);
    const temp = tmpPath(baseDir, brick.id);

    try {
      await ensureDir(shard);
      const json = JSON.stringify(brick, null, 2);
      await atomicWrite(final, temp, json);
      index.set(brick.id, extractMetadata(brick));
      return { ok: true, value: undefined };
    } catch (err: unknown) {
      return { ok: false, error: mapFsError(err, final) };
    }
  };

  const load = async (id: string): Promise<Result<BrickArtifact, KoiError>> => {
    if (!index.has(id)) {
      return { ok: false, error: notFound(id, `Brick not found: ${id}`) };
    }
    const filePath = brickPath(baseDir, id);
    return readBrick(filePath);
  };

  const search = async (query: ForgeQuery): Promise<Result<readonly BrickArtifact[], KoiError>> => {
    // Filter metadata index in memory
    const matchingIds: string[] = [];
    for (const [id, meta] of index) {
      if (matchesQuery(meta, query)) {
        matchingIds.push(id);
        if (query.limit !== undefined && matchingIds.length >= query.limit) {
          break;
        }
      }
    }

    // Batch-load matching bricks from disk
    const loadResults = await Promise.all(
      matchingIds.map(async (id) => ({ id, result: await readBrick(brickPath(baseDir, id)) })),
    );

    // Collect successful loads; self-heal index for corrupted entries
    const bricks = loadResults
      .filter(({ id, result }) => {
        if (!result.ok) {
          index.delete(id);
          return false;
        }
        return true;
      })
      .map(({ result }) => (result as { ok: true; value: BrickArtifact }).value);

    return { ok: true, value: bricks };
  };

  const remove = async (id: string): Promise<Result<void, KoiError>> => {
    if (!index.has(id)) {
      return { ok: false, error: notFound(id, `Brick not found: ${id}`) };
    }
    const filePath = brickPath(baseDir, id);
    try {
      await rm(filePath);
      index.delete(id);
      return { ok: true, value: undefined };
    } catch (err: unknown) {
      return { ok: false, error: mapFsError(err, filePath) };
    }
  };

  const update = async (id: string, updates: BrickUpdate): Promise<Result<void, KoiError>> => {
    if (!index.has(id)) {
      return { ok: false, error: notFound(id, `Brick not found: ${id}`) };
    }
    // Read full artifact from disk
    const filePath = brickPath(baseDir, id);
    const readResult = await readBrick(filePath);
    if (!readResult.ok) {
      return readResult;
    }

    // Merge updates immutably
    const existing = readResult.value;
    const updated: BrickArtifact = {
      ...existing,
      ...(updates.lifecycle !== undefined ? { lifecycle: updates.lifecycle } : {}),
      ...(updates.trustTier !== undefined ? { trustTier: updates.trustTier } : {}),
      ...(updates.scope !== undefined ? { scope: updates.scope } : {}),
      ...(updates.usageCount !== undefined ? { usageCount: updates.usageCount } : {}),
    };

    // Atomic write back
    const temp = tmpPath(baseDir, id);
    try {
      const json = JSON.stringify(updated, null, 2);
      await atomicWrite(filePath, temp, json);
      index.set(id, extractMetadata(updated));
      return { ok: true, value: undefined };
    } catch (err: unknown) {
      return { ok: false, error: mapFsError(err, filePath) };
    }
  };

  const exists = async (id: string): Promise<Result<boolean, KoiError>> => {
    return { ok: true, value: index.has(id) };
  };

  return { save, load, search, remove, update, exists };
}
