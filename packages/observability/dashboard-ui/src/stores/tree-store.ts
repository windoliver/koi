/**
 * File tree Zustand store — tracks expanded/collapsed and selected state.
 *
 * Source of truth for the browser shell's tree sidebar.
 * SSE nexus events trigger tree refreshes via invalidation.
 */

import { create } from "zustand";

export interface TreeStoreState {
  /** Set of expanded directory paths. */
  readonly expanded: ReadonlySet<string>;
  /** Currently selected file/directory path, or null. */
  readonly selectedPath: string | null;
  /** Monotonic timestamp of last tree data invalidation (triggers refetch). */
  readonly lastInvalidatedAt: number;

  readonly toggleExpanded: (path: string) => void;
  readonly setExpanded: (path: string, open: boolean) => void;
  readonly expandAll: (paths: readonly string[]) => void;
  readonly collapseAll: () => void;
  readonly select: (path: string | null) => void;
  readonly invalidateTree: () => void;
}

export const useTreeStore = create<TreeStoreState>((set) => ({
  expanded: new Set<string>(),
  selectedPath: null,
  lastInvalidatedAt: 0,

  toggleExpanded: (path) =>
    set((state) => {
      const next = new Set(state.expanded);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return { expanded: next };
    }),

  setExpanded: (path, open) =>
    set((state) => {
      const next = new Set(state.expanded);
      if (open) {
        next.add(path);
      } else {
        next.delete(path);
      }
      return { expanded: next };
    }),

  expandAll: (paths) =>
    set((state) => {
      const next = new Set(state.expanded);
      for (const p of paths) {
        next.add(p);
      }
      return { expanded: next };
    }),

  collapseAll: () => set({ expanded: new Set<string>() }),

  select: (path) => set({ selectedPath: path }),

  invalidateTree: () => set({ lastInvalidatedAt: Date.now() }),
}));
