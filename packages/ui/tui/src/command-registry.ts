/**
 * Unified command registry — single source of truth for command metadata.
 *
 * This registry centralizes command labels, shortcuts, categories, and
 * capability/session requirements. It does NOT replace the dispatch
 * mechanism (KeyboardCallbacks + CommandDeps stay separate). Instead,
 * the palette, footer hints, and help screen all derive from this data.
 */

import type { TuiView } from "./state/types.js";

// ─── Types ──────────────────────────────────────────────────────────

/** Command category for palette grouping and help screen sections. */
export type CommandCategory =
  | "navigation"
  | "agent"
  | "session"
  | "monitoring"
  | "infrastructure"
  | "data"
  | "system"
  | "wizard";

/** A single command's metadata. */
export interface CommandMeta {
  /** Unique command ID (matches palette command ID and dispatch key). */
  readonly id: string;
  /** Slash command label shown in palette (e.g., "/agents"). */
  readonly label: string;
  /** One-line description. */
  readonly description: string;
  /** Single-key shortcut within a view (e.g., "a" for approve). */
  readonly shortcut?: string | undefined;
  /** Ctrl-key shortcut (e.g., "Ctrl+R"). */
  readonly ctrlShortcut?: string | undefined;
  /** Palette grouping category. */
  readonly category: CommandCategory;
  /** Required server capability — hidden when absent. */
  readonly requiredCapability?: string | undefined;
  /** Minimum session count for progressive disclosure. */
  readonly minSessionCount?: number | undefined;
  /** Whether this is a destructive operation requiring confirmation. */
  readonly destructive?: boolean | undefined;
}

/** Per-view command set: view-specific shortcuts + their footer hint text. */
export interface ViewCommands {
  /** Commands available in this view (keyboard shortcuts). */
  readonly commands: readonly CommandMeta[];
  /** Pre-built footer hint string for this view. */
  readonly footerHint: string;
}

// ─── Global Commands ────────────────────────────────────────────────
// Available in most/all views (Ctrl shortcuts, zoom, quit).

const GLOBAL_COMMANDS: readonly CommandMeta[] = [
  {
    id: "palette",
    label: "/commands",
    description: "Open command palette",
    ctrlShortcut: "Ctrl+P",
    category: "navigation",
  },
  {
    id: "refresh",
    label: "/refresh",
    description: "Refresh agent list",
    ctrlShortcut: "Ctrl+R",
    category: "system",
  },
  {
    id: "open-browser",
    label: "/open-browser",
    description: "Open agent in browser admin panel",
    ctrlShortcut: "Ctrl+O",
    category: "system",
  },
  {
    id: "forge-toggle",
    label: "/forge",
    description: "Toggle forge view",
    ctrlShortcut: "Ctrl+G",
    category: "monitoring",
  },
  {
    id: "files",
    label: "/files",
    description: "Browse Nexus file system",
    ctrlShortcut: "Ctrl+F",
    category: "data",
  },
  {
    id: "new-session",
    label: "/new-session",
    description: "New session with current agent",
    ctrlShortcut: "Ctrl+N",
    category: "session",
  },
] as const;

// ─── Navigation Commands (palette-only, no shortcut) ────────────────

