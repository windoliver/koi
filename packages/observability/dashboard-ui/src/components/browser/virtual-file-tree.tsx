/**
 * VirtualFileTree — virtualized file tree using @tanstack/react-virtual.
 *
 * Flattens the visible tree (respecting expanded state) into an array,
 * then renders only the visible rows. Preserves keyboard navigation,
 * context menus, and lazy directory loading from the original FileTreeNode.
 */

import type { Virtualizer } from "@tanstack/react-virtual";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useRef } from "react";
import type { FlatTreeItem } from "../../hooks/use-flat-tree.js";
import { useFlatTree } from "../../hooks/use-flat-tree.js";
import { useFileTree } from "../../hooks/use-file-tree.js";
import type { FsEntry } from "../../lib/api-client.js";
import { useTreeStore } from "../../stores/tree-store.js";
import { useViewStore } from "../../stores/view-store.js";
import { VirtualTreeRow } from "./virtual-tree-row.js";

/** Fixed row height in pixels. */
const ROW_HEIGHT = 28;

/** Sorts entries: directories first, then alphabetically. */
function sortEntries(entries: readonly FsEntry[]): readonly FsEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function VirtualFileTree(): React.ReactElement {
  const activeView = useViewStore((s) => s.activeView);
  const expanded = useTreeStore((s) => s.expanded);
  const childrenCache = useTreeStore((s) => s.childrenCache);

  // Load root sections — use conditional spread to satisfy exactOptionalPropertyTypes
  const globPattern = activeView.globPattern;
  const rootSections: readonly { readonly path: string; readonly globPattern?: string }[] =
    activeView.rootPaths.map((rootPath) =>
      globPattern !== undefined
        ? { path: rootPath, globPattern } as const
        : { path: rootPath } as const,
    );

  return (
    <div data-tree-root className="flex-1 overflow-hidden">
      <VirtualFileTreeInner
        rootSections={rootSections}
        expanded={expanded}
        childrenCache={childrenCache}
      />
    </div>
  );
}

