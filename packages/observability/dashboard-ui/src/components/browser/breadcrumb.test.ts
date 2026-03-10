/**
 * Breadcrumb tests — path segmentation and navigation behavior.
 *
 * Verifies that parent breadcrumb segments always mark selection as a
 * directory (isDirectory=true) so the viewer router shows directory
 * viewers instead of attempting a file read.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { useTreeStore } from "../../stores/tree-store.js";
import { pathSegments } from "./breadcrumb.js";

describe("pathSegments", () => {
  test("splits path into cumulative segments", () => {
    const segs = pathSegments("/agents/a1/events/streams");
    expect(segs).toEqual([
      { label: "agents", path: "/agents" },
      { label: "a1", path: "/agents/a1" },
      { label: "events", path: "/agents/a1/events" },
      { label: "streams", path: "/agents/a1/events/streams" },
    ]);
  });

  test("single segment", () => {
    const segs = pathSegments("/agents");
    expect(segs).toEqual([{ label: "agents", path: "/agents" }]);
  });

  test("handles trailing slash", () => {
    const segs = pathSegments("/agents/a1/");
    expect(segs).toEqual([
      { label: "agents", path: "/agents" },
      { label: "a1", path: "/agents/a1" },
    ]);
  });

  test("empty path returns empty array", () => {
    expect(pathSegments("")).toEqual([]);
    expect(pathSegments("/")).toEqual([]);
  });
});

describe("breadcrumb navigation contract", () => {
  beforeEach(() => {
    useTreeStore.setState({
      expanded: new Set<string>(),
      selectedPath: null,
      selectedIsDirectory: false,
      lastInvalidatedAt: 0,
    });
  });

  test("selecting a parent segment marks it as directory", () => {
    // Simulate: user has a file selected, clicks parent breadcrumb
    useTreeStore.getState().select("/agents/a1/events/streams/s1/events/42.json", false);
    expect(useTreeStore.getState().selectedIsDirectory).toBe(false);

    // Simulate breadcrumb click on "events" parent segment
    // Breadcrumb passes isDirectory=true for all parent segments
    useTreeStore.getState().setExpanded("/agents/a1/events", true);
    useTreeStore.getState().select("/agents/a1/events", true);

    expect(useTreeStore.getState().selectedPath).toBe("/agents/a1/events");
    expect(useTreeStore.getState().selectedIsDirectory).toBe(true);
  });

  test("select without isDirectory defaults to false", () => {
    useTreeStore.getState().select("/agents/a1/manifest.json");
    expect(useTreeStore.getState().selectedIsDirectory).toBe(false);
  });

  test("select with isDirectory=true sets flag correctly", () => {
    useTreeStore.getState().select("/agents/a1/", true);
    expect(useTreeStore.getState().selectedIsDirectory).toBe(true);
  });

  test("select null clears isDirectory", () => {
    useTreeStore.getState().select("/agents/a1/", true);
    useTreeStore.getState().select(null);
    expect(useTreeStore.getState().selectedIsDirectory).toBe(false);
  });
});
