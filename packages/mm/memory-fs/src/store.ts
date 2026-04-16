/**
 * createMemoryStore — file-based memory store factory.
 *
 * Each memory record is a Markdown file with bespoke frontmatter.
 * A MEMORY.md index is rebuilt on every mutation (write/update/delete).
 *
 * Concurrency: the record-level state change for each mutation runs
 * inside a per-directory critical section (in-process async mutex +
 * `.memory.lock` file lock — see ./lock.ts). The post-mutation
 * `MEMORY.md` rebuild and the `onIndexError` callback run OUTSIDE the
 * lock so a slow rebuild or hanging callback cannot stall other writers.
 */

import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type {
  MemoryRecord,
  MemoryRecordId,
  MemoryRecordInput,
  MemoryRecordPatch,
} from "@koi/core/memory";
import {
  memoryRecordId,
  parseMemoryFrontmatter,
  sanitizeFrontmatterValue,
  serializeMemoryFrontmatter,
  validateMemoryRecordInput,
} from "@koi/core/memory";
import { findDuplicate } from "./dedup.js";
import { rebuildIndex } from "./index-file.js";
import { withDirLock } from "./lock.js";
import { deriveFilename, slugifyMemoryName } from "./slug.js";
import type {
  DedupResult,
  DeleteResult,
  IndexErrorCallback,
  MemoryListFilter,
  MemoryStore,
  MemoryStoreConfig,
  MemoryStoreOperation,
  UpdateResult,
  UpsertResult,
} from "./types.js";
import { DEFAULT_DEDUP_THRESHOLD } from "./types.js";

const INDEX_FILENAME = "MEMORY.md";

interface StoreContext {
  /** Caller-provided directory (used for creation before realpath exists). */
  readonly dir: string;
  /** Canonical path — stable key for the per-dir mutex. */
  readonly canonicalDir: string;
  readonly threshold: number;
  readonly onIndexError: IndexErrorCallback | undefined;
}

/**
 * Create a file-based memory store.
 *
 * Records are stored as `.md` files in `config.dir`.
 * MEMORY.md is rebuilt after every mutation.
 */
export function createMemoryStore(config: MemoryStoreConfig): MemoryStore {
  const { dir } = config;
  const threshold = config.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD;

  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`dedupThreshold must be between 0 and 1, got ${String(threshold)}`);
  }

  // Resolve the canonical path lazily on first mutation — the directory
  // may not exist yet at construction time. Cache the result for stable
  // mutex keying across calls.
  // let — cached after first successful resolve.
  let canonical: string | undefined;
  const getContext = async (): Promise<StoreContext> => {
    if (canonical === undefined) {
      await mkdir(dir, { recursive: true });
      canonical = await realpath(dir);
    }
    return {
      dir,
      canonicalDir: canonical,
      threshold,
      onIndexError: config.onIndexError,
    };
  };

  const chainedRebuild = (ctx: StoreContext, operation: MemoryStoreOperation): Promise<unknown> =>
    enqueueRebuild(ctx, operation);

  return {
    read: (id) => readRecord(dir, id),
    list: (filter) => listRecords(dir, filter),
    write: async (input) => {
      // Validate BEFORE any filesystem side effect (mkdir/realpath in
      // getContext). Invalid input must never create directories on disk.
      const errors = validateMemoryRecordInput({ ...input });
      if (errors.length > 0) {
        const messages = errors.map((e) => `${e.field}: ${e.message}`).join("; ");
        throw new Error(`Invalid memory record input: ${messages}`);
      }
      const ctx = await getContext();
      const res = await withDirLock(ctx.canonicalDir, () => writeRecord(ctx, input));
      if (res.action !== "created") return res;
      const indexError = await chainedRebuild(ctx, "write");
      return indexError === undefined ? res : { ...res, indexError };
    },
    update: async (id, patch) => {
      const ctx = await getContext();
      const res = await withDirLock(ctx.canonicalDir, () => updateRecord(ctx, id, patch));
      const indexError = await chainedRebuild(ctx, "update");
      return indexError === undefined ? res : { ...res, indexError };
    },
    delete: async (id) => {
      const ctx = await getContext();
      const res = await withDirLock(ctx.canonicalDir, () => deleteRecord(ctx, id));
      if (!res.deleted) return res;
      const indexError = await chainedRebuild(ctx, "delete");
      return indexError === undefined ? res : { ...res, indexError };
    },
    rebuildIndex: async () => {
      const ctx = await getContext();
      // Explicit repair takes both locks: mutation lock for a consistent
      // snapshot, rebuild chain to preserve ordering vs background rebuilds.
      await withDirLock(ctx.canonicalDir, async () => {
        const records = await scanRecords(ctx.dir);
        await rebuildIndex(ctx.dir, records);
      });
    },
    upsert: async (input, opts) => {
      const errors = validateMemoryRecordInput({ ...input });
      if (errors.length > 0) {
        const messages = errors.map((e) => `${e.field}: ${e.message}`).join("; ");
        throw new Error(`Invalid memory record input: ${messages}`);
      }
      // Untyped JS callers may pass `{ force: "false" }`, `{ force: 1 }`, or
      // omit `opts` entirely. Reject anything that is not a strict boolean
      // so the destructive force-update path cannot be entered by accident.
      if (
        opts === null ||
        typeof opts !== "object" ||
        typeof (opts as { force: unknown }).force !== "boolean"
      ) {
        throw new Error("Invalid upsert options: opts.force must be a boolean");
      }
      const ctx = await getContext();
      const res = await withDirLock(ctx.canonicalDir, () => upsertRecord(ctx, input, opts.force));
      // Index rebuild for any action that mutated disk (created or updated).
      if (res.action === "created" || res.action === "updated") {
        const indexError = await chainedRebuild(ctx, "upsert");
        return indexError === undefined ? res : { ...res, indexError };
      }
      return res;
    },
  };
}

