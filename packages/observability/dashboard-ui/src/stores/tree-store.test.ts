import { beforeEach, describe, expect, test } from "bun:test";
import type { FsEntry } from "../lib/api-client.js";
import { useTreeStore } from "./tree-store.js";

describe("tree-store", () => {
  beforeEach(() => {
    useTreeStore.setState({
      expanded: new Set<string>(),
      selectedPath: null,
      selectedIsDirectory: false,
      lastInvalidatedAt: 0,
      childrenCache: new Map<string, readonly FsEntry[]>(),
    });
  });

  test("toggleExpanded adds path when not present", () => {
    useTreeStore.getState().toggleExpanded("/agents");
    expect(useTreeStore.getState().expanded.has("/agents")).toBe(true);
  });

  test("toggleExpanded removes path when present", () => {
    useTreeStore.getState().toggleExpanded("/agents");
    useTreeStore.getState().toggleExpanded("/agents");
    expect(useTreeStore.getState().expanded.has("/agents")).toBe(false);
  });

  test("setExpanded opens a path", () => {
    useTreeStore.getState().setExpanded("/foo", true);
    expect(useTreeStore.getState().expanded.has("/foo")).toBe(true);
  });

  test("setExpanded closes a path", () => {
    useTreeStore.getState().toggleExpanded("/foo");
    useTreeStore.getState().setExpanded("/foo", false);
    expect(useTreeStore.getState().expanded.has("/foo")).toBe(false);
  });

  test("expandAll adds multiple paths", () => {
    useTreeStore.getState().expandAll(["/a", "/b", "/c"]);
    const { expanded } = useTreeStore.getState();
    expect(expanded.has("/a")).toBe(true);
    expect(expanded.has("/b")).toBe(true);
    expect(expanded.has("/c")).toBe(true);
  });

  test("collapseAll clears all expanded", () => {
    useTreeStore.getState().expandAll(["/a", "/b"]);
    useTreeStore.getState().collapseAll();
    expect(useTreeStore.getState().expanded.size).toBe(0);
  });

  test("select sets selectedPath", () => {
    useTreeStore.getState().select("/agents/a1/manifest.json");
    expect(useTreeStore.getState().selectedPath).toBe("/agents/a1/manifest.json");
  });

  test("select null clears selection", () => {
    useTreeStore.getState().select("/foo");
    useTreeStore.getState().select(null);
    expect(useTreeStore.getState().selectedPath).toBeNull();
  });

  test("invalidateTree updates timestamp", () => {
    const before = useTreeStore.getState().lastInvalidatedAt;
    useTreeStore.getState().invalidateTree();
    expect(useTreeStore.getState().lastInvalidatedAt).toBeGreaterThan(before);
  });

  test("invalidateTree clears children cache", () => {
    const entries: readonly FsEntry[] = [{ name: "a.txt", path: "/a.txt", isDirectory: false }];
    useTreeStore.getState().setChildren("/test", entries);
    expect(useTreeStore.getState().childrenCache.size).toBe(1);
    useTreeStore.getState().invalidateTree();
    expect(useTreeStore.getState().childrenCache.size).toBe(0);
  });

  test("setChildren caches entries for a path", () => {
    const entries: readonly FsEntry[] = [
      { name: "child1", path: "/dir/child1", isDirectory: false },
      { name: "child2", path: "/dir/child2", isDirectory: true },
    ];
    useTreeStore.getState().setChildren("/dir", entries);
    const cached = useTreeStore.getState().childrenCache.get("/dir");
    expect(cached).toEqual(entries);
  });

  test("setChildren does not mutate previous cache", () => {
    const entries1: readonly FsEntry[] = [{ name: "a", path: "/a", isDirectory: false }];
    const entries2: readonly FsEntry[] = [{ name: "b", path: "/b", isDirectory: false }];
    useTreeStore.getState().setChildren("/dir1", entries1);
    const cacheBefore = useTreeStore.getState().childrenCache;
    useTreeStore.getState().setChildren("/dir2", entries2);
    const cacheAfter = useTreeStore.getState().childrenCache;

    // Previous cache reference should be different (immutable update)
    expect(cacheBefore).not.toBe(cacheAfter);
    expect(cacheAfter.size).toBe(2);
  });

  test("clearChildrenCache empties the cache", () => {
    const entries: readonly FsEntry[] = [{ name: "a", path: "/a", isDirectory: false }];
    useTreeStore.getState().setChildren("/dir", entries);
    useTreeStore.getState().clearChildrenCache();
    expect(useTreeStore.getState().childrenCache.size).toBe(0);
  });
});
