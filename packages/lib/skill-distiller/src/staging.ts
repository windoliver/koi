import type { DistillationRecord } from "./types.js";

export type StagingStatus = "pending" | "approved" | "rejected";

export interface StagingEntry {
  /** Stable id — equal to record.draftHash. */
  readonly id: string;
  readonly record: DistillationRecord;
  readonly status: StagingStatus;
  readonly stagedAt: number;
  readonly resolvedAt?: number;
  readonly note?: string;
}

export interface StagingQueueConfig {
  readonly now?: () => number;
}

export interface StagingQueue {
  /**
   * Stage a new record. If an entry with the same draftHash already exists,
   * its current state is returned untouched (idempotent).
   */
  readonly stage: (record: DistillationRecord) => StagingEntry;
  /** Approve a pending entry. Returns updated entry, or undefined if not pending / not found. */
  readonly approve: (id: string, note?: string) => StagingEntry | undefined;
  /** Reject a pending entry. Returns updated entry, or undefined if not pending / not found. */
  readonly reject: (id: string, note?: string) => StagingEntry | undefined;
  readonly get: (id: string) => StagingEntry | undefined;
  readonly listPending: () => readonly StagingEntry[];
  readonly listAll: () => readonly StagingEntry[];
  readonly clear: () => void;
}

export function createStagingQueue(config: StagingQueueConfig = {}): StagingQueue {
  const now = config.now ?? Date.now;
  const entries = new Map<string, StagingEntry>();

  const resolve = (
    id: string,
    nextStatus: "approved" | "rejected",
    note: string | undefined,
  ): StagingEntry | undefined => {
    const current = entries.get(id);
    if (current === undefined) return undefined;
    if (current.status !== "pending") return undefined;
    const updated: StagingEntry = {
      id: current.id,
      record: current.record,
      status: nextStatus,
      stagedAt: current.stagedAt,
      resolvedAt: now(),
      ...(note === undefined ? {} : { note }),
    };
    entries.set(id, updated);
    return updated;
  };

  return {
    stage: (record: DistillationRecord): StagingEntry => {
      const existing = entries.get(record.draftHash);
      if (existing !== undefined) return existing;
      const entry: StagingEntry = {
        id: record.draftHash,
        record,
        status: "pending",
        stagedAt: now(),
      };
      entries.set(entry.id, entry);
      return entry;
    },
    approve: (id, note) => resolve(id, "approved", note),
    reject: (id, note) => resolve(id, "rejected", note),
    get: (id) => entries.get(id),
    listPending: (): readonly StagingEntry[] =>
      Array.from(entries.values()).filter((e) => e.status === "pending"),
    listAll: (): readonly StagingEntry[] => Array.from(entries.values()),
    clear: (): void => {
      entries.clear();
    },
  };
}