// ---------------------------------------------------------------------------
// Internal operations — the record-level file work runs inside the lock,
// callers (the factory methods above) run the index rebuild outside.
// ---------------------------------------------------------------------------

async function readRecord(dir: string, id: MemoryRecordId): Promise<MemoryRecord | undefined> {
  const records = await scanRecords(dir);
  return records.find((r) => r.id === id);
}

async function writeRecord(ctx: StoreContext, input: MemoryRecordInput): Promise<DedupResult> {
  // Note: validation already ran in the public `write()` method before
  // getContext()/mkdir. This function is called inside the dir lock and
  // must not re-validate (the lock was acquired after validation passed).
  const { dir, threshold } = ctx;
  const existing = await scanRecords(dir);

  // Dedup scan + file creation are now both inside the dir lock, so two
  // writers cannot both observe "no duplicate" and both succeed. Run
  // this BEFORE the name+type uniqueness check so a replay of the same
  // content (same name, same content) resolves as a dedup-skip rather
  // than a spurious "already exists" error.
  const dup = findDuplicate(input.content, existing, threshold);
  if (dup !== undefined) {
    return {
      action: "skipped",
      record: dup.record,
      duplicateOf: dup.id,
      similarity: dup.similarity,
    };
  }

  // Enforce the same (canonical name, type) uniqueness invariant as
  // upsert() so callers cannot create the `corrupted` state through the
  // low-level write() path. Without this guard, two writes with
  // newline/control-char name variants (e.g. "foo bar" then "foo\nbar")
  // would slug-collision-rename into two files that both deserialize as
  // the same logical (name, type).
  const canonicalName = sanitizeFrontmatterValue(input.name);
  const nameTypeCollision = existing.find((r) => r.name === canonicalName && r.type === input.type);
  if (nameTypeCollision !== undefined) {
    throw new Error(
      `Memory record already exists with name=${JSON.stringify(canonicalName)}, ` +
        `type=${input.type} (id=${nameTypeCollision.id}). Use upsert({ force: true }) ` +
        `to overwrite or pick a different name.`,
    );
  }

  const serialized = serializeMemoryFrontmatter(
    { name: input.name, description: input.description, type: input.type },
    input.content,
  );
  if (serialized === undefined) {
    throw new Error("Failed to serialize memory record — invalid frontmatter or empty content");
  }

  // Exclusive create — retains `wx` for inode-level safety against a stray
  // file with the same slug that pre-existed the lock acquisition.
  const filename = await writeExclusive(dir, input.name, serialized);
  const fileStat = await stat(join(dir, filename));

  // Re-parse to return sanitized values matching what's on disk
  const persisted = parseMemoryFrontmatter(serialized);
  const record: MemoryRecord = {
    id: memoryRecordId(filenameToId(filename)),
    name: persisted?.frontmatter.name ?? input.name,
    description: persisted?.frontmatter.description ?? input.description,
    type: persisted?.frontmatter.type ?? input.type,
    content: persisted?.content ?? input.content,
    filePath: filename,
    // Fresh file: all three (birthtime, mtime, ctime) are now.
    createdAt: Math.min(fileStat.birthtimeMs, fileStat.mtimeMs),
    updatedAt: fileStat.ctimeMs,
  };

  return { action: "created", record };
}

