/**
 * useFlatTree — flattens visible tree entries for virtualized rendering.
 *
 * Walks root entries and recursively includes children of expanded directories,
 * producing a flat array suitable for `@tanstack/react-virtual`.
 * Entries whose children haven't been fetched yet are marked with `needsLoad`.
 */

import { useMemo } from "react";
import type { FsEntry } from "../lib/api-client.js";

export interface FlatTreeItem {
  readonly entry: FsEntry;
  readonly depth: number;
  readonly isExpanded: boolean;
  readonly isDirectory: boolean;
  readonly path: string;
  /** True when directory is expanded but children haven't been fetched. */
  readonly needsLoad: boolean;
}

/**
 * Flattens visible tree nodes from root entries + expanded set + loaded children map.
 *
 * @param rootEntries - sorted root-level entries per root path section
 * @param expanded - set of expanded directory paths
 * @param childrenMap - map from directory path to its loaded children (sorted)
 */
export function useFlatTree(
  rootEntries: readonly (readonly FsEntry[])[],
  expanded: ReadonlySet<string>,
  childrenMap: ReadonlyMap<string, readonly FsEntry[]>,
): readonly FlatTreeItem[] {
  return useMemo(() => {
    const items: FlatTreeItem[] = [];

    function walk(entries: readonly FsEntry[], depth: number): void {
      for (const entry of entries) {
        const isDir = entry.isDirectory;
        const isExp = isDir && expanded.has(entry.path);
        const children = childrenMap.get(entry.path);
        const needsLoad = isExp && children === undefined;

        items.push({
          entry,
          depth,
          isExpanded: isExp,
          isDirectory: isDir,
          path: entry.path,
          needsLoad,
        });

        if (isExp && children !== undefined) {
          walk(children, depth + 1);
        }
      }
    }

    for (const section of rootEntries) {
      walk(section, 0);
    }

    return items;
  }, [rootEntries, expanded, childrenMap]);
}
