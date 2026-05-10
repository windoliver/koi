/**
 * Output extraction helper for task spawn results.
 */

import type { TaskSpawnResult } from "./types.js";

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
  // Tolerate the legacy `{ ok: false, error: "string" }` shape for callers
  // pinned to an older task-spawn major. The unified core contract carries
  // `{ ok: false, error: KoiError }`, but version skew or external integrations
  // still emit the string form. Render whichever is present rather than
  // surfacing "Task failed: undefined" to the user.
  const rawError = (result as { readonly error: unknown }).error;
  let detail: string;
  if (typeof rawError === "string") {
    detail = rawError;
  } else if (
    typeof rawError === "object" &&
    rawError !== null &&
    "message" in rawError &&
    typeof (rawError as { message: unknown }).message === "string"
  ) {
    detail = (rawError as { message: string }).message;
  } else {
    detail = "unknown error";
  }
  return `Task failed: ${detail}`;
}
