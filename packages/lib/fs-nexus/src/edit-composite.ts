/**
 * Composite edit fallback: read → apply hunks → write.
 *
 * Used when Nexus's native `edit` RPC is unavailable (METHOD_NOT_FOUND).
 * Uses @koi/edit-match for cascading hunk matching (exact → fuzzy).
 *
 * Atomic: if any hunk fails, the file is not modified.
 */

import type { FileEdit, FileEditOptions, FileEditResult, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import { applyEdit } from "@koi/edit-match";
import { stripBasePath, withSafePath } from "./paths.js";
import type { NexusTransport } from "./types.js";

// ---------------------------------------------------------------------------
// Nexus response types (inline — matches transport expectations)
// ---------------------------------------------------------------------------

interface NexusReadResponse {
  readonly content: string;
  readonly metadata?: { readonly size?: number };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply edits as a composite read → hunks → write operation.
 * Atomic: all hunks are applied in-memory before writing.
 * If any hunk fails to match, returns an error and the file is unchanged.
 */
export async function applyEditsComposite(
  transport: NexusTransport,
  basePath: string,
  path: string,
  edits: readonly FileEdit[],
  options?: FileEditOptions,
): Promise<Result<FileEditResult, KoiError>> {
  // Empty edits → no-op
  if (edits.length === 0) {
    return { ok: true, value: { path, hunksApplied: 0 } };
  }

  return withSafePath(basePath, path, async (fullPath) => {
    // Step 1: Read current content
    const readResult = await transport.call<NexusReadResponse>("read", {
      path: fullPath,
      return_metadata: true,
    });
    if (!readResult.ok) return readResult;

    const raw = readResult.value;
    const originalContent = typeof raw === "string" ? raw : raw.content;

    // Step 2: Apply all hunks sequentially in-memory
    let workingContent = originalContent;
    for (let i = 0; i < edits.length; i++) {
      const hunk = edits[i];
      if (hunk === undefined) continue;

      const result = applyEdit(workingContent, hunk.oldText, hunk.newText);
      if (result === undefined) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Edit hunk ${String(i)} not found: "${hunk.oldText.slice(0, 50)}"`,
            retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
            context: { hunkIndex: i, path },
          },
        };
      }
      workingContent = result.content;
    }

    // Step 3: Write back (skip for dryRun)
    if (options?.dryRun !== true) {
      const writeResult = await transport.call<unknown>("write", {
        path: fullPath,
        content: workingContent,
      });
      if (!writeResult.ok) return writeResult;
    }

    return {
      ok: true,
      value: {
        path: stripBasePath(basePath, fullPath),
        hunksApplied: edits.length,
      },
    };
  });
}