function VirtualFileTreeInner({
  rootSections,
  expanded,
  childrenCache,
}: {
  readonly rootSections: readonly { readonly path: string; readonly globPattern?: string }[];
  readonly expanded: ReadonlySet<string>;
  readonly childrenCache: ReadonlyMap<string, readonly FsEntry[]>;
}): React.ReactElement {
  const parentRef = useRef<HTMLDivElement>(null);
  const setExpanded = useTreeStore((s) => s.setExpanded);
  const toggleExpanded = useTreeStore((s) => s.toggleExpanded);
  const select = useTreeStore((s) => s.select);

  // Fetch root entries for each section
  const rootEntries = useRootEntries(rootSections);

  // Flatten visible tree
  const flatItems = useFlatTree(rootEntries, expanded, childrenCache);

  // Trigger lazy loads for expanded dirs that need data
  useLazyDirectoryLoader(flatItems);

  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
      const item = flatItems[index];
      if (item === undefined) return;

      switch (e.key) {
        case "Enter": {
          if (item.isDirectory) {
            toggleExpanded(item.path);
          }
          select(item.path, item.isDirectory);
          e.preventDefault();
          break;
        }

        case "ArrowRight": {
          if (item.isDirectory) {
            if (!item.isExpanded) {
              setExpanded(item.path, true);
            } else {
              // Move focus to first child (next item in flat list)
              focusTreeNodeAtIndex(parentRef.current, index + 1, virtualizer);
            }
          }
          e.preventDefault();
          break;
        }

        case "ArrowLeft": {
          if (item.isDirectory && item.isExpanded) {
            setExpanded(item.path, false);
          } else {
            // Move to parent: find the nearest item at depth - 1
            const parentIndex = findParentIndex(flatItems, index);
            if (parentIndex >= 0) {
              focusTreeNodeAtIndex(parentRef.current, parentIndex, virtualizer);
            }
          }
          e.preventDefault();
          break;
        }

        case "ArrowDown": {
          focusTreeNodeAtIndex(parentRef.current, index + 1, virtualizer);
          e.preventDefault();
          break;
        }

        case "ArrowUp": {
          focusTreeNodeAtIndex(parentRef.current, index - 1, virtualizer);
          e.preventDefault();
          break;
        }

        default:
          break;
      }
    },
    [flatItems, toggleExpanded, setExpanded, select, virtualizer],
  );

  if (flatItems.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-[var(--color-muted)] italic">
        No files to display
      </div>
    );
  }

  return (
    <div
      ref={parentRef}
      className="h-full overflow-y-auto py-1"
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = flatItems[virtualRow.index];
          if (item === undefined) return null;

          return (
            <div
              key={item.path}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <VirtualTreeRow
                item={item}
                index={virtualRow.index}
                onKeyDown={handleKeyDown}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Fetches root entries for each root section path, returning sorted arrays.
 */
function useRootEntries(
  sections: readonly { readonly path: string; readonly globPattern?: string }[],
): readonly (readonly FsEntry[])[] {
  // We fetch each section individually using useFileTree.
  // Since hooks can't be called conditionally, we always fetch all sections.
  // For simplicity and to avoid dynamic hook counts, we use a single component
  // that manages the data. We collect results here.
  //
  // Due to the Rules of Hooks (no conditional/dynamic calls), we limit
  // to a maximum of 4 root sections which should be more than enough.
  const g0 = sections[0]?.globPattern;
  const g1 = sections[1]?.globPattern;
  const g2 = sections[2]?.globPattern;
  const g3 = sections[3]?.globPattern;

  const s0 = useFileTree(sections[0]?.path ?? "/",
    sections.length > 0
      ? g0 !== undefined ? { enabled: true, glob: g0 } : { enabled: true }
      : { enabled: false },
  );
  const s1 = useFileTree(sections[1]?.path ?? "/",
    sections.length > 1
      ? g1 !== undefined ? { enabled: true, glob: g1 } : { enabled: true }
      : { enabled: false },
  );
  const s2 = useFileTree(sections[2]?.path ?? "/",
    sections.length > 2
      ? g2 !== undefined ? { enabled: true, glob: g2 } : { enabled: true }
      : { enabled: false },
  );
  const s3 = useFileTree(sections[3]?.path ?? "/",
    sections.length > 3
      ? g3 !== undefined ? { enabled: true, glob: g3 } : { enabled: true }
      : { enabled: false },
  );

  const results = [s0, s1, s2, s3];
  const sorted: (readonly FsEntry[])[] = [];

  for (let i = 0; i < sections.length && i < results.length; i++) {
    const r = results[i];
    if (r === undefined) break;
    sorted.push(sortEntries(r.entries));
  }

  return sorted;
}

/**
 * Triggers lazy fetches for expanded directories whose children aren't cached.
 */
function useLazyDirectoryLoader(flatItems: readonly FlatTreeItem[]): void {
  const setChildren = useTreeStore((s) => s.setChildren);
  const childrenCache = useTreeStore((s) => s.childrenCache);
  const globPattern = useViewStore((s) => s.activeView.globPattern);
  const lastInvalidatedAt = useTreeStore((s) => s.lastInvalidatedAt);

  // Collect paths that need loading
  const pathsToLoad = flatItems
    .filter((item) => item.needsLoad && !childrenCache.has(item.path))
    .map((item) => item.path);

  // Clear cached children when the glob filter changes so stale entries
  // from the previous view don't persist.
  const clearChildrenCache = useTreeStore((s) => s.clearChildrenCache);
  const prevGlobRef = useRef(globPattern);
  useEffect(() => {
    if (prevGlobRef.current !== globPattern) {
      prevGlobRef.current = globPattern;
      clearChildrenCache();
    }
  }, [globPattern, clearChildrenCache]);

  useEffect(() => {
    if (pathsToLoad.length === 0) return;

    // Dynamically import the API to avoid circular deps
    const loadChildren = async (path: string): Promise<void> => {
      const { fetchFsList } = await import("../../lib/api-client.js");
      const entries = await fetchFsList(
        path,
        globPattern !== undefined ? { glob: globPattern } : undefined,
      );
      setChildren(path, sortEntries(entries));
    };

    for (const path of pathsToLoad) {
      void loadChildren(path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathsToLoad.join(","), lastInvalidatedAt, globPattern]);
}

/** Find the parent node index (nearest item at depth - 1 before current). */
function findParentIndex(
  items: readonly FlatTreeItem[],
  currentIndex: number,
): number {
  const current = items[currentIndex];
  if (current === undefined || current.depth === 0) return -1;

  for (let i = currentIndex - 1; i >= 0; i--) {
    const candidate = items[i];
    if (candidate !== undefined && candidate.depth === current.depth - 1) {
      return i;
    }
  }
  return -1;
}

/** Focus a tree node button at a given flat index, scrolling into view if needed. */
function focusTreeNodeAtIndex(
  container: HTMLElement | null,
  index: number,
  virtualizer?: Virtualizer<HTMLDivElement, Element>,
): void {
  if (container === null || index < 0) return;

  // Try to focus immediately (element is already in the virtual window)
  const button = container.querySelector<HTMLButtonElement>(
    `button[data-tree-index="${index}"]`,
  );
  if (button !== null) {
    button.focus();
    return;
  }

  // Element is outside the virtual window — scroll it into view first
  if (virtualizer !== undefined) {
    virtualizer.scrollToIndex(index, { align: "auto" });
    // Wait for the virtualizer to render the row, then focus
    requestAnimationFrame(() => {
      const el = container.querySelector<HTMLButtonElement>(
        `button[data-tree-index="${index}"]`,
      );
      el?.focus();
    });
  }
}
