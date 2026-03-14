/**
 * Command palette — command registry for slash commands.
 *
 * Defines the available commands and their metadata.
 * The TUI app renders these using OpenTUI's dialog/select system.
 */

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

/** Default commands available in the command palette. */
export const DEFAULT_COMMANDS: readonly PaletteCommand[] = [
  { id: "agents", label: "/agents", description: "Switch to agent list view" },
  { id: "attach", label: "/attach", description: "Attach to an agent (lists available)" },
  { id: "dispatch", label: "/dispatch", description: "Dispatch a new agent" },
  { id: "refresh", label: "/refresh", description: "Refresh agent list", shortcut: "Ctrl+R" },
  { id: "suspend", label: "/suspend", description: "Suspend current agent" },
  { id: "resume", label: "/resume", description: "Resume suspended agent" },
  { id: "terminate", label: "/terminate", description: "Terminate current agent" },
  { id: "cancel", label: "/cancel", description: "Cancel active stream" },
  { id: "sessions", label: "/sessions", description: "Browse agent sessions" },
  { id: "sources", label: "/sources", description: "Show data source panel" },
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

/** Convert palette commands to select items for OpenTUI Select/DialogSelect. */
export function commandsToSelectItems(
  commands: readonly PaletteCommand[],
): readonly { readonly value: string; readonly label: string; readonly description: string }[] {
  return commands.map((cmd) => ({
    value: cmd.id,
    label: cmd.label,
    description:
      cmd.shortcut !== undefined ? `${cmd.description}  (${cmd.shortcut})` : cmd.description,
  }));
}
