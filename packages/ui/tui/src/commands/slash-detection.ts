/**
 * Slash command detection and matching — pure functions for the TUI.
 *
 * Decision 3A: TUI owns slash command dispatch. Channel-cli defers.
 * Decision 14A: Simple prefix/startsWith match for ~20 commands.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A registered slash command definition. */
export interface SlashCommand {
  /** Command name without the "/" prefix (e.g., "clear", "help"). */
  readonly name: string;
  /** Short description shown in the completion overlay. */
  readonly description: string;
  /** Optional keyboard shortcut hint (e.g., "Ctrl+L"). */
  readonly keybind?: string | undefined;
}

/** Result of parsing a slash command from input text. */
export interface SlashParseResult {
  /** Command name without "/" (e.g., "clear"). */
  readonly command: string;
  /** Remaining text after the command (trimmed). */
  readonly args: string;
}

/** A match result from the completion filter. */
export interface SlashMatch {
  /** The matching command definition. */
  readonly command: SlashCommand;
  /** Whether the match is an exact full match. */
  readonly exact: boolean;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect if the input starts with a slash command.
 * Returns null if the input doesn't start with "/" at position 0.
 * A "/" in the middle of a message is NOT a command.
 */
export function detectSlashPrefix(input: string): string | null {
  if (!input.startsWith("/")) return null;
  // Extract the query part (everything after "/" up to the first space)
  const spaceIdx = input.indexOf(" ");
  return spaceIdx === -1 ? input.slice(1) : input.slice(1, spaceIdx);
}

/**
 * Parse a full slash command from input text.
 * Returns null if the input is not a slash command.
 */
export function parseSlashCommand(input: string): SlashParseResult | null {
  if (!input.startsWith("/")) return null;
  const trimmed = input.slice(1);
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { command: trimmed, args: "" };
  }
  return {
    command: trimmed.slice(0, spaceIdx),
    args: trimmed.slice(spaceIdx + 1).trim(),
  };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Filter commands by prefix match against the query.
 * Empty query returns all commands.
 * Commands are sorted: exact matches first, then alphabetical.
 */
export function matchCommands(
  commands: readonly SlashCommand[],
  query: string,
): readonly SlashMatch[] {
  const lower = query.toLowerCase();

  if (lower === "") {
    return commands.map((command) => ({ command, exact: false }));
  }

  const matches: SlashMatch[] = [];
  for (const cmd of commands) {
    const name = cmd.name.toLowerCase();
    if (name.startsWith(lower)) {
      matches.push({ command: cmd, exact: name === lower });
    }
  }

  // Sort: exact matches first, then alphabetical
  matches.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    return a.command.name.localeCompare(b.command.name);
  });

  return matches;
}