async function updateRecord(
  ctx: StoreContext,
  id: MemoryRecordId,
  patch: MemoryRecordPatch,
): Promise<UpdateResult> {
  const { dir } = ctx;
  const records = await scanRecords(dir);
  const existing = records.find((r) => r.id === id);
  if (existing === undefined) {
    throw new Error(`Memory record not found: ${id}`);
  }

  const updated = {
    name: patch.name ?? existing.name,
    description: patch.description ?? existing.description,
    type: patch.type ?? existing.type,
    content: patch.content ?? existing.content,
  };

  // Guard renames/type changes against collisions. If either name or
  // type changed, make sure no OTHER record already owns the new
  // canonical (name, type) pair — otherwise update() could silently
  // land the store in the `corrupted` state that upsert() now
  // surfaces. A patch that is a no-op on name+type (e.g. content-only
  // update, or renaming to the same canonical form) is allowed.
  const canonicalNewName = sanitizeFrontmatterValue(updated.name);
  const canonicalOldName = existing.name; // already canonical on disk
  const keyChanged = canonicalNewName !== canonicalOldName || updated.type !== existing.type;
  if (keyChanged) {
    const collision = records.find(
      (r) => r.id !== id && r.name === canonicalNewName && r.type === updated.type,
    );
    if (collision !== undefined) {
      throw new Error(
        `Cannot rename memory record ${id}: target (name=${JSON.stringify(canonicalNewName)}, ` +
          `type=${updated.type}) is already owned by ${collision.id}.`,
      );
    }
  }

  const serialized = serializeMemoryFrontmatter(
    { name: updated.name, description: updated.description, type: updated.type },
    updated.content,
  );
  if (serialized === undefined) {
    throw new Error("Failed to serialize updated memory record");
  }

  // Atomic update: write to a unique temp file, then `rename` over the
  // final path. Without this, a concurrent rebuild scan (which runs
  // outside the mutation lock) could read a truncated or partial file
  // and silently omit the record from MEMORY.md.
  //
  // `rename` replaces the inode, so the new file's `birthtimeMs` is
  // reset to "now". To keep `createdAt` stable across updates, we then
  // `utimes` the file's mtime back to the original creation time. The
  // scan path uses `min(birthtimeMs, mtimeMs)` as createdAt and
  // `max(birthtimeMs, mtimeMs)` as updatedAt, so:
  //   - fresh record: birthtime == mtime == now → both equal now.
  //   - updated record: birthtime = now (new inode), mtime = original
  //     createdAt → createdAt preserved, updatedAt is the new inode age.
  const filePath = join(dir, existing.filePath);
  const tmpPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmpPath, serialized, { encoding: "utf-8", flag: "wx" });
    await rename(tmpPath, filePath);
  } catch (e: unknown) {
    try {
      await unlink(tmpPath);
    } catch {
      // temp was never created or already cleaned up
    }
    throw e;
  }
  // Preserve createdAt by stamping the original creation time into mtime.
  // utimes takes seconds; existing.createdAt is ms. Best-effort — if the
  // filesystem cannot set times, the record keeps its rename-fresh
  // birthtime and we accept the documented drift.
  const originalCreatedSec = existing.createdAt / 1000;
  const nowSec = Date.now() / 1000;
  try {
    await utimes(filePath, nowSec, originalCreatedSec);
  } catch {
    // best-effort — proceed without createdAt preservation
  }
  const updatedStat = await stat(filePath);

  // Re-parse to return sanitized values matching what's on disk
  const persisted = parseMemoryFrontmatter(serialized);
  const record: MemoryRecord = {
    id: existing.id,
    name: persisted?.frontmatter.name ?? updated.name,
    description: persisted?.frontmatter.description ?? updated.description,
    type: persisted?.frontmatter.type ?? updated.type,
    content: persisted?.content ?? updated.content,
    filePath: existing.filePath,
    createdAt: existing.createdAt,
    // ctimeMs is always bumped by utimes, so it tracks the true update
    // time even after mtime was stamped back to the original createdAt.
    updatedAt: updatedStat.ctimeMs,
  };

  return { record };
}

