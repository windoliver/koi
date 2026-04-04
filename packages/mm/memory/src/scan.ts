/**
 * Memory directory scanning — reads .md files, parses frontmatter,
 * builds a manifest of scanned memories.
 *
 * Side effect: filesystem reads via FileSystemBackend.
 */

import type { FileSystemBackend, MemoryRecord } from "@koi/core";
import { MEMORY_INDEX_MAX_LINES, memoryRecordId, parseMemoryFrontmatter } from "@koi/core";

// ---------------------------------------------------------------------------
// Configuration & result types
// ---------------------------------------------------------------------------

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
  const listResult = await fs.list(config.memoryDir, { glob: "*.md" });
  if (!listResult.ok) {
    return { memories: [], skipped: [], totalFiles: 0, truncated: false, listFailed: true };
  }

  const entries = listResult.value.entries;
  const totalFiles = entries.length;
  const truncated = listResult.value.truncated;

  // Step 2: Sort by modifiedAt descending (newest first), cap at maxFiles
  const sorted = entries
    .toSorted((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0))
    .slice(0, maxFiles);

  // Step 3: Read and parse each file
  const memories: ScannedMemory[] = [];
  const skipped: SkippedFile[] = [];

  for (const entry of sorted) {
    const readResult = await fs.read(entry.path);
    if (!readResult.ok) {
      skipped.push({ filePath: entry.path, reason: `read failed: ${readResult.error.message}` });
      continue;
    }

    const parsed = parseMemoryFrontmatter(readResult.value.content);
    if (parsed === undefined) {
      skipped.push({ filePath: entry.path, reason: "invalid or missing frontmatter" });
      continue;
    }

    const record: MemoryRecord = {
      id: memoryRecordId(entry.path),
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      type: parsed.frontmatter.type,
      content: parsed.content,
      filePath: entry.path,
      createdAt: entry.modifiedAt ?? 0,
      updatedAt: entry.modifiedAt ?? 0,
    };

    memories.push({ record, fileSize: readResult.value.size });
  }

  return { memories, skipped, totalFiles, truncated, listFailed: false };
}
