/**
 * Command palette — derives command list from the unified registry.
 *
 * The TUI app renders these using OpenTUI's dialog/select system.
 */

import { ALL_COMMANDS, type CommandMeta } from "../command-registry.js";

/** A command available in the palette (derived from CommandMeta). */
export interface PaletteCommand {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Keyboard shortcut hint (e.g., "Ctrl+R"). */
  readonly shortcut?: string;
  /** Required server capability — command hidden when absent. */
  readonly requiredCapability?: string;
}

/** Callbacks for palette interactions. */
export interface PaletteCallbacks {
  readonly onSelect: (commandId: string) => void;
  readonly onCancel: () => void;
}

/** Map a CommandMeta to a PaletteCommand (adapts ctrlShortcut to shortcut). */
function metaToPalette(cmd: CommandMeta): PaletteCommand {
  return {
    id: cmd.id,
    label: cmd.label,
    description: cmd.description,
    shortcut: cmd.ctrlShortcut ?? cmd.shortcut,
    requiredCapability: cmd.requiredCapability,
  };
}

/** Default commands available in the command palette (derived from registry). */
export const DEFAULT_COMMANDS: readonly PaletteCommand[] = ALL_COMMANDS.map(metaToPalette);

/** Filter commands by server capabilities. */
export function filterCommandsByCapabilities(
  commands: readonly PaletteCommand[],
  capabilities: import("../state/domain-types.js").TuiCapabilities | null,
): readonly PaletteCommand[] {
  return commands.filter((cmd) => {
    if (cmd.requiredCapability === undefined) return true;
    if (capabilities === null) return false;
    return (
      (capabilities as unknown as Readonly<Record<string, boolean>>)[cmd.requiredCapability] ===
      true
    );
  });
}

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
