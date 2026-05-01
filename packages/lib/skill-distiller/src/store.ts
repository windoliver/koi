import type { DistillationRecord } from "./types.js";

export type SkillStoreAddStatus = "added" | "duplicate";
export type SkillStoreEvictReason = "lru";

export interface SkillStoreConfig {
  /** Max records retained. Default: Infinity (no eviction). */
  readonly maxSize?: number;
  /** Fires when an entry is evicted by LRU pressure. */
  readonly onEvicted?: (record: DistillationRecord, reason: SkillStoreEvictReason) => void;
}

export interface SkillStore {
  /**
   * Insert or replace a record by `draft.name`. Returns:
   *  - "duplicate" when an existing entry with the same name AND draftHash is present (no change)
   *  - "added" when the entry is new, or when an existing entry's hash differs (replacement)
   *
   * On "added" the entry becomes the most-recently-used. If the store would exceed `maxSize`,
   * the least-recently-used entry is evicted and `onEvicted` fires.
   */
  readonly add: (record: DistillationRecord) => SkillStoreAddStatus;
  readonly has: (name: string) => boolean;
  readonly hasHash: (draftHash: string) => boolean;
  /** Reads and bumps the entry to most-recently-used. */
  readonly get: (name: string) => DistillationRecord | undefined;
  /** Returns records in MRU-first order. */
  readonly list: () => readonly DistillationRecord[];
  readonly size: () => number;
  readonly clear: () => void;
}

export function createSkillStore(config: SkillStoreConfig = {}): SkillStore {
  const maxSize = config.maxSize ?? Number.POSITIVE_INFINITY;
  if (maxSize <= 0) {
    throw new Error(`SkillStore maxSize must be > 0 (got ${maxSize})`);
  }
  // Map preserves insertion order; we treat MRU = last-inserted.
  const entries = new Map<string, DistillationRecord>();

  const touch = (name: string, record: DistillationRecord): void => {
    entries.delete(name);
    entries.set(name, record);
  };

  const evictIfFull = (): void => {
    while (entries.size > maxSize) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) return;
      const oldest = entries.get(oldestKey);
      entries.delete(oldestKey);
      if (oldest !== undefined) config.onEvicted?.(oldest, "lru");
    }
  };

  return {
    add: (record: DistillationRecord): SkillStoreAddStatus => {
      const existing = entries.get(record.draft.name);
      if (existing !== undefined && existing.draftHash === record.draftHash) {
        touch(record.draft.name, existing);
        return "duplicate";
      }
      touch(record.draft.name, record);
      evictIfFull();
      return "added";
    },
    has: (name: string): boolean => entries.has(name),
    hasHash: (draftHash: string): boolean => {
      for (const record of entries.values()) {
        if (record.draftHash === draftHash) return true;
      }
      return false;
    },
    get: (name: string): DistillationRecord | undefined => {
      const record = entries.get(name);
      if (record === undefined) return undefined;
      touch(name, record);
      return record;
    },
    list: (): readonly DistillationRecord[] => Array.from(entries.values()).reverse(),
    size: (): number => entries.size,
    clear: (): void => {
      entries.clear();
    },
  };
}
