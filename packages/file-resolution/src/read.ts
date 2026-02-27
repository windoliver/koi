/**
 * Low-level file reading utilities for content resolution.
 */

import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { truncateSafe } from "./truncate.js";

/** Maximum bytes per character in UTF-8 encoding. */
const BYTES_PER_CHAR_MAX = 4;

/** Returns true if the error has a `code` property matching the given value. */
function hasErrorCode(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && (err as { code: unknown }).code === code;
}

/** Result of a bounded file read with truncation metadata. */
export interface BoundedReadResult {
  readonly content: string;
  readonly truncated: boolean;
  readonly originalSize: number;
}

/**
 * Reads a file's text content, optionally bounded by a character budget.
 *
 * When `maxChars` is omitted, reads the entire file (unbounded).
 * When `maxChars` is provided, reads at most `maxChars * 4` bytes (worst-case UTF-8)
 * then truncates to `maxChars` characters — guaranteeing bounded I/O for large files.
 *
 * Returns undefined when the file does not exist (ENOENT) or path is a directory (EISDIR).
 * Throws on unexpected errors (permission denied, disk failure, etc.).
 *
 * @overload Without maxChars — returns plain string (backward compatible)
 * @overload With maxChars — returns BoundedReadResult with truncation metadata
 */
export async function readBoundedFile(filePath: string): Promise<string | undefined>;
export async function readBoundedFile(
  filePath: string,
  maxChars: number,
): Promise<BoundedReadResult | undefined>;
export async function readBoundedFile(
  filePath: string,
  maxChars?: number,
): Promise<string | BoundedReadResult | undefined> {
  try {
    const file = Bun.file(filePath);

    if (maxChars === undefined) {
      // Unbounded — read entire file
      return await file.text();
    }

    // Bounded — check existence first, then byte-slice
    const exists = await file.exists();
    if (!exists) return undefined;

    const originalSize = file.size;
    const maxBytes = maxChars * BYTES_PER_CHAR_MAX;
    const raw = await file.slice(0, maxBytes).text();
    const truncated = raw.length > maxChars;
    const content = truncated ? truncateSafe(raw, maxChars) : raw;

    return { content, truncated, originalSize };
  } catch (err: unknown) {
    if (hasErrorCode(err, "ENOENT") || hasErrorCode(err, "EISDIR")) return undefined;
    throw new Error(`Failed to read file: ${filePath}`, { cause: err });
  }
}

/**
 * Returns true if the given path is a readable directory.
 * Returns false when the path does not exist (ENOENT) or is not a directory (ENOTDIR).
 * Throws on unexpected errors (permission denied, etc.).
 */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch (err: unknown) {
    if (hasErrorCode(err, "ENOENT") || hasErrorCode(err, "ENOTDIR")) return false;
    throw new Error(`Failed to check directory: ${path}`, { cause: err });
  }
}

/**
 * Returns true if the input string contains a newline (indicating inline content).
 */
export function isInlineContent(input: string): boolean {
  return input.includes("\n");
}

/**
 * Resolves a relative input path against a base path.
 */
export function resolveInputPath(input: string, basePath: string): string {
  return resolve(basePath, input);
}
