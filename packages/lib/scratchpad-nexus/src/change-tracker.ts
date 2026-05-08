import type { ScratchpadChangeEvent, ScratchpadEntrySummary } from "@koi/core";

export interface ChangeTracker {
  /**
   * Diff the latest snapshot against the previously-seen state and return
   * change events. Pass `complete: false` when the snapshot is page-limited
   * or otherwise non-exhaustive: in that case missing paths are *not* treated
   * as deletes (they may simply be on a later page) and previously-seen
   * entries are retained so the next exhaustive poll can detect them.
   *
   * The first snapshot after construction is treated as the baseline and
   * does NOT emit `written` events for entries that already exist when the
   * subscriber first attaches — matching scratchpad-local's contract that
   * subscribers only observe writes/deletes that happen AFTER subscription.
   * This avoids replaying historical state to a watcher that just connected
   * to a non-empty group, which would otherwise duplicate downstream work,
   * notifications, or reconciliation logic.
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
  let primed = false;

  return {
    nextEvents(entries, options) {
      const complete = options?.complete ?? true;
      const observed = new Map<string, ScratchpadEntrySummary>();
      for (const entry of entries) observed.set(entry.path, entry);

      // First snapshot: prime `seen` from current state without emitting
      // any events. Only mark the tracker as primed once we have an
      // exhaustive snapshot, otherwise a partial first page would leave
      // entries from later pages stranded and synthesize spurious deletes
      // on the next exhaustive poll.
      if (!primed) {
        for (const [path, entry] of observed) seen.set(path, entry);
        if (complete) primed = true;
        return [];
      }

      const events: ScratchpadChangeEvent[] = [];
      for (const entry of entries) {
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
      primed = false;
    },
  };
}
