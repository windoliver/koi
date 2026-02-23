/**
 * One-time extraction of bundled brick JSON files into a shard layout.
 *
 * Reads flat .json brick files from a source directory and copies them
 * into the hash-sharded layout used by FsForgeStore. Files are processed
 * in parallel for fast startup.
 */

import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { brickPath, shardDir, tmpPath } from "./paths.js";

// ---------------------------------------------------------------------------
// Config & result types
// ---------------------------------------------------------------------------

export interface ExtractBundledConfig {
  /** Directory containing flat .json brick files. */
  readonly sourceDir: string;
  /** Shard layout destination directory. */
  readonly targetDir: string;
  /** If true, overwrite existing shard files. Default: false (skip existing). */
  readonly overwrite?: boolean;
}

export interface ExtractBundledResult {
  readonly extracted: number;
  readonly skipped: number;
  readonly errors: readonly string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type FileOutcome =
  | { readonly status: "extracted" }
  | { readonly status: "skipped" }
  | { readonly status: "error"; readonly message: string };

/** Read a brick JSON file, returning the brick id and raw content, or an error. */
async function parseBrickFile(
  filePath: string,
): Promise<{ readonly id: string; readonly content: string } | { readonly error: string }> {
  try {
    const file = Bun.file(filePath);
    const content = await file.text();
    const parsed: unknown = JSON.parse(content);
    if (parsed === null || typeof parsed !== "object" || !("id" in parsed)) {
      return { error: `${filePath}: missing 'id' field` };
    }
    const id = (parsed as Record<string, unknown>).id;
    if (typeof id !== "string" || id.length === 0) {
      return { error: `${filePath}: 'id' must be a non-empty string` };
    }
    return { id, content };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `${filePath}: ${msg}` };
  }
}

/** Process a single source file: parse, check existence, atomic-write to shard. */
async function processFile(
  sourcePath: string,
  targetDir: string,
  overwrite: boolean,
): Promise<FileOutcome> {
  const parseResult = await parseBrickFile(sourcePath);

  if ("error" in parseResult) {
    return { status: "error", message: parseResult.error };
  }

  const { id, content } = parseResult;
  const finalPath = brickPath(targetDir, id);
  const shard = shardDir(targetDir, id);
  const temp = tmpPath(targetDir, id);

  if (!overwrite) {
    const exists = await Bun.file(finalPath).exists();
    if (exists) {
      return { status: "skipped" };
    }
  }

  try {
    await mkdir(shard, { recursive: true });
    await Bun.write(temp, content);
    await rename(temp, finalPath);
    return { status: "extracted" };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `${sourcePath}: write failed: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract bundled brick JSON files from a flat directory into shard layout.
 *
 * For each .json file in sourceDir (processed in parallel):
 * 1. Parse to extract the brick id (single read — content is kept for write)
 * 2. Compute shard path in targetDir
 * 3. Skip if file exists and overwrite is false
 * 4. Atomic-write to shard path
 */
export async function extractBundled(config: ExtractBundledConfig): Promise<ExtractBundledResult> {
  const { sourceDir, targetDir, overwrite = false } = config;

  let entries: string[];
  try {
    const dirEntries = await readdir(sourceDir);
    entries = dirEntries.filter((f) => f.endsWith(".json"));
  } catch {
    // Empty or missing source directory
    return { extracted: 0, skipped: 0, errors: [] };
  }

  // Process all files in parallel
  const outcomes = await Promise.all(
    entries.map((fileName) => processFile(join(sourceDir, fileName), targetDir, overwrite)),
  );

  // Aggregate results
  let extracted = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === "extracted") extracted += 1;
    else if (outcome.status === "skipped") skipped += 1;
    else errors.push(outcome.message);
  }

  return { extracted, skipped, errors };
}
