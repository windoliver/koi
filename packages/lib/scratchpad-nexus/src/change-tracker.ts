import type { ScratchpadChangeEvent, ScratchpadEntrySummary } from "../../../kernel/core/src/index.js";

export interface ChangeTracker {
  readonly nextEvents: (entries: readonly ScratchpadEntrySummary[]) => readonly ScratchpadChangeEvent[];
  readonly clear: () => void;
}

export function createChangeTracker(groupId: string): ChangeTracker {
  void groupId;

  let seen = new Map<string, number>();

  return {
    nextEvents(entries) {
      const events: ScratchpadChangeEvent[] = [];
      const nextSeen = new Map<string, number>();

      for (const entry of entries) {
        nextSeen.set(entry.path, entry.generation);
        const previousGeneration = seen.get(entry.path);
        if (previousGeneration === entry.generation) continue;
        events.push({
          kind: "written",
          path: entry.path,
          generation: entry.generation,
          authorId: entry.authorId,
          groupId: entry.groupId,
          timestamp: entry.updatedAt,
        });
      }

      seen = nextSeen;
      return events;
    },
    clear() {
      seen = new Map();
    },
  };
}
