/**
 * Global keyboard shortcuts hook.
 *
 * Registers document-level keydown listeners for:
 * - Ctrl/Cmd+K: Focus search (dispatches "koi:focus-search" custom event)
 * - Escape: Close orchestration drawer, then close search
 * - Ctrl/Cmd+Shift+T: Toggle dark/light theme
 */

import { useEffect } from "react";
import { useThemeStore } from "../stores/theme-store.js";

export interface KeyboardShortcutOptions {
  /** Callback to close the orchestration drawer (if open). */
  readonly onCloseDrawer?: () => void;
  /** Whether the orchestration drawer is currently open. */
  readonly drawerOpen?: boolean;
}

/** Custom event name for focusing the command bar search input. */
export const FOCUS_SEARCH_EVENT = "koi:focus-search";

export function useKeyboardShortcuts(options: KeyboardShortcutOptions = {}): void {
  const { onCloseDrawer, drawerOpen = false } = options;
  const toggleTheme = useThemeStore((s) => s.toggle);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const isMod = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      const isInput =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable === true;

      // Ctrl/Cmd+K — focus search (works even in inputs)
      if (isMod && e.key === "k") {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent(FOCUS_SEARCH_EVENT));
        return;
      }

      // Ctrl/Cmd+Shift+T — toggle theme (works even in inputs)
      if (isMod && e.shiftKey && e.key === "T") {
        e.preventDefault();
        toggleTheme();
        return;
      }

      // Skip remaining shortcuts when user is typing in an input
      if (isInput) return;

      // Escape — close drawer first, then let individual components handle it
      if (e.key === "Escape" && drawerOpen) {
        e.preventDefault();
        onCloseDrawer?.();
        return;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [drawerOpen, onCloseDrawer, toggleTheme]);
}
