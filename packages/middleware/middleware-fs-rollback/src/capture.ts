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
    // File doesn't exist or is unreadable — treat as "no previous content"
    if (result.error.code === "NOT_FOUND") {
      return undefined;
    }
    // For other errors (permission, etc.), also return undefined (best-effort)
    return undefined;
  }

  // Skip files that exceed the capture size limit
  if (result.value.size > maxSize) {
    return undefined;
  }

  return result.value.content;
}
