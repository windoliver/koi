/**
 * createMemoryStore — file-based memory store factory.
 *
 * Each memory record is a Markdown file with bespoke frontmatter.
 * A MEMORY.md index is rebuilt on every mutation (write/update/delete).
 */

import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
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
  serializeMemoryFrontmatter,
  validateMemoryRecordInput,
} from "@koi/core/memory";
import { findDuplicate } from "./dedup.js";
import { rebuildIndex } from "./index-file.js";
import { deriveFilename } from "./slug.js";
import type { DedupResult, MemoryListFilter, MemoryStore, MemoryStoreConfig } from "./types.js";
import { DEFAULT_DEDUP_THRESHOLD } from "./types.js";

const INDEX_FILENAME = "MEMORY.md";

/**
 * Create a file-based memory store.
 *
 * Records are stored as `.md` files in `config.dir`.
 * MEMORY.md is rebuilt after every mutation.
 */
export function createMemoryStore(config: MemoryStoreConfig): MemoryStore {
  const { dir } = config;
  const threshold = config.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD;

  if (threshold < 0 || threshold > 1) {
    throw new Error(`dedupThreshold must be between 0 and 1, got ${String(threshold)}`);
  }

  return {
    read: (id) => readRecord(dir, id),
    write: (input) => writeRecord(dir, input, threshold),
    update: (id, patch) => updateRecord(dir, id, patch),
    delete: (id) => deleteRecord(dir, id),
    list: (filter) => listRecords(dir, filter),
  };
}

// ---------------------------------------------------------------------------
// Internal operations
// ---------------------------------------------------------------------------

async function readRecord(dir: string, id: MemoryRecordId): Promise<MemoryRecord | undefined> {
  const records = await scanRecords(dir);
  return records.find((r) => r.id === id);
}

async function writeRecord(
  dir: string,
  input: MemoryRecordInput,
  threshold: number,
): Promise<DedupResult> {
  const errors = validateMemoryRecordInput({ ...input });
  if (errors.length > 0) {
    const messages = errors.map((e) => `${e.field}: ${e.message}`).join("; ");
    throw new Error(`Invalid memory record input: ${messages}`);
  }

  await mkdir(dir, { recursive: true });
  const existing = await scanRecords(dir);

  const dup = findDuplicate(input.content, existing, threshold);
  if (dup !== undefined) {
    return {
      action: "skipped",
      record: dup.record,
      duplicateOf: dup.id,
      similarity: dup.similarity,
    };
  }

  // Use raw readdir for collision checks — includes malformed/unreadable files
  const allFiles = await listMdFiles(dir);
  const filename = deriveFilename(input.name, allFiles);
  const filePath = join(dir, filename);

  const serialized = serializeMemoryFrontmatter(
    { name: input.name, description: input.description, type: input.type },
    input.content,
  );
  if (serialized === undefined) {
    throw new Error("Failed to serialize memory record — invalid frontmatter or empty content");
  }

  await writeFile(filePath, serialized, "utf-8");
  const fileStat = await stat(filePath);

  // Re-parse to return sanitized values matching what's on disk
  const persisted = parseMemoryFrontmatter(serialized);
  const record: MemoryRecord = {
    id: memoryRecordId(filenameToId(filename)),
    name: persisted?.frontmatter.name ?? input.name,
    description: persisted?.frontmatter.description ?? input.description,
    type: persisted?.frontmatter.type ?? input.type,
    content: persisted?.content ?? input.content,
    filePath: filename,
    createdAt: fileStat.birthtimeMs,
    updatedAt: fileStat.mtimeMs,
  };

  await tryRebuildIndex(dir, [...existing, record]);
  return { action: "created", record };
}

async function updateRecord(
  dir: string,
  id: MemoryRecordId,
  patch: MemoryRecordPatch,
): Promise<MemoryRecord> {
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

  const serialized = serializeMemoryFrontmatter(
    { name: updated.name, description: updated.description, type: updated.type },
    updated.content,
  );
  if (serialized === undefined) {
    throw new Error("Failed to serialize updated memory record");
  }

  const filePath = join(dir, existing.filePath);
  await writeFile(filePath, serialized, "utf-8");
  const fileStat = await stat(filePath);

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
    updatedAt: fileStat.mtimeMs,
  };

  const updatedRecords = records.map((r) => (r.id === id ? record : r));
  await tryRebuildIndex(dir, updatedRecords);
  return record;
}

async function deleteRecord(dir: string, id: MemoryRecordId): Promise<boolean> {
  const records = await scanRecords(dir);
  const existing = records.find((r) => r.id === id);
  if (existing === undefined) return false;

  try {
    await unlink(join(dir, existing.filePath));
  } catch (e: unknown) {
    // File already gone — treat as successful delete
    if (isEnoent(e)) return false;
    throw e;
  }

  const remaining = records.filter((r) => r.id !== id);
  await tryRebuildIndex(dir, remaining);
  return true;
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
// File scanning
// ---------------------------------------------------------------------------

async function scanRecords(dir: string): Promise<readonly MemoryRecord[]> {
  try {
    const files = await readdir(dir);
    const mdFiles = files.filter((f) => f.endsWith(".md") && f !== INDEX_FILENAME);

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
    const [content, fileStat] = await Promise.all([readFile(filePath, "utf-8"), stat(filePath)]);

    const parsed = parseMemoryFrontmatter(content);
    if (parsed === undefined) return undefined;

    return {
      id: memoryRecordId(filenameToId(filename)),
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      type: parsed.frontmatter.type,
      content: parsed.content,
      filePath: filename,
      createdAt: fileStat.birthtimeMs,
      updatedAt: fileStat.mtimeMs,
    };
  } catch {
    return undefined;
  }
}

/** Strip `.md` extension to get the record ID. */
function filenameToId(filename: string): string {
  return filename.endsWith(".md") ? filename.slice(0, -3) : filename;
}

/**
 * Best-effort index rebuild — record mutations are the source of truth.
 * If index rebuild fails, the index self-heals on the next successful mutation.
 */
async function tryRebuildIndex(dir: string, records: readonly MemoryRecord[]): Promise<void> {
  try {
    await rebuildIndex(dir, records);
  } catch {
    // Index write failed — record mutation already committed.
    // Index will be rebuilt on the next successful mutation.
  }
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
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { readonly code: string }).code === "ENOENT"
  );
}
