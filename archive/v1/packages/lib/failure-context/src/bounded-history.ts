/**
 * Generic bounded-history utility.
 *
 * Keeps only the most recent `maxSize` entries from a readonly array.
 * Returns the original array when already within bounds (reference identity preserved).
 */

export function trimToRecent<T>(records: readonly T[], maxSize: number): readonly T[] {
  if (records.length <= maxSize) return records;
  return records.slice(records.length - maxSize);
}