const NAV_COMMANDS: readonly CommandMeta[] = [
  {
    id: "agents",
    label: "/agents",
    description: "Switch to agent list view",
    category: "navigation",
  },
  { id: "attach", label: "/attach", description: "Attach to an agent", category: "agent" },
  { id: "sessions", label: "/sessions", description: "Browse agent sessions", category: "session" },
  {
    id: "logs",
    label: "/logs",
    description: "Show agent lifecycle events",
    category: "monitoring",
    minSessionCount: 4,
  },
  {
    id: "system",
    label: "/system",
    description: "Show system metrics and events",
    category: "monitoring",
    minSessionCount: 4,
  },
  {
    id: "cost",
    label: "/cost",
    description: "Show cost and token usage",
    category: "monitoring",
    minSessionCount: 4,
  },
  {
    id: "skills",
    label: "/skills",
    description: "Show installed skills",
    category: "monitoring",
    minSessionCount: 4,
  },
  {
    id: "channels",
    label: "/channels",
    description: "Show channel connections",
    category: "monitoring",
    minSessionCount: 4,
  },
  {
    id: "nexus",
    label: "/nexus",
    description: "Show Nexus file/namespace events",
    category: "data",
    minSessionCount: 4,
  },
  { id: "sources", label: "/sources", description: "Show data source panel", category: "data" },
  {
    id: "middleware",
    label: "/middleware",
    description: "Show middleware chain for active agent",
    category: "infrastructure",
    minSessionCount: 11,
  },
  {
    id: "gateway",
    label: "/gateway",
    description: "Show gateway topology",
    category: "infrastructure",
    requiredCapability: "gateway",
    minSessionCount: 11,
  },
  {
    id: "temporal",
    label: "/temporal",
    description: "Show Temporal workflows",
    category: "infrastructure",
    requiredCapability: "temporal",
    minSessionCount: 11,
  },
  {
    id: "scheduler",
    label: "/scheduler",
    description: "Show scheduler tasks and schedules",
    category: "infrastructure",
    requiredCapability: "scheduler",
    minSessionCount: 11,
  },
  {
    id: "taskboard",
    label: "/taskboard",
    description: "Show task board DAG",
    category: "infrastructure",
    requiredCapability: "taskboard",
    minSessionCount: 11,
  },
  {
    id: "harness",
    label: "/harness",
    description: "Show harness status",
    category: "infrastructure",
    requiredCapability: "harness",
    minSessionCount: 11,
  },
  {
    id: "governance",
    label: "/governance",
    description: "Show governance approvals and violations",
    category: "infrastructure",
    requiredCapability: "governance",
    minSessionCount: 11,
  },
  {
    id: "delegation",
    label: "/delegation",
    description: "Show delegation chain for active agent",
    category: "infrastructure",
    minSessionCount: 11,
  },
  {
    id: "handoffs",
    label: "/handoffs",
    description: "Show handoff envelopes for active agent",
    category: "infrastructure",
    minSessionCount: 11,
  },
  {
    id: "mailbox",
    label: "/mailbox",
    description: "Show agent message inbox",
    category: "infrastructure",
    minSessionCount: 11,
  },
  {
    id: "scratchpad",
    label: "/scratchpad",
    description: "Browse shared scratchpad entries",
    category: "data",
    minSessionCount: 11,
  },
  {
    id: "processtree",
    label: "/proctree",
    description: "Show agent process tree",
    category: "monitoring",
    minSessionCount: 11,
  },
  {
    id: "agentprocfs",
    label: "/procfs",
    description: "Show agent runtime state (procfs)",
    category: "monitoring",
    minSessionCount: 11,
  },
  {
    id: "debug",
    label: "/debug",
    description: "Show debug view (package inventory + trace waterfall)",
    category: "monitoring",
    minSessionCount: 11,
  },
] as const;

// ─── Agent Lifecycle Commands ───────────────────────────────────────

const AGENT_COMMANDS: readonly CommandMeta[] = [
  { id: "dispatch", label: "/dispatch", description: "Dispatch a new agent", category: "agent" },
  { id: "suspend", label: "/suspend", description: "Suspend current agent", category: "agent" },
  { id: "resume", label: "/resume", description: "Resume suspended agent", category: "agent" },
  {
    id: "terminate",
    label: "/terminate",
    description: "Terminate current agent",
    category: "agent",
    destructive: true,
  },
  { id: "cancel", label: "/cancel", description: "Cancel active stream", category: "agent" },
] as const;

// ─── Data Source Commands ───────────────────────────────────────────

