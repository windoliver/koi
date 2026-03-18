/**
 * Types for CLI REPL slash commands.
 *
 * Defines the command shape, result type, and dependency interfaces
 * for the 10 channel-cli slash commands.
 */

// ─── Command Result ─────────────────────────────────────────────────

/** Outcome of executing a slash command. */
export type CommandResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

// ─── Command Definition ─────────────────────────────────────────────

/** A self-contained slash command with handler and optional completer. */
export interface SlashCommand {
  /** Command name without the leading slash (e.g., "help", "clear"). */
  readonly name: string;
  /** Alternative names for the command (e.g., "exit" for quit). */
  readonly aliases?: readonly string[];
  /** One-line description shown in /help output. */
  readonly description: string;
  /** Argument hint shown in /help (e.g., "<name>", "<model>"). */
  readonly args?: string;
  /** Execute the command. `rawArgs` is everything after the command name, trimmed. */
  readonly execute: (
    rawArgs: string,
    deps: CliCommandDeps,
  ) => CommandResult | Promise<CommandResult>;
  /** Tab-complete arguments for this command. Returns candidate strings. */
  readonly complete?: (partial: string, deps: CliCommandDeps) => readonly string[];
}

// ─── Dependency Interfaces ──────────────────────────────────────────

/** Agent summary returned by listAgents — minimal shape for display + completion. */
export interface CliAgentSummary {
  readonly name: string;
  readonly agentId: string;
  readonly state: string;
}

/** Session summary returned by listSessions — minimal shape for display. */
export interface CliSessionSummary {
  readonly sessionId: string;
  readonly agentName: string;
  readonly startedAt: number;
}

/** Tool summary returned by listTools — minimal shape for display. */
export interface CliToolSummary {
  readonly name: string;
  readonly description: string;
}

/**
 * Dependencies always available in any CLI REPL context.
 * These commands work even without an admin server.
 */
export interface CliCommandDepsBase {
  /** Cancel the current streaming response. */
  readonly cancelStream: () => void;
  /** List available model names for /model completion. */
  readonly listModels: () => readonly string[];
  /** Get the current model name. */
  readonly currentModel: () => string;
  /** Switch to a different model. */
  readonly setModel: (name: string) => void;
  /** Writable stream for command output. */
  readonly output: NodeJS.WritableStream;
  /** Exit the REPL cleanly. */
  readonly exit: () => void;
}

/** Search result from forge store. */
export interface ForgeSearchResult {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly kind: string;
}

/**
 * Full CLI command dependencies — base + optional admin capabilities.
 *
 * Optional methods are undefined when the admin server is not running.
 * Commands check for their existence and show a helpful message when missing.
 */
export interface CliCommandDeps extends CliCommandDepsBase {
  /** Get agent status summary. Requires --admin. */
  readonly getStatus?: (() => Promise<string>) | undefined;
  /** List running agents. Requires --admin. */
  readonly listAgents?: (() => Promise<readonly CliAgentSummary[]>) | undefined;
  /** Attach to a named agent. Requires --admin. */
  readonly attachAgent?: ((name: string) => Promise<CommandResult>) | undefined;
  /** List recent sessions. Requires --admin. */
  readonly listSessions?: (() => Promise<readonly CliSessionSummary[]>) | undefined;
  /** List currently loaded tools. */
  readonly listTools?: (() => readonly CliToolSummary[]) | undefined;
  /** Search the forge store for bricks. Requires forge to be configured. */
  readonly forgeSearch?: ((query: string) => Promise<readonly ForgeSearchResult[]>) | undefined;
  /** Install (activate) a forge brick by ID. Requires forge to be configured. */
  readonly forgeInstall?: ((id: string) => Promise<CommandResult>) | undefined;
  /** Inspect a forge brick by ID, returning a detail string. */
  readonly forgeInspect?: ((id: string) => Promise<string>) | undefined;
}
