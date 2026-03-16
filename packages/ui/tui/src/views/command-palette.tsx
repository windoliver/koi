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
  /** Required server capability — command hidden when absent. */
  readonly requiredCapability?: string;
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
  { id: "sources-add", label: "/sources add", description: "Re-scan environment for new data sources" },
  { id: "sources-approve", label: "/sources approve", description: "Approve a pending data source" },
  { id: "sources-schema", label: "/sources schema", description: "View data source schema" },
  { id: "logs", label: "/logs", description: "Show agent lifecycle events" },
  { id: "health", label: "/health", description: "Check server health" },
  {
    id: "open-browser",
    label: "/open-browser",
    description: "Open agent in browser admin panel",
    shortcut: "Ctrl+O",
  },
  { id: "split-panes", label: "/split", description: "Toggle agent split-pane terminal view" },
  { id: "skills", label: "/skills", description: "Show installed skills" },
  { id: "channels", label: "/channels", description: "Show channel connections" },
  { id: "system", label: "/system", description: "Show system metrics and events" },
  { id: "nexus", label: "/nexus", description: "Show Nexus file/namespace events", shortcut: "Ctrl+F" },
  { id: "gateway", label: "/gateway", description: "Show gateway topology" },
  { id: "middleware", label: "/middleware", description: "Show middleware chain for active agent" },
  { id: "temporal", label: "/temporal", description: "Show Temporal workflows", requiredCapability: "temporal" },
  { id: "scheduler", label: "/scheduler", description: "Show scheduler tasks and schedules", requiredCapability: "scheduler" },
  { id: "taskboard", label: "/taskboard", description: "Show task board DAG", requiredCapability: "taskboard" },
  { id: "harness", label: "/harness", description: "Show harness status", requiredCapability: "harness" },
  { id: "cost", label: "/cost", description: "Show cost and token usage" },
  { id: "processtree", label: "/proctree", description: "Show agent process tree" },
  { id: "agentprocfs", label: "/procfs", description: "Show agent runtime state (procfs)" },
  { id: "governance", label: "/governance", description: "Show governance approvals and violations", requiredCapability: "governance" },
  { id: "delegation", label: "/delegation", description: "Show delegation chain for active agent" },
  { id: "handoffs", label: "/handoffs", description: "Show handoff envelopes for active agent" },
  { id: "mailbox", label: "/mailbox", description: "Show agent message inbox" },
  { id: "scratchpad", label: "/scratchpad", description: "Browse shared scratchpad entries" },
  { id: "files", label: "/files", description: "Browse Nexus file system", shortcut: "Ctrl+F" },
  { id: "tree", label: "/tree", description: "Toggle agent list tree view" },
  { id: "quit", label: "/quit", description: "Exit TUI", shortcut: "q" },
] as const;

/** Filter commands by server capabilities. */
export function filterCommandsByCapabilities(
  commands: readonly PaletteCommand[],
  capabilities: import("../state/domain-types.js").TuiCapabilities | null,
): readonly PaletteCommand[] {
  return commands.filter((cmd) => {
    if (cmd.requiredCapability === undefined) return true;
    if (capabilities === null) return false;
    return (capabilities as unknown as Readonly<Record<string, boolean>>)[cmd.requiredCapability] === true;
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
