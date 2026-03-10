/**
 * Tests for the flat tree flattening logic.
 *
 * Extracts the pure flattening function for unit testing without React hooks.
 */

import { describe, expect, test } from "bun:test";
import type { FsEntry } from "../lib/api-client.js";
import type { FlatTreeItem } from "./use-flat-tree.js";

// Replicate the flattening logic as a pure function for testability.
// The hook version wraps this in useMemo.
function flattenTree(
  rootEntries: readonly (readonly FsEntry[])[],
  expanded: ReadonlySet<string>,
  childrenMap: ReadonlyMap<string, readonly FsEntry[]>,
): readonly FlatTreeItem[] {
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
}

function makeEntry(name: string, path: string, isDirectory: boolean): FsEntry {
  return { name, path, isDirectory };
}

describe("flattenTree", () => {
  test("returns empty array for empty roots", () => {
    const result = flattenTree([], new Set(), new Map());
    expect(result).toEqual([]);
  });

  test("flattens root entries at depth 0", () => {
    const roots: readonly FsEntry[] = [
      makeEntry("agents", "/agents", true),
      makeEntry("config.json", "/config.json", false),
    ];
    const result = flattenTree([roots], new Set(), new Map());

    expect(result).toHaveLength(2);
    expect(result[0]?.depth).toBe(0);
    expect(result[0]?.path).toBe("/agents");
    expect(result[0]?.isDirectory).toBe(true);
    expect(result[0]?.isExpanded).toBe(false);
    expect(result[1]?.depth).toBe(0);
    expect(result[1]?.path).toBe("/config.json");
    expect(result[1]?.isDirectory).toBe(false);
  });

  test("includes children of expanded directories", () => {
    const roots: readonly FsEntry[] = [makeEntry("agents", "/agents", true)];
    const expanded = new Set(["/agents"]);
    const children = new Map<string, readonly FsEntry[]>([
      ["/agents", [makeEntry("a1", "/agents/a1", true), makeEntry("a2", "/agents/a2", false)]],
    ]);

    const result = flattenTree([roots], expanded, children);

    expect(result).toHaveLength(3);
    expect(result[0]?.path).toBe("/agents");
    expect(result[0]?.isExpanded).toBe(true);
    expect(result[1]?.path).toBe("/agents/a1");
    expect(result[1]?.depth).toBe(1);
    expect(result[2]?.path).toBe("/agents/a2");
    expect(result[2]?.depth).toBe(1);
  });

  test("marks expanded directories without cached children as needsLoad", () => {
    const roots: readonly FsEntry[] = [makeEntry("agents", "/agents", true)];
    const expanded = new Set(["/agents"]);
    const children = new Map<string, readonly FsEntry[]>();

    const result = flattenTree([roots], expanded, children);

    expect(result).toHaveLength(1);
    expect(result[0]?.needsLoad).toBe(true);
  });

  test("does not include children of collapsed directories", () => {
    const roots: readonly FsEntry[] = [makeEntry("agents", "/agents", true)];
    const expanded = new Set<string>();
    const children = new Map<string, readonly FsEntry[]>([
      ["/agents", [makeEntry("a1", "/agents/a1", false)]],
    ]);

    const result = flattenTree([roots], expanded, children);

    expect(result).toHaveLength(1);
    expect(result[0]?.isExpanded).toBe(false);
  });

  test("handles deeply nested expansion", () => {
    const roots: readonly FsEntry[] = [makeEntry("a", "/a", true)];
    const expanded = new Set(["/a", "/a/b"]);
    const children = new Map<string, readonly FsEntry[]>([
      ["/a", [makeEntry("b", "/a/b", true)]],
      ["/a/b", [makeEntry("c.txt", "/a/b/c.txt", false)]],
    ]);

    const result = flattenTree([roots], expanded, children);

    expect(result).toHaveLength(3);
    expect(result[0]?.depth).toBe(0);
    expect(result[1]?.depth).toBe(1);
    expect(result[2]?.depth).toBe(2);
    expect(result[2]?.path).toBe("/a/b/c.txt");
  });

  test("handles multiple root sections", () => {
    const section1: readonly FsEntry[] = [makeEntry("agents", "/agents", true)];
    const section2: readonly FsEntry[] = [makeEntry("events", "/events", true)];

    const result = flattenTree([section1, section2], new Set(), new Map());

    expect(result).toHaveLength(2);
    expect(result[0]?.path).toBe("/agents");
    expect(result[1]?.path).toBe("/events");
  });

  test("files are never expanded", () => {
    const roots: readonly FsEntry[] = [makeEntry("readme.md", "/readme.md", false)];
    // Even if the path is in expanded set, files should not be expanded
    const expanded = new Set(["/readme.md"]);

    const result = flattenTree([roots], expanded, new Map());

    expect(result).toHaveLength(1);
    expect(result[0]?.isExpanded).toBe(false);
    expect(result[0]?.needsLoad).toBe(false);
  });
});
