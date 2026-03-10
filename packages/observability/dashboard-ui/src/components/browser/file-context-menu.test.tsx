/**
 * Tests for FileContextMenu component.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "../../__tests__/setup.js";
import { useTreeStore } from "../../stores/tree-store.js";
import { FileContextMenu } from "./file-context-menu.js";

describe("FileContextMenu", () => {
  const onClose = mock(() => {});

  beforeEach(() => {
    onClose.mockClear();
    useTreeStore.setState({
      expanded: new Set<string>(),
      selectedPath: null,
      lastInvalidatedAt: 0,
    });
    cleanup();
  });

  test("renders menu items for a file", () => {
    render(
      <FileContextMenu
        x={100}
        y={200}
        path="/test/file.ts"
        isDirectory={false}
        onClose={onClose}
      />,
    );

    expect(screen.getByText("Open")).toBeDefined();
    expect(screen.getByText("Copy Path")).toBeDefined();
    expect(screen.getByText("Refresh")).toBeDefined();
    expect(screen.getByText("Delete")).toBeDefined();
  });

  test("does not render Open for directories", () => {
    render(
      <FileContextMenu
        x={100}
        y={200}
        path="/test/dir"
        isDirectory={true}
        onClose={onClose}
      />,
    );

    expect(screen.queryByText("Open")).toBeNull();
    expect(screen.getByText("Copy Path")).toBeDefined();
    expect(screen.getByText("Refresh")).toBeDefined();
    expect(screen.getByText("Delete")).toBeDefined();
  });

  test("closes on Escape key", () => {
    render(
      <FileContextMenu
        x={100}
        y={200}
        path="/test/file.ts"
        isDirectory={false}
        onClose={onClose}
      />,
    );

    // Use the KeyboardEvent constructor from happy-dom's window
    const KBEvent = (globalThis.window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
    document.dispatchEvent(new KBEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("clicking Copy Path calls onClose", () => {
    // Mock clipboard API via defineProperty (navigator is read-only)
    const writeText = mock(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });

    render(
      <FileContextMenu
        x={100}
        y={200}
        path="/test/file.ts"
        isDirectory={false}
        onClose={onClose}
      />,
    );

    screen.getByText("Copy Path").click();
    expect(writeText).toHaveBeenCalledWith("/test/file.ts");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("clicking Refresh invalidates tree and calls onClose", () => {
    render(
      <FileContextMenu
        x={100}
        y={200}
        path="/test/file.ts"
        isDirectory={false}
        onClose={onClose}
      />,
    );

    const before = useTreeStore.getState().lastInvalidatedAt;
    screen.getByText("Refresh").click();
    const after = useTreeStore.getState().lastInvalidatedAt;

    expect(after).toBeGreaterThan(before);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("clicking Open selects file and calls onClose", () => {
    render(
      <FileContextMenu
        x={100}
        y={200}
        path="/test/file.ts"
        isDirectory={false}
        onClose={onClose}
      />,
    );

    screen.getByText("Open").click();
    expect(useTreeStore.getState().selectedPath).toBe("/test/file.ts");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
