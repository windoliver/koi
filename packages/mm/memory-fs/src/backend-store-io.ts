import type { FileListEntry, KoiError, Result } from "@koi/core";
import type { MemoryRecord } from "@koi/core/memory";
import { memoryRecordId, parseMemoryFrontmatter, validateMemoryFilePath } from "@koi/core/memory";
import type { StoreContext } from "./backend-store.js";

const INDEX_FILENAME = "MEMORY.md";

export interface BackendRecord {
  readonly record: MemoryRecord;
  readonly fullPath: string;
}

export function memoryPath(ctx: StoreContext, relativePath: string): string {
  const relative = relativePath.replace(/^\/+/, "");
  return `${ctx.memoryDir}/${relative}`;
}

export function toError(result: Result<unknown, KoiError>, operation: string): Error {
  if (result.ok) return new Error(`Unexpected successful result for ${operation}`);
  return new Error(`${operation} failed: ${result.error.message}`);
}

export async function scanRecords(ctx: StoreContext): Promise<readonly BackendRecord[]> {
  const entries = await scanEntries(ctx);
  const sorted = entries.toSorted((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
  const records: BackendRecord[] = [];

  for (const entry of sorted) {
    if (entry.kind !== "file") continue;
    const relativePath = deriveRelativePath(entry.path, ctx.memoryDir);
    if (relativePath === undefined) continue;
    const record = await recordFromPath(ctx, relativePath, entry);
    if (record !== undefined) records.push(record);
  }

  return records;
}

export async function rawMemoryFilenames(ctx: StoreContext): Promise<ReadonlySet<string>> {
  const entries = await scanEntries(ctx);
  return new Set(
    entries
      .filter((entry) => entry.kind === "file")
      .map((entry) => deriveRelativePath(entry.path, ctx.memoryDir))
      .filter((path): path is string => path !== undefined),
  );
}

export async function readRecordAt(
  ctx: StoreContext,
  relativePath: string,
): Promise<MemoryRecord | undefined> {
  const record = await recordFromPath(ctx, relativePath);
  return record?.record;
}

async function scanEntries(ctx: StoreContext): Promise<readonly FileListEntry[]> {
  const list = await ctx.fs.list(ctx.memoryDir, { glob: "**/*.md", recursive: true });
  if (!list.ok) throw toError(list, "list memory records");
  return list.value.entries;
}

function deriveRelativePath(entryPath: string, memoryDir: string): string | undefined {
  const normalizedPath = entryPath.replace(/\\/g, "/");
  const normalizedBase = `${memoryDir.replace(/\\/g, "/").replace(/\/$/, "")}/`;
  if (!normalizedPath.startsWith(normalizedBase)) return undefined;
  const relative = normalizedPath.slice(normalizedBase.length);
  if (relative.length === 0) return undefined;
  if (relative === INDEX_FILENAME) return undefined;
  if (validateMemoryFilePath(relative) !== undefined) return undefined;
  return relative;
}

async function recordFromPath(
  ctx: StoreContext,
  relativePath: string,
  entry?: FileListEntry,
): Promise<BackendRecord | undefined> {
  const fullPath = memoryPath(ctx, relativePath);
  const read = await ctx.fs.read(fullPath);
  if (!read.ok) return undefined;
  const parsed = parseMemoryFrontmatter(read.value.content);
  if (parsed === undefined) return undefined;
  const timestamp = entry?.modifiedAt ?? Date.now();
  return {
    fullPath,
    record: {
      id: memoryRecordId(filenameToId(relativePath)),
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      type: parsed.frontmatter.type,
      content: parsed.content,
      filePath: relativePath,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(parsed.frontmatter.confidence !== undefined
        ? { confidence: parsed.frontmatter.confidence }
        : {}),
    },
  };
}

function filenameToId(filename: string): string {
  return filename.endsWith(".md") ? filename.slice(0, -3) : filename;
}