const DATA_COMMANDS: readonly CommandMeta[] = [
  {
    id: "sources-add",
    label: "/sources add",
    description: "Re-scan environment for new data sources",
    category: "data",
  },
  {
    id: "sources-approve",
    label: "/sources approve",
    description: "Approve a pending data source",
    category: "data",
  },
  {
    id: "sources-schema",
    label: "/sources schema",
    description: "View data source schema",
    category: "data",
  },
] as const;

// ─── Subsystem Action Commands ──────────────────────────────────────

const SUBSYSTEM_COMMANDS: readonly CommandMeta[] = [
  {
    id: "approve",
    label: "/approve",
    description: "Approve selected governance item",
    category: "infrastructure",
    requiredCapability: "governance",
  },
  {
    id: "deny",
    label: "/deny",
    description: "Deny selected governance item",
    category: "infrastructure",
    requiredCapability: "governance",
  },
  {
    id: "workflow-signal",
    label: "/workflow signal",
    description: "Signal selected Temporal workflow",
    category: "infrastructure",
    requiredCapability: "temporal",
  },
  {
    id: "workflow-terminate",
    label: "/workflow terminate",
    description: "Terminate selected Temporal workflow",
    category: "infrastructure",
    requiredCapability: "temporal",
    destructive: true,
  },
  {
    id: "schedule-pause",
    label: "/schedule pause",
    description: "Pause a cron schedule",
    category: "infrastructure",
    requiredCapability: "scheduler",
  },
  {
    id: "schedule-resume",
    label: "/schedule resume",
    description: "Resume a paused schedule",
    category: "infrastructure",
    requiredCapability: "scheduler",
  },
  {
    id: "dlq-retry",
    label: "/dlq retry",
    description: "Retry first dead letter entry",
    category: "infrastructure",
    requiredCapability: "scheduler",
  },
  {
    id: "harness-pause",
    label: "/harness pause",
    description: "Pause the harness",
    category: "infrastructure",
    requiredCapability: "harness",
  },
  {
    id: "harness-resume",
    label: "/harness resume",
    description: "Resume the harness",
    category: "infrastructure",
    requiredCapability: "harness",
  },
] as const;

// ─── System Commands ────────────────────────────────────────────────

const SYSTEM_COMMANDS: readonly CommandMeta[] = [
  { id: "health", label: "/health", description: "Check server health", category: "system" },
  {
    id: "status",
    label: "/status",
    description: "Show detailed subsystem status",
    category: "system",
  },
  { id: "doctor", label: "/doctor", description: "Run diagnostic checks", category: "system" },
  {
    id: "tree",
    label: "/tree",
    description: "Toggle flat list / hierarchy tree view",
    category: "navigation",
  },
  {
    id: "split-panes",
    label: "/split",
    description: "Toggle agent split-pane terminal view",
    category: "navigation",
  },
  {
    id: "demo-init",
    label: "/demo init",
    description: "Initialize a demo pack",
    category: "system",
  },
  {
    id: "demo-list",
    label: "/demo list",
    description: "List available demo packs",
    category: "system",
  },
  {
    id: "demo-reset",
    label: "/demo reset",
    description: "Reset a demo pack",
    category: "system",
    destructive: true,
  },
  { id: "deploy", label: "/deploy", description: "Deploy agent to cloud", category: "system" },
  {
    id: "undeploy",
    label: "/undeploy",
    description: "Remove cloud deployment",
    category: "system",
    destructive: true,
  },
  {
    id: "stop",
    label: "/stop",
    description: "Graceful shutdown of Koi runtime",
    category: "system",
    destructive: true,
  },
  { id: "quit", label: "/quit", description: "Exit TUI", shortcut: "q", category: "system" },
] as const;

// ─── All Palette Commands ───────────────────────────────────────────

/** Every command available in the palette (flat list, pre-categorized). */
export const ALL_COMMANDS: readonly CommandMeta[] = [
  ...GLOBAL_COMMANDS,
  ...NAV_COMMANDS,
  ...AGENT_COMMANDS,
  ...DATA_COMMANDS,
  ...SUBSYSTEM_COMMANDS,
  ...SYSTEM_COMMANDS,
] as const;

