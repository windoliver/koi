/**
 * Help overlay — shows keybindings for the current view.
 *
 * Reads from the command registry so it stays in sync automatically.
 * Press ? or Esc to dismiss.
 */

import type { CommandMeta } from "../command-registry.js";
import { getViewCommands, GLOBAL_COMMANDS } from "../command-registry.js";
import { PanelChrome } from "../components/panel-chrome.js";
import type { TuiView } from "../state/types.js";
import { COLORS } from "../theme.js";

/** Props for the help overlay. */
export interface HelpViewProps {
  /** The view that was active before help was opened. */
  readonly currentView: TuiView;
}

/** Navigation keys shown for all views. */
const NAVIGATION_HINTS: readonly { readonly key: string; readonly description: string }[] = [
  { key: "j / k", description: "Navigate / scroll" },
  { key: "Esc", description: "Go back" },
  { key: "Enter", description: "Select / confirm" },
  { key: "+", description: "Cycle zoom level" },
  { key: "?", description: "Toggle this help" },
] as const;

/** Format a command into a key-description pair. */
function formatCommand(cmd: CommandMeta): { readonly key: string; readonly description: string } {
  const key = cmd.ctrlShortcut ?? cmd.shortcut ?? cmd.label;
  return { key, description: cmd.description };
}

/** Render a section with a header and key-description rows. */
function HelpSection(props: {
  readonly title: string;
  readonly items: readonly { readonly key: string; readonly description: string }[];
}): React.ReactNode {
  if (props.items.length === 0) return null;
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={COLORS.cyan}><b>{`  ${props.title}`}</b></text>
      {props.items.map((item, i) => (
        <box key={i} flexDirection="row" paddingLeft={2}>
          <text fg={COLORS.accent}>{`  ${item.key.padEnd(14)}`}</text>
          <text fg={COLORS.dim}>{item.description}</text>
        </box>
      ))}
    </box>
  );
}

/** Help overlay component. */
export function HelpView({ currentView }: HelpViewProps): React.ReactNode {
  const viewCommands = getViewCommands(currentView);

  // View-specific action shortcuts (commands with a shortcut key)
  const actionItems = viewCommands.commands
    .filter((cmd) => cmd.shortcut !== undefined)
    .map(formatCommand);

  // Global Ctrl shortcuts
  const globalItems = GLOBAL_COMMANDS
    .filter((cmd) => cmd.ctrlShortcut !== undefined)
    .map(formatCommand);

  const viewLabel = currentView === "agents" ? "Agent List"
    : currentView === "console" ? "Console"
    : currentView === "forge" ? "Forge"
    : currentView;

  return (
    <PanelChrome title={`Help - ${viewLabel}`} focused={true}>
      <box flexDirection="column" paddingLeft={1}>
        <HelpSection title="NAVIGATION" items={NAVIGATION_HINTS} />
        {actionItems.length > 0 && (
          <HelpSection title="ACTIONS" items={actionItems} />
        )}
        <HelpSection title="GLOBAL" items={globalItems} />

        <box marginTop={2} paddingLeft={2}>
          <text fg={COLORS.dim}>{"  Press ? or Esc to close"}</text>
        </box>
      </box>
    </PanelChrome>
  );
}
