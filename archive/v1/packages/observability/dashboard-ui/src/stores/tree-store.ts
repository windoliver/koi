/**
 * File tree Zustand store — tracks expanded/collapsed and selected state.
 *
 * Source of truth for the browser shell's tree sidebar.
 * SSE nexus events trigger tree refreshes via invalidation.
 * Also caches loaded directory children for the virtualized flat tree.
 */

import { create } from "zustand";
import type { FsEntry } from "../lib/api-client.js";

export interface TreeStoreState {
  /** Set of expanded directory paths. */
  readonly expanded: ReadonlySet<string>;
  /** Currently selected file/directory path, or null. */
  readonly selectedPath: string | null;
  /** Whether the currently selected path is a directory. */
  readonly selectedIsDirectory: boolean;
  /** Monotonic timestamp of last tree data invalidation (triggers refetch). */
  readonly lastInvalidatedAt: number;
  /** Cache of loaded directory children (path -> sorted entries). */
  readonly childrenCache: ReadonlyMap<string, readonly FsEntry[]>;

  readonly toggleExpanded: (path: string) => void;
  readonly setExpanded: (path: string, open: boolean) => void;
  readonly expandAll: (paths: readonly string[]) => void;
  readonly collapseAll: () => void;
  readonly select: (path: string | null, isDirectory?: boolean) => void;
  /** Expand parent directories and select a path (used for deep-linking). */
  readonly selectPath: (path: string, isDirectory?: boolean) => void;
  readonly invalidateTree: () => void;
  readonly setChildren: (path: string, entries: readonly FsEntry[]) => void;
  readonly clearChildrenCache: () => void;
}

export const useTreeStore = create<TreeStoreState>((set) => ({
  expanded: new Set<string>(),
  selectedPath: null,
  selectedIsDirectory: false,
  lastInvalidatedAt: 0,
  childrenCache: new Map<string, readonly FsEntry[]>(),

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

  select: (path, isDirectory) =>
    set({ selectedPath: path, selectedIsDirectory: isDirectory === true }),

  selectPath: (path, isDirectory) =>
    set((state) => {
      const segments = path.split("/").filter((p) => p.length > 0);
      const parentPaths = segments
        .slice(0, -1)
        .map((_, idx) => `/${segments.slice(0, idx + 1).join("/")}`);
      const next = new Set(state.expanded);
      for (const p of parentPaths) {
        next.add(p);
      }
      return {
        expanded: next,
        selectedPath: path,
        selectedIsDirectory: isDirectory === true,
      };
    }),

  invalidateTree: () =>
    set({
      lastInvalidatedAt: Date.now(),
      childrenCache: new Map<string, readonly FsEntry[]>(),
    }),

  setChildren: (path, entries) =>
    set((state) => {
      const next = new Map(state.childrenCache);
      next.set(path, entries);
      return { childrenCache: next };
    }),

  clearChildrenCache: () => set({ childrenCache: new Map<string, readonly FsEntry[]>() }),
}));