// ─── View-Specific Shortcut Registry ────────────────────────────────
// Maps each view to its keyboard shortcuts (for footer hints + help screen).

const VIEW_SHORTCUTS: Readonly<Partial<Record<TuiView, readonly CommandMeta[]>>> = {
  agents: [
    {
      id: "select",
      label: "select",
      description: "Attach to selected agent",
      shortcut: "Enter",
      category: "agent",
    },
    {
      id: "dispatch",
      label: "/dispatch",
      description: "Dispatch a new agent",
      shortcut: "d",
      category: "agent",
    },
    {
      id: "suspend",
      label: "/suspend",
      description: "Suspend agent",
      shortcut: "s",
      category: "agent",
    },
    { id: "quit", label: "/quit", description: "Exit TUI", shortcut: "q", category: "system" },
  ],
  governance: [
    {
      id: "approve",
      label: "/approve",
      description: "Approve selected item",
      shortcut: "a",
      category: "infrastructure",
    },
    {
      id: "deny",
      label: "/deny",
      description: "Deny selected item",
      shortcut: "d",
      category: "infrastructure",
    },
  ],
  forge: [
    {
      id: "forge-promote",
      label: "promote",
      description: "Promote selected brick",
      shortcut: "p",
      category: "monitoring",
    },
    {
      id: "forge-demote",
      label: "demote",
      description: "Demote selected brick",
      shortcut: "d",
      category: "monitoring",
    },
    {
      id: "forge-quarantine",
      label: "quarantine",
      description: "Quarantine selected brick",
      shortcut: "q",
      category: "monitoring",
    },
  ],
  temporal: [
    {
      id: "temporal-detail",
      label: "detail",
      description: "View workflow detail",
      shortcut: "Enter",
      category: "infrastructure",
    },
    {
      id: "workflow-signal",
      label: "/workflow signal",
      description: "Signal workflow",
      shortcut: "s",
      category: "infrastructure",
    },
    {
      id: "workflow-terminate",
      label: "/workflow terminate",
      description: "Terminate workflow",
      shortcut: "t",
      category: "infrastructure",
      destructive: true,
    },
  ],
  scheduler: [
    {
      id: "dlq-retry",
      label: "/dlq retry",
      description: "Retry first dead letter entry",
      shortcut: "r",
      category: "infrastructure",
    },
  ],
  harness: [
    {
      id: "harness-toggle",
      label: "pause/resume",
      description: "Toggle harness pause",
      shortcut: "p",
      category: "infrastructure",
    },
  ],
  datasources: [
    {
      id: "sources-approve",
      label: "approve",
      description: "Approve selected source",
      shortcut: "a",
      category: "data",
    },
    {
      id: "sources-schema",
      label: "schema",
      description: "View source schema",
      shortcut: "s",
      category: "data",
    },
  ],
  consent: [
    {
      id: "consent-approve",
      label: "approve",
      description: "Approve consent",
      shortcut: "y",
      category: "data",
    },
    {
      id: "consent-deny",
      label: "deny",
      description: "Deny consent",
      shortcut: "n",
      category: "data",
    },
    {
      id: "consent-details",
      label: "details",
      description: "View details",
      shortcut: "d",
      category: "data",
    },
  ],
  service: [
    {
      id: "service-stop",
      label: "stop",
      description: "Stop service",
      shortcut: "s",
      category: "system",
    },
    {
      id: "service-doctor",
      label: "doctor",
      description: "Run diagnostics",
      shortcut: "d",
      category: "system",
    },
    {
      id: "service-logs",
      label: "logs",
      description: "View logs",
      shortcut: "l",
      category: "system",
    },
  ],
  logs: [
    {
      id: "logs-cycle",
      label: "cycle level",
      description: "Cycle log filter level",
      shortcut: "l",
      category: "monitoring",
    },
  ],
  debug: [
    {
      id: "debug-inventory",
      label: "inventory",
      description: "Package inventory panel",
      shortcut: "1",
      category: "monitoring",
    },
    {
      id: "debug-waterfall",
      label: "waterfall",
      description: "Trace waterfall panel",
      shortcut: "2",
      category: "monitoring",
    },
    {
      id: "debug-next",
      label: "next turn",
      description: "Next turn",
      shortcut: "n",
      category: "monitoring",
    },
    {
      id: "debug-prev",
      label: "prev turn",
      description: "Previous turn",
      shortcut: "p",
      category: "monitoring",
    },
  ],
  scratchpad: [
    {
      id: "scratchpad-open",
      label: "read",
      description: "Read selected entry",
      shortcut: "Enter",
      category: "data",
    },
  ],
  files: [
    {
      id: "files-open",
      label: "open",
      description: "Open selected file",
      shortcut: "Enter",
      category: "data",
    },
  ],
} as const;

