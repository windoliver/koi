/**
 * Output extraction helper for task spawn results.
 */

import type { TaskSpawnResult } from "./types.js";

/** Default message when a task completes with no output. */
const EMPTY_OUTPUT_MESSAGE = "(task completed with no output)";

/**
 * Extracts a human-readable string from a TaskSpawnResult.
 *
 * - Success with text → returns the text
 * - Success with empty string → returns default message
 * - Failure → returns "Task failed: ..." message
 */
export function extractOutput(result: TaskSpawnResult): string {
  if (result.ok) {
    return result.output.length > 0 ? result.output : EMPTY_OUTPUT_MESSAGE;
  }
  return `Task failed: ${result.error}`;
}
