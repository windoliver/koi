/**
 * Command palette — Ctrl+P overlay for slash commands.
 *
 * Shows a filtered list of available commands. Renders as a centered
 * overlay using pi-tui's overlay system.
 */

import { type SelectItem, SelectList } from "@mariozechner/pi-tui";
import { KOI_SELECT_THEME } from "../theme.js";

/** A command available in the palette. */
export interface PaletteCommand {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Keyboard shortcut hint (e.g., "Ctrl+R"). */
  readonly shortcut?: string;
}

/** Callbacks for palette interactions. */
export interface PaletteCallbacks {
  readonly onSelect: (commandId: string) => void;
  readonly onCancel: () => void;
}

/** Maximum visible items in the palette. */
const PALETTE_MAX_VISIBLE = 12;

/** Default commands available in the command palette. */
export const DEFAULT_COMMANDS: readonly PaletteCommand[] = [
  { id: "agents", label: "/agents", description: "Switch to agent list view" },
  { id: "attach", label: "/attach", description: "Attach to an agent by name" },
  { id: "dispatch", label: "/dispatch", description: "Dispatch a new agent" },
  { id: "refresh", label: "/refresh", description: "Refresh agent list", shortcut: "Ctrl+R" },
  { id: "suspend", label: "/suspend", description: "Suspend current agent" },
  { id: "resume", label: "/resume", description: "Resume suspended agent" },
  { id: "terminate", label: "/terminate", description: "Terminate current agent" },
  { id: "cancel", label: "/cancel", description: "Cancel active stream" },
  { id: "sessions", label: "/sessions", description: "Browse agent sessions" },
  { id: "logs", label: "/logs", description: "Show agent lifecycle events" },
  { id: "health", label: "/health", description: "Check server health" },
  {
    id: "open-browser",
    label: "/open-browser",
    description: "Open agent in browser admin panel",
    shortcut: "Ctrl+O",
  },
  { id: "quit", label: "/quit", description: "Exit TUI", shortcut: "q" },
] as const;

/** Create a command palette overlay component. */
export function createCommandPalette(
  callbacks: PaletteCallbacks,
  commands: readonly PaletteCommand[] = DEFAULT_COMMANDS,
): {
  readonly component: SelectList;
  readonly reset: () => void;
} {
  const items: readonly SelectItem[] = commands.map((cmd) => ({
    value: cmd.id,
    label: cmd.label,
    description:
      cmd.shortcut !== undefined ? `${cmd.description}  (${cmd.shortcut})` : cmd.description,
  }));

  const list = new SelectList([...items], PALETTE_MAX_VISIBLE, KOI_SELECT_THEME);

  list.onSelect = (item: SelectItem) => {
    callbacks.onSelect(item.value);
  };

  list.onCancel = () => {
    callbacks.onCancel();
  };

  function reset(): void {
    list.setFilter("");
    list.setSelectedIndex(0);
    list.invalidate();
  }

  return { component: list, reset };
}