// ─── Footer Hint Builder ────────────────────────────────────────────

/** Views that support j/k scrolling. */
const SCROLLABLE_VIEWS: ReadonlySet<TuiView> = new Set([
  "skills",
  "channels",
  "system",
  "nexus",
  "gateway",
  "scheduler",
  "taskboard",
  "harness",
  "middleware",
  "processtree",
  "agentprocfs",
  "cost",
  "debug",
  "delegation",
  "handoffs",
  "mailbox",
  "scratchpad",
  "files",
  "forge",
  "governance",
  "temporal",
  "datasources",
]);

/** Views that support j/k navigation (j/k + selection, not just scroll). */
const NAVIGABLE_VIEWS: ReadonlySet<TuiView> = new Set([
  "agents",
  "forge",
  "governance",
  "temporal",
  "files",
  "datasources",
  "welcome",
  "model",
  "addons",
  "nexusconfig",
  "channelspicker",
]);

/**
 * Views with non-standard footer hints that the builder can't generate.
 * These take precedence over buildFooterHint().
 */
const FOOTER_OVERRIDES: Readonly<Partial<Record<TuiView, string>>> = {
  console: "Type message  Enter:send  Esc:back  Ctrl+P:commands",
  palette: "↑↓:navigate  Enter:select  Esc:close",
  splitpanes: "Tab:focus-next  Enter:zoom  Esc:back  +:cycle-zoom",
  welcome: "j/k:navigate  Enter:select  ?:details  q:quit",
  presetdetail: "Enter:select  Esc:back  q:quit",
  nameinput: "Enter:confirm  Esc:back",
  engine: "Enter:confirm  s:skip  Esc:back",
  progress: "Starting Koi…",
  nexus: "j/k:scroll  Esc:back  Ctrl+F:close  Ctrl+P:commands",
  sourcedetail: "Esc:back  [a] approve",
};

/** Build a footer hint string for a given view. */
function buildFooterHint(view: TuiView): string {
  // Use override if available (views with non-standard hints)
  const override = FOOTER_OVERRIDES[view];
  if (override !== undefined) return override;
  const parts: string[] = [];

  // Navigation prefix
  if (NAVIGABLE_VIEWS.has(view)) {
    parts.push("j/k:navigate");
  } else if (SCROLLABLE_VIEWS.has(view)) {
    parts.push("j/k:scroll");
  }

  // View-specific shortcuts
  const viewCmds = VIEW_SHORTCUTS[view];
  if (viewCmds !== undefined) {
    for (const cmd of viewCmds) {
      if (cmd.shortcut !== undefined) {
        parts.push(`[${cmd.shortcut}] ${cmd.description}`);
      }
    }
  }

  // Common suffixes
  if (view !== "welcome" && view !== "presetdetail" && view !== "progress") {
    parts.push("Esc:back");
  }
  if (
    view !== "welcome" &&
    view !== "presetdetail" &&
    view !== "progress" &&
    view !== "palette" &&
    view !== "consent" &&
    view !== "nameinput" &&
    view !== "model" &&
    view !== "addons" &&
    view !== "engine" &&
    view !== "channelspicker" &&
    view !== "nexusconfig" &&
    view !== "service" &&
    view !== "doctor" &&
    view !== "logs"
  ) {
    parts.push("Ctrl+P:commands");
  }

  return parts.join("  ");
}

