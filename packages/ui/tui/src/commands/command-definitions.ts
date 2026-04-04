/**
 * Command palette definitions for v2 — ~15 core commands.
 *
 * Pure data: no dispatch logic, no router, no side effects.
 * Filtering (progressive disclosure) is a separate pure function below.
 *
 * v2 starts lean: navigation + agent + session + system.
 * v1 reference: archive/v1/packages/ui/tui/src/command-registry.ts (40+ cmds).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommandCategory = "navigation" | "agent" | "session" | "system";

export interface CommandDef {
  /** Unique command ID used for dispatch. */
  readonly id: string;
  /** Display label shown in the palette. */
  readonly label: string;
  /** Short description shown alongside the label. */
  readonly description: string;
  readonly category: CommandCategory;
  /** Ctrl+key shortcut hint (display only — wiring is in the host). */
  readonly ctrlShortcut?: string | undefined;
  /**
   * Progressive disclosure threshold: command is hidden until the user has
   * at least this many saved sessions. Undefined = always visible.
   */
  readonly minSessionCount?: number | undefined;
  /** Marks commands that destroy data and warrant a confirmation step. */
  readonly destructive?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Definitions — v2 core set (~15 commands)
// ---------------------------------------------------------------------------

export const COMMAND_DEFINITIONS: readonly CommandDef[] = [
  // ---- Navigation ----
  {
    id: "nav:sessions",
    label: "Sessions",
    description: "Browse and resume saved sessions",
    category: "navigation",
    ctrlShortcut: "S",
  },
  {
    id: "nav:help",
    label: "Help",
    description: "Show keyboard shortcuts and documentation",
    category: "navigation",
  },
  {
    id: "nav:doctor",
    label: "Doctor",
    description: "Check system health and configuration",
    category: "navigation",
  },

  // ---- Agent ----
  {
    id: "agent:clear",
    label: "Clear",
    description: "Clear the current conversation history",
    category: "agent",
    ctrlShortcut: "L",
    destructive: true,
  },
  {
    id: "agent:interrupt",
    label: "Interrupt",
    description: "Stop the agent mid-turn",
    category: "agent",
    ctrlShortcut: "C",
  },
  {
    id: "agent:compact",
    label: "Compact",
    description: "Summarise and compress message history",
    category: "agent",
  },

  // ---- Session ----
  {
    id: "session:new",
    label: "New session",
    description: "Start a fresh conversation session",
    category: "session",
    ctrlShortcut: "N",
  },
  {
    id: "session:resume",
    label: "Resume session",
    description: "Resume the most recent saved session",
    category: "session",
    minSessionCount: 2,
  },
  {
    id: "session:rename",
    label: "Rename session",
    description: "Rename the current session",
    category: "session",
    minSessionCount: 1,
  },
  {
    id: "session:export",
    label: "Export session",
    description: "Export conversation as Markdown",
    category: "session",
    minSessionCount: 3,
  },

  // ---- System ----
  {
    id: "system:model",
    label: "Model info",
    description: "Show current model and provider",
    category: "system",
  },
  {
    id: "system:cost",
    label: "Cost",
    description: "Show session token usage and cost",
    category: "system",
    minSessionCount: 1,
  },
  {
    id: "system:tokens",
    label: "Tokens",
    description: "Show detailed token breakdown for this session",
    category: "system",
  },
  {
    id: "system:zoom",
    label: "Zoom",
    description: "Adjust terminal zoom level",
    category: "system",
  },
  {
    id: "system:quit",
    label: "Quit",
    description: "Exit Koi",
    category: "system",
    destructive: true,
  },
] as const satisfies readonly CommandDef[];

// ---------------------------------------------------------------------------
// Progressive disclosure filter
// ---------------------------------------------------------------------------

/**
 * Filter commands by progressive disclosure threshold.
 * Commands with minSessionCount > sessionCount are hidden.
 * Pure function — no side effects.
 */
export function filterCommands(
  commands: readonly CommandDef[],
  sessionCount: number,
): readonly CommandDef[] {
  return commands.filter(
    (cmd) => cmd.minSessionCount === undefined || sessionCount >= cmd.minSessionCount,
  );
}
