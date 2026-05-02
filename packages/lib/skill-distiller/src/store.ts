import type { DistillationRecord } from "./types.js";

export type SkillStoreAddStatus = "added" | "duplicate" | "replaced" | "conflict";
export type SkillStoreEvictReason = "lru";

/**
 * What happens when a same-name insert with a different draftHash arrives.
 *  - "reject" (default) — the new record is dropped, the old one is preserved,
 *    add() returns "conflict". Caller must explicitly resolve (delete the old
 *    name first, rename the draft, etc.). Fail-closed.
 *  - "replace" — the old record is overwritten; add() returns "replaced" and
 *    fires onReplaced({ previous, next }). Caller is opting in to silent (or
 *    audited) overwrites.
 *  - "keep" — the new record is dropped, the old one is preserved, add()
 *    returns "duplicate". For callers that treat first-write as authoritative.
 */
export type SkillStoreConflictPolicy = "reject" | "replace" | "keep";

/** Caller-visible signal when a same-name insert with a different hash occurs. */
export interface SkillStoreReplacement {
  readonly previous: DistillationRecord;
  readonly next: DistillationRecord;
}

export interface SkillStoreConfig {
  /** Max records retained. Default: Infinity (no eviction). */
  readonly maxSize?: number;
  /** Fires when an entry is evicted by LRU pressure. */
  readonly onEvicted?: (record: DistillationRecord, reason: SkillStoreEvictReason) => void;
  /**
   * Fires when a same-name insert with a different draftHash overwrites an existing
   * record (only when `onConflict: "replace"`). Receives both records so the caller
   * can audit, archive, or revert.
   */
  readonly onReplaced?: (replacement: SkillStoreReplacement) => void;
  /** How to handle same-name + different-hash inserts. Default: "reject" (fail-closed). */
  readonly onConflict?: SkillStoreConflictPolicy;
}

export interface SkillStore {
  /**
   * Insert a record by `draft.name`. Returns:
   *  - "duplicate" — existing entry with same name AND same draftHash; no change beyond
   *    MRU bump. Also returned for same-name conflicts when `onConflict: "keep"`.
   *  - "added" — new name; entry inserted as MRU; may trigger LRU eviction.
   *  - "replaced" — existing entry overwritten under `onConflict: "replace"`; `onReplaced`
   *    fires before the new entry becomes MRU.
   *  - "conflict" — same-name + different-hash under default `onConflict: "reject"`; the
   *    incoming record is dropped and the existing record is preserved (and bumped to MRU
   *    so callers can read it). The caller must resolve the collision explicitly.
   */
  readonly add: (record: DistillationRecord) => SkillStoreAddStatus;
  readonly has: (name: string) => boolean;
  readonly hasHash: (draftHash: string) => boolean;
  /** Reads and bumps the entry to most-recently-used. */
  readonly get: (name: string) => DistillationRecord | undefined;
  /** Removes an entry by name. Returns true if anything was removed. */
  readonly delete: (name: string) => boolean;
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

  const policy: SkillStoreConflictPolicy = config.onConflict ?? "reject";

  return {
    add: (record: DistillationRecord): SkillStoreAddStatus => {
      const existing = entries.get(record.draft.name);
      if (existing !== undefined) {
        if (existing.draftHash === record.draftHash) {
          touch(record.draft.name, existing);
          return "duplicate";
        }
        if (policy === "reject") {
          touch(record.draft.name, existing);
          return "conflict";
        }
        if (policy === "keep") {
          touch(record.draft.name, existing);
          return "duplicate";
        }
        // policy === "replace"
        config.onReplaced?.({ previous: existing, next: record });
        touch(record.draft.name, record);
        // No LRU eviction needed — same-name replacement preserves entry count.
        return "replaced";
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
    delete: (name: string): boolean => entries.delete(name),
    list: (): readonly DistillationRecord[] => Array.from(entries.values()).reverse(),
    size: (): number => entries.size,
    clear: (): void => {
      entries.clear();
    },
  };
}
