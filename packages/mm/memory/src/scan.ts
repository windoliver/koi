/**
 * Memory directory scanning — reads .md files, parses frontmatter,
 * builds a manifest of scanned memories.
 *
 * Side effect: filesystem reads via FileSystemBackend.
 */

import type { FileSystemBackend, MemoryRecord } from "@koi/core";
import {
  MEMORY_INDEX_MAX_LINES,
  memoryRecordId,
  parseMemoryFrontmatter,
  validateMemoryFilePath,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Configuration & result types
// ---------------------------------------------------------------------------

/** Maximum file size in bytes for a single memory file. Larger files are skipped. */
const MAX_MEMORY_FILE_BYTES = 50_000;

/** Configuration for scanning a memory directory. */
export interface MemoryScanConfig {
  /** Absolute path to the memory directory. */
  readonly memoryDir: string;
  /** Maximum number of files to process. Default: 200. */
  readonly maxFiles?: number | undefined;
}

/** A scanned memory with parsed record and file metadata. */
export interface ScannedMemory {
  readonly record: MemoryRecord;
  readonly fileSize: number;
}

/** Result of scanning the memory directory. */
export interface MemoryScanResult {
  readonly memories: readonly ScannedMemory[];
  readonly skipped: readonly SkippedFile[];
  readonly totalFiles: number;
  /** True if the directory listing was truncated by the backend. */
  readonly truncated: boolean;
  /** True if the directory listing failed entirely (backend error). */
  readonly listFailed: boolean;
}

/** A file that was skipped during scanning (parse failure, read error, etc.). */
export interface SkippedFile {
  readonly filePath: string;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/** Hard cap on read attempts to prevent unbounded I/O from poisoned directories. */
const MAX_READ_ATTEMPTS_MULTIPLIER = 3;

/**
 * Derives a validated relative path from an absolute entry path and the
 * memory directory root. Returns undefined if the path is outside the
 * directory, contains traversal, or fails core validation.
 */
function deriveRelativePath(entryPath: string, memoryDir: string): string | undefined {
  const normalizedPath = entryPath.replace(/\\/g, "/");
  const normalizedBase = `${memoryDir.replace(/\\/g, "/").replace(/\/$/, "")}/`;
  if (!normalizedPath.startsWith(normalizedBase)) return undefined;
  const relative = normalizedPath.slice(normalizedBase.length);
  if (relative.length === 0) return undefined;
  const validationError = validateMemoryFilePath(relative);
  if (validationError !== undefined) return undefined;
  return relative;
}

// ---------------------------------------------------------------------------
// Scan implementation
// ---------------------------------------------------------------------------

/**
 * Scans a memory directory for `.md` files, parses frontmatter, and
 * builds a manifest of scanned memories sorted by modification time
 * (newest first).
 *
 * Side effect: reads files via the provided FileSystemBackend.
 */
export async function scanMemoryDirectory(
  fs: FileSystemBackend,
  config: MemoryScanConfig,
): Promise<MemoryScanResult> {
  const maxFiles = config.maxFiles ?? MEMORY_INDEX_MAX_LINES;

  // Step 1: List all .md files
  const listResult = await fs.list(config.memoryDir, { glob: "**/*.md", recursive: true });
  if (!listResult.ok) {
    return { memories: [], skipped: [], totalFiles: 0, truncated: false, listFailed: true };
  }

  const entries = listResult.value.entries;
  const totalFiles = entries.length;
  const truncated = listResult.value.truncated;

  // Step 2: Sort by modifiedAt descending (newest first)
  const sorted = entries.toSorted((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));

  // Step 3: Read and parse files until maxFiles valid memories are collected.
  // Continues past failed reads/parses so corrupt files at the top don't
  // starve out older valid memories. Hard-capped on read attempts to prevent
  // unbounded I/O from poisoned directories.
  const memories: ScannedMemory[] = [];
  const skipped: SkippedFile[] = [];
  const maxReadAttempts = maxFiles * MAX_READ_ATTEMPTS_MULTIPLIER;
  let readAttempts = 0;

  for (const entry of sorted) {
    if (memories.length >= maxFiles) break;
    if (readAttempts >= maxReadAttempts) break;

    // Reject symlinks and non-files to prevent directory-escape via symlinked entries
    if (entry.kind !== "file") {
      skipped.push({ filePath: entry.path, reason: `skipped: kind is ${entry.kind}, not file` });
      continue;
    }
    const relativePath = deriveRelativePath(entry.path, config.memoryDir);
    if (relativePath === undefined) {
      skipped.push({ filePath: entry.path, reason: "path outside memory directory or invalid" });
      continue;
    }

    // Skip oversized files before reading to bound I/O cost
    if (entry.size !== undefined && entry.size > MAX_MEMORY_FILE_BYTES) {
      skipped.push({ filePath: relativePath, reason: `file too large: ${entry.size} bytes` });
      continue;
    }

    readAttempts += 1;
    const readResult = await fs.read(entry.path);
    if (!readResult.ok) {
      skipped.push({ filePath: relativePath, reason: `read failed: ${readResult.error.message}` });
      continue;
    }

    const parsed = parseMemoryFrontmatter(readResult.value.content);
    if (parsed === undefined) {
      skipped.push({ filePath: relativePath, reason: "invalid or missing frontmatter" });
      continue;
    }

    const record: MemoryRecord = {
      id: memoryRecordId(relativePath),
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      type: parsed.frontmatter.type,
      content: parsed.content,
      filePath: relativePath,
      createdAt: entry.modifiedAt ?? 0,
      updatedAt: entry.modifiedAt ?? 0,
    };

    memories.push({ record, fileSize: readResult.value.size });
  }

  return { memories, skipped, totalFiles, truncated, listFailed: false };
}