async function deleteRecord(ctx: StoreContext, id: MemoryRecordId): Promise<DeleteResult> {
  const { dir } = ctx;
  const records = await scanRecords(dir);
  const existing = records.find((r) => r.id === id);
  if (existing === undefined) return { deleted: false };

  try {
    await unlink(join(dir, existing.filePath));
  } catch (e: unknown) {
    // File already gone (race) — still rebuild index to clean up stale entry
    if (!isEnoent(e)) throw e;
  }

  return { deleted: true };
}

async function upsertRecord(
  ctx: StoreContext,
  input: MemoryRecordInput,
  force: boolean,
): Promise<UpsertResult> {
  // Note: validation already ran in the public `upsert()` method before
  // getContext()/mkdir. This function is called inside the dir lock and
  // must not re-validate (the lock was acquired after validation passed).
  const { dir, threshold } = ctx;
  const existing = await scanRecords(dir);

  // Canonicalize the inputs to match the persisted frontmatter form before
  // comparing against scanned records. Otherwise inputs that only differ by
  // newlines or control chars (e.g. "foo\nbar" vs "foo bar") would miss an
  // existing record and create a logical duplicate on disk.
  const canonicalName = sanitizeFrontmatterValue(input.name);
  const canonicalDescription = sanitizeFrontmatterValue(input.description);
  const canonicalInput: MemoryRecordInput = {
    ...input,
    name: canonicalName,
    description: canonicalDescription,
  };

  // Step 1: Name+type exact match (against canonicalized name).
  //
  // We intentionally collect ALL matches rather than taking the first one.
  // Legacy records written before this atomic path existed may have been
  // created by a non-atomic list→find→write race that produced multiple
  // files sharing the same logical (name,type). In that state, silently
  // picking `existing.find(...)` would non-deterministically update one
  // duplicate and leave the rest as invisible stale recalls. Fail loudly
  // and surface the corruption so an operator can reconcile manually via
  // `delete` + `rebuildIndex`.
  const nameTypeMatches = existing.filter(
    (r) => r.name === canonicalName && r.type === canonicalInput.type,
  );

  if (nameTypeMatches.length > 1) {
    return {
      action: "corrupted",
      canonicalName,
      type: canonicalInput.type,
      conflictingIds: nameTypeMatches.map((r) => r.id),
    };
  }

  const nameTypeMatch = nameTypeMatches[0];
  if (nameTypeMatch !== undefined) {
    if (!force) {
      return { action: "conflict", existing: nameTypeMatch };
    }
    // Force update — overwrite the matched record's description + content.
    const updated = await updateRecord(ctx, nameTypeMatch.id, {
      description: canonicalDescription,
      content: canonicalInput.content,
    });
    return { action: "updated", record: updated.record };
  }

  // Step 2: Jaccard content dedup (no name+type match found)
  const dup = findDuplicate(canonicalInput.content, existing, threshold);
  if (dup !== undefined) {
    return {
      action: "skipped",
      record: dup.record,
      duplicateOf: dup.id,
      similarity: dup.similarity,
    };
  }

  // Step 3: Create new record
  const serialized = serializeMemoryFrontmatter(
    { name: canonicalName, description: canonicalDescription, type: canonicalInput.type },
    canonicalInput.content,
  );
  if (serialized === undefined) {
    throw new Error("Failed to serialize memory record — invalid frontmatter or empty content");
  }

  const filename = await writeExclusive(dir, canonicalName, serialized);
  const fileStat = await stat(join(dir, filename));

  const persisted = parseMemoryFrontmatter(serialized);
  const record: MemoryRecord = {
    id: memoryRecordId(filenameToId(filename)),
    name: persisted?.frontmatter.name ?? canonicalName,
    description: persisted?.frontmatter.description ?? canonicalDescription,
    type: persisted?.frontmatter.type ?? canonicalInput.type,
    content: persisted?.content ?? canonicalInput.content,
    filePath: filename,
    createdAt: Math.min(fileStat.birthtimeMs, fileStat.mtimeMs),
    updatedAt: fileStat.ctimeMs,
  };

  return { action: "created", record };
}

