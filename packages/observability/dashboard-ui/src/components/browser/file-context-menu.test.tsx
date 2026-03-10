/**
 * Tests for FileContextMenu component (Radix-based).
 *
 * Radix context menus require pointer events and portals that are
 * difficult to fully simulate in happy-dom, so we focus on verifying
 * the component renders its children correctly and does not crash.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "../../__tests__/setup.js";
import { useTreeStore } from "../../stores/tree-store.js";
import { FileContextMenu } from "./file-context-menu.js";

describe("FileContextMenu", () => {
  beforeEach(() => {
    useTreeStore.setState({
      expanded: new Set<string>(),
      selectedPath: null,
      lastInvalidatedAt: 0,
    });
    cleanup();
  });

  test("renders children for a file entry", () => {
    render(
      <FileContextMenu path="/test/file.ts" isDirectory={false}>
        <button type="button">File Node</button>
      </FileContextMenu>,
    );

    expect(screen.getByText("File Node")).toBeDefined();
  });

  test("renders children for a directory entry", () => {
    render(
      <FileContextMenu path="/test/dir" isDirectory={true}>
        <button type="button">Dir Node</button>
      </FileContextMenu>,
    );

    expect(screen.getByText("Dir Node")).toBeDefined();
  });

  test("renders without crashing when path contains special characters", () => {
    render(
      <FileContextMenu
        path="/test/some file (copy).ts"
        isDirectory={false}
      >
        <span>Special Path</span>
      </FileContextMenu>,
    );

    expect(screen.getByText("Special Path")).toBeDefined();
  });
});
