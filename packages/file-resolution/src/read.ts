/**
 * Low-level file reading utilities for content resolution.
 */

import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

/** Returns true if the error has a `code` property matching the given value. */
function hasErrorCode(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && (err as { code: unknown }).code === code;
}

/**
 * Reads a file's text content.
 * Returns undefined when the file does not exist (ENOENT) or path is a directory (EISDIR).
 * Throws on unexpected errors (permission denied, disk failure, etc.).
 */
export async function readBoundedFile(filePath: string): Promise<string | undefined> {
  try {
    return await Bun.file(filePath).text();
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
