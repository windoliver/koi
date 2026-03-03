/**
 * Composite compaction archiver.
 *
 * Runs multiple CompactionArchiver instances sequentially. Order matters:
 * snapshot archiver first (raw preservation), then fact extractor (semantic
 * extraction). Errors are collected and thrown as AggregateError — the
 * fire-and-forget wrapper in compact.ts catches it.
 */

import type { CompactionArchiver } from "./types.js";

const NOOP_ARCHIVER: CompactionArchiver = {
  archive: () => {},
};

/**
 * Composes multiple CompactionArchiver instances into a single archiver.
 *
 * - 0 archivers → noop (no allocation)
 * - 1 archiver  → returned directly (no wrapper overhead)
 * - N archivers → sequential execution, AggregateError on any failure
 */
export function createCompositeArchiver(
  archivers: readonly CompactionArchiver[],
): CompactionArchiver {
  if (archivers.length === 0) return NOOP_ARCHIVER;
  const single = archivers[0];
  if (archivers.length === 1 && single !== undefined) return single;

  return {
    async archive(messages, summary): Promise<void> {
      const errors: unknown[] = [];

      for (const archiver of archivers) {
        try {
          await archiver.archive(messages, summary);
        } catch (e: unknown) {
          errors.push(e);
        }
      }

      if (errors.length > 0) {
        throw new AggregateError(errors, "One or more archivers failed");
      }
    },
  };
}