// ─── Pre-computed View Commands Map ─────────────────────────────────

/** Pre-built map of view → commands + footer hint. Computed once at import. */
export const VIEW_COMMAND_MAP: Readonly<Record<TuiView, ViewCommands>> = /* @__PURE__ */ (() => {
  const views: TuiView[] = [
    "addons",
    "agents",
    "agentprocfs",
    "channels",
    "channelspicker",
    "consent",
    "console",
    "cost",
    "datasources",
    "debug",
    "delegation",
    "doctor",
    "engine",
    "files",
    "forge",
    "gateway",
    "governance",
    "handoffs",
    "harness",
    "logs",
    "mailbox",
    "middleware",
    "model",
    "nameinput",
    "nexus",
    "nexusconfig",
    "palette",
    "presetdetail",
    "processtree",
    "progress",
    "scheduler",
    "scratchpad",
    "service",
    "sessions",
    "skills",
    "sourcedetail",
    "splitpanes",
    "system",
    "taskboard",
    "temporal",
    "welcome",
  ];
  const result: Record<string, ViewCommands> = {};
  for (const view of views) {
    result[view] = {
      commands: VIEW_SHORTCUTS[view] ?? [],
      footerHint: buildFooterHint(view),
    };
  }
  return result as Record<TuiView, ViewCommands>;
})();

// ─── Query Functions ────────────────────────────────────────────────

/** Get commands + footer for a specific view. */
export function getViewCommands(view: TuiView): ViewCommands {
  return VIEW_COMMAND_MAP[view];
}

/** Category display order and labels for palette grouping. */
export const CATEGORY_ORDER: readonly {
  readonly key: CommandCategory;
  readonly label: string;
}[] = [
  { key: "navigation", label: "NAVIGATION" },
  { key: "agent", label: "AGENT" },
  { key: "session", label: "SESSION" },
  { key: "monitoring", label: "MONITORING" },
  { key: "infrastructure", label: "INFRASTRUCTURE" },
  { key: "data", label: "DATA" },
  { key: "system", label: "SYSTEM" },
] as const;

/** Filter + group commands for the palette. */
export function getPaletteCommands(options: {
  readonly capabilities: Readonly<Record<string, boolean>> | null;
  readonly sessionCount: number;
  readonly recentCommandIds?: readonly string[] | undefined;
}): readonly { readonly category: string; readonly commands: readonly CommandMeta[] }[] {
  const { capabilities, sessionCount, recentCommandIds } = options;

  // Filter by capability and session count
  const filtered = ALL_COMMANDS.filter((cmd) => {
    if (cmd.requiredCapability !== undefined) {
      if (capabilities === null) return false;
      if (capabilities[cmd.requiredCapability] !== true) return false;
    }
    if (cmd.minSessionCount !== undefined && sessionCount < cmd.minSessionCount) {
      return false;
    }
    return true;
  });

  const groups: { readonly category: string; readonly commands: readonly CommandMeta[] }[] = [];

  // Recent section (if any)
  if (recentCommandIds !== undefined && recentCommandIds.length > 0) {
    const recentCmds = recentCommandIds
      .map((id) => filtered.find((c) => c.id === id))
      .filter((c): c is CommandMeta => c !== undefined);
    if (recentCmds.length > 0) {
      groups.push({ category: "RECENT", commands: recentCmds });
    }
  }

  // Group by category in display order
  for (const { key, label } of CATEGORY_ORDER) {
    const cmds = filtered.filter((c) => c.category === key);
    if (cmds.length > 0) {
      groups.push({ category: label, commands: cmds });
    }
  }

  return groups;
}
