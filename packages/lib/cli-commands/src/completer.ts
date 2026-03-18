/**
 * Tab completion for CLI REPL slash commands.
 *
 * Uses a sync completer with TTL-cached dynamic data to avoid
 * async I/O on every Tab press. Cache is refreshed in the background.
 *
 * For non-slash input, provides file path completion via readdirSync.
 */

import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CLI_COMMANDS } from "./commands.js";
import type { CliCommandDeps } from "./types.js";

// ─── Completion Cache ───────────────────────────────────────────────

/** Cached completion data with TTL. */
interface CacheEntry {
  readonly data: readonly string[];
  readonly expiresAt: number;
}

/** In-memory cache for dynamic completion candidates. */
export interface CompletionCache {
  agents: CacheEntry | undefined;
  models: CacheEntry | undefined;
}

const CACHE_TTL_MS = 5_000;

/**
 * Creates a new empty completion cache.
 * Exported for testing and for the channel adapter to hold a reference.
 */
export function createCompletionCache(): CompletionCache {
  return { agents: undefined, models: undefined };
}

/** Read cached agent names, or return empty if expired/missing. */
function getCachedAgents(cache: CompletionCache): readonly string[] {
  if (cache.agents === undefined || Date.now() > cache.agents.expiresAt) return [];
  return cache.agents.data;
}

/** Read cached model names, or return empty if expired/missing. */
function getCachedModels(cache: CompletionCache): readonly string[] {
  if (cache.models === undefined || Date.now() > cache.models.expiresAt) return [];
  return cache.models.data;
}

/**
 * Refresh cached data in the background. Non-blocking, fire-and-forget.
 * Called after each command dispatch or on a timer.
 */
export function refreshCache(cache: CompletionCache, deps: CliCommandDeps): void {
  const now = Date.now();
  const expiry = now + CACHE_TTL_MS;

  // Always refresh models (sync)
  try {
    const models = deps.listModels();
    cache.models = { data: models, expiresAt: expiry };
  } catch {
    // Non-fatal — keep stale data
  }

  // Refresh agents if available (async, fire-and-forget)
  if (deps.listAgents !== undefined) {
    deps
      .listAgents()
      .then((agents) => {
        cache.agents = { data: agents.map((a) => a.name), expiresAt: now + CACHE_TTL_MS };
      })
      .catch(() => {
        // Non-fatal — keep stale data
      });
  }
}

// ─── Command Names ──────────────────────────────────────────────────

/** All command names + aliases for command-level completion. */
const ALL_COMMAND_NAMES: readonly string[] = CLI_COMMANDS.flatMap((cmd) => {
  const names = [`/${cmd.name}`];
  if (cmd.aliases !== undefined) {
    for (const alias of cmd.aliases) {
      names.push(`/${alias}`);
    }
  }
  return names;
});

// ─── Completer ──────────────────────────────────────────────────────

/**
 * Sync tab completer for readline.
 *
 * @param line - Current input line.
 * @param cache - Completion cache (managed by the channel adapter).
 * @param deps - Command dependencies (for per-command completers).
 * @returns [completions, line] tuple for readline.
 */
export function slashCompleter(
  line: string,
  cache: CompletionCache,
  deps: CliCommandDeps,
): readonly [readonly string[], string] {
  const trimmed = line.trimStart();

  // Distinguish slash commands ("/help", "/model claude") from absolute paths ("/Users/foo").
  // Slash commands: first token is /word with no embedded slashes.
  // Absolute paths: contain "/" after the leading slash (e.g., "/Users/").
  const firstToken = trimmed.split(/\s+/)[0] ?? "";
  const isSlashCommand = firstToken.startsWith("/") && !firstToken.slice(1).includes("/");

  if (!isSlashCommand) {
    return completeFilePath(trimmed);
  }

  // Check if we're completing a command name or command arguments
  const withoutSlash = trimmed.slice(1);
  const spaceIndex = withoutSlash.indexOf(" ");

  if (spaceIndex === -1) {
    // Completing command name: "/he" → ["/help"]
    const lower = trimmed.toLowerCase();
    const matches = ALL_COMMAND_NAMES.filter((name) => name.toLowerCase().startsWith(lower));
    return [matches, trimmed];
  }

  // Completing arguments: "/attach al" → agent names starting with "al"
  const cmdName = withoutSlash.slice(0, spaceIndex).toLowerCase();
  const argPartial = withoutSlash.slice(spaceIndex + 1).trimStart();

  // Special-case: /attach → agent names from cache
  if (cmdName === "attach") {
    const agents = getCachedAgents(cache);
    if (argPartial === "") return [agents.map(String), argPartial];
    const lower = argPartial.toLowerCase();
    const matches = agents.filter((a) => a.toLowerCase().startsWith(lower));
    return [matches.map(String), argPartial];
  }

  // Special-case: /model → model names from cache
  if (cmdName === "model") {
    const models = getCachedModels(cache);
    if (argPartial === "") return [models.map(String), argPartial];
    const lower = argPartial.toLowerCase();
    const matches = models.filter((m) => m.toLowerCase().startsWith(lower));
    return [matches.map(String), argPartial];
  }

  // Fall back to command's own completer if defined
  const cmd = CLI_COMMANDS.find((c) => c.name === cmdName || c.aliases?.includes(cmdName));
  if (cmd?.complete !== undefined) {
    const matches = cmd.complete(argPartial, deps);
    return [matches.map(String), argPartial];
  }

  return [[], argPartial];
}

// ─── File Path Completion ───────────────────────────────────────────

/**
 * Complete file paths from the last whitespace-separated token on the line.
 * Uses readdirSync to list entries in the directory portion of the partial path.
 */
function completeFilePath(line: string): readonly [readonly string[], string] {
  // Extract the last token (the partial path being typed)
  const tokens = line.split(/\s+/);
  const partial = tokens[tokens.length - 1] ?? "";
  if (partial === "") return [[], line];

  try {
    const resolved = resolve(partial);
    const dir = partial.endsWith("/") ? resolved : dirname(resolved);
    const prefix = partial.endsWith("/") ? "" : partial.slice(partial.lastIndexOf("/") + 1);
    const entries = readdirSync(dir);
    const lower = prefix.toLowerCase();
    const matches = entries
      .filter((e) => e.toLowerCase().startsWith(lower))
      .map((e) => {
        // Reconstruct the full partial path with the completed filename
        const base = partial.endsWith("/")
          ? partial
          : partial.slice(0, partial.lastIndexOf("/") + 1);
        return `${base}${e}`;
      });
    return [matches, partial];
  } catch {
    // Directory doesn't exist or not readable — no completions
    return [[], partial];
  }
}
