/**
 * Slash command dispatch — parses `/command args` and routes to the right handler.
 *
 * Also defines TUI_ONLY_COMMANDS for helpful redirects when users type
 * TUI panel commands in the CLI REPL.
 */

import { CLI_COMMANDS } from "./commands.js";
import type { CliCommandDeps, CommandResult } from "./types.js";

// ─── TUI-Only Commands ──────────────────────────────────────────────

/**
 * Commands that exist in the TUI but not the CLI REPL.
 * Used to show a helpful redirect message instead of "Unknown command".
 *
 * Maps the slash name (what the user types) to the TUI panel/feature it belongs to.
 * Subcommands (e.g., "workflow signal") are handled by matching the root word.
 */
export const TUI_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "agents",
  "approve",
  "channels",
  "cost",
  "delegation",
  "demo",
  "deny",
  "deploy",
  "dispatch",
  "dlq",
  "doctor",
  "files",
  "gateway",
  "governance",
  "handoffs",
  "harness",
  "health",
  "logs",
  "mailbox",
  "middleware",
  "nexus",
  "open-browser",
  "procfs",
  "proctree",
  "processtree",
  "agentprocfs",
  "refresh",
  "resume",
  "schedule",
  "scheduler",
  "scratchpad",
  "skills",
  "sources",
  "split",
  "split-panes",
  "stop",
  "suspend",
  "system",
  "taskboard",
  "temporal",
  "terminate",
  "tree",
  "undeploy",
  "workflow",
]);

// ─── Lookup ─────────────────────────────────────────────────────────

/** Build a lookup map from command name + aliases → SlashCommand. */
function buildCommandMap(): ReadonlyMap<string, (typeof CLI_COMMANDS)[number]> {
  const map = new Map<string, (typeof CLI_COMMANDS)[number]>();
  for (const cmd of CLI_COMMANDS) {
    map.set(cmd.name, cmd);
    if (cmd.aliases !== undefined) {
      for (const alias of cmd.aliases) {
        map.set(alias, cmd);
      }
    }
  }
  return map;
}

const commandMap = buildCommandMap();

// ─── Dispatch ───────────────────────────────────────────────────────

/**
 * Parse and execute a slash command.
 *
 * @param text - Raw input text starting with "/" (e.g., "/help", "/attach foo").
 * @param deps - Injected dependencies for command execution.
 * @returns The command result, or a failure result for unknown/invalid commands.
 */
export async function handleSlashCommand(
  text: string,
  deps: CliCommandDeps,
): Promise<CommandResult> {
  const trimmed = text.trim();

  // Edge case: bare "/" or just whitespace after "/"
  if (trimmed === "/" || trimmed === "") {
    return { ok: false, message: "Type /help for available commands." };
  }

  // Parse: "/command arg1 arg2" → cmd="command", rawArgs="arg1 arg2"
  const withoutSlash = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const spaceIndex = withoutSlash.indexOf(" ");
  const cmdName = spaceIndex === -1 ? withoutSlash : withoutSlash.slice(0, spaceIndex);
  const rawArgs = spaceIndex === -1 ? "" : withoutSlash.slice(spaceIndex + 1).trim();
  const cmdLower = cmdName.toLowerCase();

  // Check CLI commands first
  const cmd = commandMap.get(cmdLower);
  if (cmd !== undefined) {
    return await cmd.execute(rawArgs, deps);
  }

  // Check if it's a TUI-only command
  if (TUI_ONLY_COMMANDS.has(cmdLower)) {
    return {
      ok: false,
      message: `/${cmdName} is a TUI panel command. Run: koi tui`,
    };
  }

  return { ok: false, message: `Unknown command: /${cmdName}. Type /help for available commands.` };
}