async function listRecords(
  dir: string,
  filter?: MemoryListFilter,
): Promise<readonly MemoryRecord[]> {
  const records = await scanRecords(dir);
  if (filter?.type !== undefined) {
    return records.filter((r) => r.type === filter.type);
  }
  return records;
}

// ---------------------------------------------------------------------------
// Index maintenance
// ---------------------------------------------------------------------------

/**
 * Per-canonical-directory rebuild serializer — module-scoped so two
 * stores targeting the same real dir share one chain.
 *
 * Rebuilds run OUTSIDE the mutation lock, but must not overtake each
 * other or they can publish a stale index (e.g. rebuild-A scans while
 * rebuild-B has already committed a newer record; if A publishes last,
 * it overwrites B with stale state). Chaining guarantees each rebuild
 * scans disk AFTER all prior rebuilds have settled, so the last
 * published index always reflects state at least as new as any earlier
 * rebuild.
 *
 * A slow `onIndexError` callback therefore only blocks *subsequent
 * rebuilds* for the same directory — never mutations.
 */
const rebuildChains = new Map<string, Promise<unknown>>();

function enqueueRebuild(ctx: StoreContext, operation: MemoryStoreOperation): Promise<unknown> {
  const key = ctx.canonicalDir;
  const prior = rebuildChains.get(key) ?? Promise.resolve();
  const next = prior.then(
    () => attemptIndexRebuild(ctx, operation),
    () => attemptIndexRebuild(ctx, operation),
  );
  const tail = next.catch((): undefined => undefined);
  rebuildChains.set(key, tail);
  // Clean up the map entry once this is the tail — keeps memory footprint
  // bounded across many unique directories.
  void tail.then(() => {
    if (rebuildChains.get(key) === tail) rebuildChains.delete(key);
  });
  return next;
}

/**
 * Best-effort rebuild of MEMORY.md from a fresh disk scan.
 *
 * Returns the caught error (if any) so the caller can surface it via the
 * mutation's return value. Also invokes `onIndexError` for observability.
 * Never throws — the on-disk record mutation has already committed, so
 * failing the overall operation would mislead the caller.
 */
async function attemptIndexRebuild(
  ctx: StoreContext,
  operation: MemoryStoreOperation,
): Promise<unknown> {
  try {
    const freshRecords = await scanRecords(ctx.dir);
    await rebuildIndex(ctx.dir, freshRecords);
    return undefined;
  } catch (e: unknown) {
    // Fire-and-forget the observer callback. It is informational — a slow
    // callback must not delay the mutation's return, and its completion
    // is irrelevant to the indexError surfaced on the return value. Its
    // own rejections are swallowed.
    if (ctx.onIndexError !== undefined) {
      void Promise.resolve()
        .then(() => ctx.onIndexError?.(e, { operation }))
        .catch((): undefined => undefined);
    }
    return e;
  }
}

