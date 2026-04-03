/**
 * Computes compensating operations from a sequence of FileOpRecords.
 */

import type { CompensatingOp, FileOpRecord } from "@koi/core";

/**
 * Given a sequence of FileOpRecords (newest-first), compute the compensating
 * operations needed to undo them. Deduplicates by path, keeping the earliest
 * previousContent (which represents the original state before any changes).
 */
export function computeCompensatingOps(
  records: readonly FileOpRecord[],
): readonly CompensatingOp[] {
  if (records.length === 0) {
    return [];
  }

  // Walk newest-first, tracking the earliest previousContent per path.
  // Since records are newest-first, each subsequent record for the same path
  // has an earlier previousContent, so we always overwrite.
  const earliestByPath = new Map<string, string | undefined>();

  for (const record of records) {
    // Always overwrite — later entries in the array are older,
    // so their previousContent is the "more original" state.
    earliestByPath.set(record.path, record.previousContent);
  }

  const ops: CompensatingOp[] = [];

  for (const [path, previousContent] of earliestByPath) {
    if (previousContent === undefined) {
      ops.push({ kind: "delete", path });
    } else {
      ops.push({ kind: "restore", path, content: previousContent });
    }
  }

  return ops;
}
