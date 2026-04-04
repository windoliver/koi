/**
 * MEMORY.md index management — rebuild and read the memory index file.
 *
 * The index is a Markdown file with one line per memory record,
 * capped at MEMORY_INDEX_MAX_LINES (200). Rebuilt eagerly on every mutation.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryIndex, MemoryRecord } from "@koi/core/memory";
import {
  formatMemoryIndexEntry,
  MEMORY_INDEX_MAX_LINES,
  parseMemoryIndexEntry,
} from "@koi/core/memory";

const INDEX_FILENAME = "MEMORY.md";

/**
 * Rebuild the MEMORY.md index from the given records.
 *
 * Records are sorted by createdAt descending (newest first).
 * If records exceed MEMORY_INDEX_MAX_LINES, oldest entries are dropped.
 */
export async function rebuildIndex(dir: string, records: readonly MemoryRecord[]): Promise<void> {
  const sorted = [...records].sort((a, b) => b.createdAt - a.createdAt);
  const capped = sorted.slice(0, MEMORY_INDEX_MAX_LINES);

  const lines: string[] = [];
  for (const record of capped) {
    const entry = formatMemoryIndexEntry({
      title: record.name,
      filePath: record.filePath,
      hook: record.description,
    });
    if (entry !== undefined) {
      lines.push(entry);
    }
  }

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, INDEX_FILENAME), `${lines.join("\n")}\n`, "utf-8");
}

/**
 * Read and parse the MEMORY.md index file.
 *
 * Returns an empty index if the file does not exist.
 * Propagates permission and I/O errors.
 */
export async function readIndex(dir: string): Promise<MemoryIndex> {
  try {
    const content = await readFile(join(dir, INDEX_FILENAME), "utf-8");
    const entries = content
      .split("\n")
      .map(parseMemoryIndexEntry)
      .filter((e): e is NonNullable<typeof e> => e !== undefined);
    return { entries };
  } catch (e: unknown) {
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      (e as { readonly code: string }).code === "ENOENT"
    ) {
      return { entries: [] };
    }
    throw e;
  }
}
