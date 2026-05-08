import type { ScratchpadChangeEvent, ScratchpadEntrySummary } from "@koi/core";

export interface ChangeTracker {
  /**
   * Diff the latest snapshot against the previously-seen state and return
   * change events. Pass `complete: false` when the snapshot is page-limited
   * or otherwise non-exhaustive: in that case missing paths are *not* treated
   * as deletes (they may simply be on a later page) and previously-seen
   * entries are retained so the next exhaustive poll can detect them.
   */
  readonly nextEvents: (
    entries: readonly ScratchpadEntrySummary[],
    options?: { readonly complete?: boolean | undefined },
  ) => readonly ScratchpadChangeEvent[];
  readonly clear: () => void;
}

export function createChangeTracker(groupId: string): ChangeTracker {
  void groupId;

  let seen = new Map<string, ScratchpadEntrySummary>();

  return {
    nextEvents(entries, options) {
      const complete = options?.complete ?? true;
      const events: ScratchpadChangeEvent[] = [];
      const observed = new Map<string, ScratchpadEntrySummary>();

      for (const entry of entries) {
        observed.set(entry.path, entry);
        const previous = seen.get(entry.path);
        if (previous?.generation === entry.generation) continue;
        events.push({
          kind: "written",
          path: entry.path,
          generation: entry.generation,
          authorId: entry.authorId,
          groupId: entry.groupId,
          timestamp: entry.updatedAt,
        });
      }

      if (!complete) {
        // Page-limited or ambiguous snapshot: only fold in observed entries;
        // never synthesize deletes since absent paths may live on a later
        // page or come from a server that ignores cursor pagination.
        for (const [path, entry] of observed) seen.set(path, entry);
        return events;
      }

      for (const [path, previous] of seen) {
        if (observed.has(path)) continue;
        events.push({
          kind: "deleted",
          path: previous.path,
          generation: previous.generation,
          authorId: previous.authorId,
          groupId: previous.groupId,
          timestamp: new Date().toISOString(),
        });
      }

      seen = observed;
      return events;
    },
    clear() {
      seen = new Map();
    },
  };
}
