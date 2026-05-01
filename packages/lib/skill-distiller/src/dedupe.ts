import type { DedupeIndex, DedupeStatus, DistillationRecord } from "./types.js";

export function createDedupeIndex(): DedupeIndex {
  const seen = new Set<string>();
  return {
    has: (draftHash: string): boolean => seen.has(draftHash),
    register: (record: DistillationRecord): DedupeStatus => {
      if (seen.has(record.draftHash)) return "duplicate";
      seen.add(record.draftHash);
      return "new";
    },
    clear: (): void => {
      seen.clear();
    },
    size: (): number => seen.size,
  };
}
