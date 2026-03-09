/**
 * Captures the pre-state of a file before a tool operation.
 */

import type { FileSystemBackend } from "@koi/core";

/** Default maximum capture size: 1 MB. */
export const DEFAULT_MAX_CAPTURE_SIZE = 1_048_576;

/**
 * Reads the current content of a file before a tool operation.
 * Returns undefined if the file doesn't exist or exceeds maxCaptureSize.
 */
export async function capturePreState(
  backend: FileSystemBackend,
  path: string,
  maxSize: number,
): Promise<string | undefined> {
  const result = await backend.read(path);

  if (!result.ok) {
    if (result.error.code === "NOT_FOUND") {
      return undefined;
    }
    // Non-NOT_FOUND errors (permission, transient I/O) — throw to prevent
    // recording undefined as previous content, which would cause rollback
    // to delete the file instead of restoring it.
    throw new Error(`Failed to capture pre-state for "${path}": ${result.error.message}`, {
      cause: result.error,
    });
  }

  // Skip files that exceed the capture size limit
  if (result.value.size > maxSize) {
    return undefined;
  }

  return result.value.content;
}
