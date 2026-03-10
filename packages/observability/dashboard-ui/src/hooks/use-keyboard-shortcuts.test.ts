import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { useThemeStore } from "../stores/theme-store.js";
import { FOCUS_SEARCH_EVENT, useKeyboardShortcuts } from "./use-keyboard-shortcuts.js";

describe("use-keyboard-shortcuts", () => {
  beforeEach(() => {
    useThemeStore.setState({ theme: "dark", resolvedTheme: "dark" });
  });

  afterEach(() => {
    localStorage.clear();
  });

  test("Ctrl+K dispatches focus-search custom event", () => {
    renderHook(() => useKeyboardShortcuts());

    const handler = mock(() => {});
    document.addEventListener(FOCUS_SEARCH_EVENT, handler);

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        ctrlKey: true,
        bubbles: true,
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    document.removeEventListener(FOCUS_SEARCH_EVENT, handler);
  });

  test("Cmd+K dispatches focus-search custom event", () => {
    renderHook(() => useKeyboardShortcuts());

    const handler = mock(() => {});
    document.addEventListener(FOCUS_SEARCH_EVENT, handler);

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        metaKey: true,
        bubbles: true,
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    document.removeEventListener(FOCUS_SEARCH_EVENT, handler);
  });

  test("Escape calls onCloseDrawer when drawer is open", () => {
    const onCloseDrawer = mock(() => {});
    renderHook(() => useKeyboardShortcuts({ drawerOpen: true, onCloseDrawer }));

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(onCloseDrawer).toHaveBeenCalledTimes(1);
  });

  test("Escape does not call onCloseDrawer when drawer is closed", () => {
    const onCloseDrawer = mock(() => {});
    renderHook(() => useKeyboardShortcuts({ drawerOpen: false, onCloseDrawer }));

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(onCloseDrawer).toHaveBeenCalledTimes(0);
  });

  test("Ctrl+Shift+T toggles theme", () => {
    useThemeStore.getState().setTheme("dark");

    renderHook(() => useKeyboardShortcuts());

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "T",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );

    expect(useThemeStore.getState().theme).toBe("light");
  });
});