// ---------------------------------------------------------------------------
// File scanning
// ---------------------------------------------------------------------------

async function scanRecords(dir: string): Promise<readonly MemoryRecord[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const mdFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== INDEX_FILENAME)
      .map((e) => e.name);

    const results = await Promise.all(mdFiles.map((f) => recordFromFile(dir, f)));
    return results.filter((r): r is NonNullable<typeof r> => r !== undefined);
  } catch (e: unknown) {
    // Only treat missing directory as empty — propagate permission and I/O errors
    if (isEnoent(e)) return [];
    throw e;
  }
}

async function recordFromFile(dir: string, filename: string): Promise<MemoryRecord | undefined> {
  try {
    const filePath = join(dir, filename);

    // Reject symlinks — store must not escape its directory boundary
    const linkStat = await lstat(filePath);
    if (linkStat.isSymbolicLink()) return undefined;

    const content = await readFile(filePath, "utf-8");

    const parsed = parseMemoryFrontmatter(content);
    if (parsed === undefined) return undefined;

    // createdAt = min(birthtime, mtime), updatedAt = ctime.
    //
    // On a fresh write: birthtime == mtime == ctime == now.
    // On an updated record: `updateRecord` renames a new inode into
    // place (birthtime resets to now), then `utimes` stamps mtime back
    // to the original createdAt. Some filesystems (APFS) propagate the
    // earlier mtime to birthtime, so `min(birthtime, mtime)` robustly
    // recovers the original create time across platforms. `ctime` is
    // always updated by the kernel on any inode change (including
    // utimes), so it moves forward and tracks the true update time.
    return {
      id: memoryRecordId(filenameToId(filename)),
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      type: parsed.frontmatter.type,
      content: parsed.content,
      filePath: filename,
      createdAt: Math.min(linkStat.birthtimeMs, linkStat.mtimeMs),
      updatedAt: linkStat.ctimeMs,
    };
  } catch (e: unknown) {
    // File vanished between readdir and read — skip it
    if (isEnoent(e)) return undefined;
    throw e;
  }
}

/** Strip `.md` extension to get the record ID. */
function filenameToId(filename: string): string {
  return filename.endsWith(".md") ? filename.slice(0, -3) : filename;
}

/**
 * Atomically create a new .md file using exclusive flag.
 * Retries with a suffixed name on EEXIST (stray pre-existing file).
 */
async function writeExclusive(dir: string, name: string, content: string): Promise<string> {
  const MAX_ATTEMPTS = 5;
  // let — retry loop with incrementing attempt counter
  let allFiles = await listMdFiles(dir);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const filename = deriveFilename(name, allFiles);
    try {
      await writeFile(join(dir, filename), content, { encoding: "utf-8", flag: "wx" });
      return filename;
    } catch (e: unknown) {
      if (isEexist(e)) {
        // Refresh directory listing and retry
        allFiles = await listMdFiles(dir);
        continue;
      }
      throw e;
    }
  }

  // Fallback: random suffix, still exclusive
  const fallback = `${slugifyMemoryName(name)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`;
  await writeFile(join(dir, fallback), content, { encoding: "utf-8", flag: "wx" });
  return fallback;
}

/** List all .md filenames in a directory (raw readdir, includes malformed files). */
async function listMdFiles(dir: string): Promise<ReadonlySet<string>> {
  try {
    const files = await readdir(dir);
    return new Set(files.filter((f) => f.endsWith(".md") && f !== INDEX_FILENAME));
  } catch (e: unknown) {
    if (isEnoent(e)) return new Set();
    throw e;
  }
}

/** Check if an error is a filesystem ENOENT (file/dir not found). */
function isEnoent(e: unknown): boolean {
  return hasErrCode(e, "ENOENT");
}

/** Check if an error is a filesystem EEXIST (file already exists). */
function isEexist(e: unknown): boolean {
  return hasErrCode(e, "EEXIST");
}

function hasErrCode(e: unknown, code: string): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { readonly code: string }).code === code
  );
}
