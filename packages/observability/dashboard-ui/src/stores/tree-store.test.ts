import { beforeEach, describe, expect, test } from "bun:test";
import { useTreeStore } from "./tree-store.js";

describe("tree-store", () => {
  beforeEach(() => {
    useTreeStore.setState({
      expanded: new Set<string>(),
      selectedPath: null,
      lastInvalidatedAt: 0,
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
});
