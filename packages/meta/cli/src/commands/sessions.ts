/**
 * `koi sessions` — list persisted chat sessions.
 *
 * Sessions are JSONL chat files written during every agent turn. This command
 * scans agents/{name}/session/chat/*.jsonl relative to the workspace root
 * (derived from --manifest path or cwd).
 *
 * Streaming optimisation (Decision 14-A): stat all files first (fast — metadata
 * only), sort by mtime desc, then read only the first `limit` file contents.
 * This is O(n) for stats + O(limit) for content reads, vs v1's O(n) for both.
 *
 * TODO(Phase 2i-3): replace directory scanning with @koi/session once that
 * package lands in v2.
 */

import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { CliFlags } from "../args.js";
import { isSessionsFlags } from "../args.js";
import { ExitCode } from "../types.js";

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

/**
 * Strip C0/C1 control characters and ANSI/OSC escape sequences from a string
 * before writing user-sourced content to the terminal.
 *
 * Session JSONL content is user-controlled; replaying it verbatim allows ANSI
 * injection (screen clearing, cursor movement, hyperlink abuse, etc.).
 */
function stripControlChars(text: string): string {
  return (
    text
      // ANSI/OSC escape sequences: ESC [ ... m, ESC ] ... BEL/ST, etc.
      .replace(
        // biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are the subject of this sanitizer
        /\u001B[@-Z\\-_]|[\u0080-\u009F]|\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g,
        "",
      )
      // Remaining C0 control characters (except TAB 0x09 — harmless in terminals)
      // and DEL (0x7F)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are the subject of this sanitizer
      .replace(/[\u0000-\u0008\u000A-\u001F\u007F]/g, "")
  );
}

/**
 * Format a timestamp for display. Guards against out-of-range values that
 * cause `Date.toISOString()` to throw RangeError.
 */
function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  // Out-of-range timestamps produce an invalid Date; getTime() returns NaN.
  if (!Number.isFinite(date.getTime())) return "(invalid date)";
  return date.toISOString().replace("T", " ").slice(0, 19);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionSummary {
  readonly sessionId: string;
  readonly agentName: string;
  readonly createdAt: number;
  readonly lastActiveAt: number;
  readonly messageCount: number;
  readonly firstUserMessage: string | undefined;
}

// ---------------------------------------------------------------------------
// Core logic (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Parse a single JSONL session file into a summary.
 * Returns undefined for empty or missing files — callers filter these out.
 */
export async function loadSessionSummary(
  filePath: string,
  agentName: string,
): Promise<SessionSummary | undefined> {
  let text: string;
  try {
    text = await Bun.file(filePath).text();
  } catch {
    return undefined;
  }

  const lines = text.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return undefined;

  const sessionId = basename(filePath, ".jsonl");

  let createdAt = 0;
  let lastActiveAt = 0;
  let firstUserMessage: string | undefined;
  let messageCount = 0;

  for (let i = 0; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i] as string) as {
        readonly kind?: string;
        readonly text?: string;
        readonly timestamp?: number;
      };
      messageCount++;

      // Only accept finite numbers — non-numeric, null, or NaN timestamps would
      // cause new Date(value).toISOString() to throw during rendering.
      const ts =
        typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
          ? entry.timestamp
          : undefined;

      if (i === 0 && ts !== undefined) {
        createdAt = ts;
      }
      if (ts !== undefined) {
        lastActiveAt = ts;
      }
      if (firstUserMessage === undefined && entry.kind === "user" && entry.text !== undefined) {
        firstUserMessage = entry.text.length > 80 ? `${entry.text.slice(0, 77)}...` : entry.text;
      }
    } catch {
      // Skip malformed lines without incrementing messageCount
    }
  }

  if (messageCount === 0) return undefined;
  if (createdAt === 0) createdAt = Date.now();
  if (lastActiveAt === 0) lastActiveAt = createdAt;

  return { sessionId, agentName, createdAt, lastActiveAt, messageCount, firstUserMessage };
}

/**
 * Scan all agents under workspaceRoot for session JSONL files.
 *
 * Streaming: stats all JSONL files across all agents (fast, metadata only),
 * sorts by mtime desc, then reads only the first `limit` files' content.
 */
export async function listSessionSummaries(
  workspaceRoot: string,
  limit: number,
): Promise<readonly SessionSummary[]> {
  const agentsDir = join(workspaceRoot, "agents");

  let agentNames: string[];
  try {
    agentNames = await readdir(agentsDir);
  } catch {
    return [];
  }

  // Collect all JSONL paths across all agent directories
  const allPaths: Array<{ readonly path: string; readonly agentName: string }> = [];
  for (const agentName of agentNames) {
    const chatDir = join(agentsDir, agentName, "session", "chat");
    let files: string[];
    try {
      files = (await readdir(chatDir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      allPaths.push({ path: join(chatDir, file), agentName });
    }
  }

  if (allPaths.length === 0) return [];

  // Stat files in bounded batches to avoid EMFILE under large session histories.
  // Per-file try-catch: files may disappear between readdir() and stat() if a
  // session is being rotated or deleted concurrently. Drop missing files rather
  // than aborting the listing.
  const STAT_BATCH = 64;
  const statResults: Array<{ path: string; agentName: string; mtime: number } | undefined> = [];
  for (let i = 0; i < allPaths.length; i += STAT_BATCH) {
    const batch = allPaths.slice(i, i + STAT_BATCH);
    const batchResults = await Promise.all(
      batch.map(async ({ path, agentName }) => {
        try {
          const fileStat = await stat(path);
          return { path, agentName, mtime: fileStat.mtimeMs };
        } catch {
          return undefined;
        }
      }),
    );
    statResults.push(...batchResults);
  }
  const stats = statResults.filter(
    (s): s is { path: string; agentName: string; mtime: number } => s !== undefined,
  );

  // Sort by mtime desc (most recent first)
  stats.sort((a, b) => b.mtime - a.mtime);

  // Scan in order until we have `limit` valid summaries. Files may be partially
  // written, malformed, or empty — do not slice before validation or malformed
  // files in the top-N will silently reduce the result count.
  const summaries: SessionSummary[] = [];
  for (const { path, agentName } of stats) {
    if (summaries.length >= limit) break;
    const summary = await loadSessionSummary(path, agentName);
    if (summary !== undefined) summaries.push(summary);
  }

  return summaries;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

function renderSessionsTable(summaries: readonly SessionSummary[]): void {
  const idWidth = Math.max(10, ...summaries.map((s) => s.sessionId.length));
  const agentWidth = Math.max(5, ...summaries.map((s) => s.agentName.length));

  process.stdout.write(
    `  ${"SESSION ID".padEnd(idWidth)}  ${"AGENT".padEnd(agentWidth)}  ${"LAST ACTIVE".padEnd(20)}  ${"MSGS".padStart(4)}  PREVIEW\n`,
  );
  process.stdout.write(
    `  ${"─".repeat(idWidth)}  ${"─".repeat(agentWidth)}  ${"─".repeat(20)}  ${"─".repeat(4)}  ${"─".repeat(40)}\n`,
  );

  for (const s of summaries) {
    const date = formatTimestamp(s.lastActiveAt);
    // All user-controlled fields (sessionId from filename, agentName from directory,
    // preview from JSONL content) must be sanitized — filesystem paths can contain
    // ANSI sequences just like chat content.
    const sessionId = stripControlChars(s.sessionId);
    const agentName = stripControlChars(s.agentName);
    const preview = stripControlChars(s.firstUserMessage ?? "(no user message)").slice(0, 60);
    process.stdout.write(
      `  ${sessionId.padEnd(idWidth)}  ${agentName.padEnd(agentWidth)}  ${date.padEnd(20)}  ${String(s.messageCount).padStart(4)}  ${preview}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function run(flags: CliFlags): Promise<ExitCode> {
  if (!isSessionsFlags(flags)) return ExitCode.FAILURE;

  const manifestPath = flags.manifest ?? "koi.yaml";
  const workspaceRoot = resolve(dirname(manifestPath));
  const summaries = await listSessionSummaries(workspaceRoot, flags.limit);

  if (summaries.length === 0) {
    process.stdout.write("No sessions found.\n");
    process.stdout.write("  Sessions are created when you chat with an agent.\n");
    return ExitCode.OK;
  }

  process.stdout.write(`Sessions (most recent first, limit ${String(flags.limit)}):\n\n`);
  renderSessionsTable(summaries);
  process.stdout.write(`\n(Session resume: coming in Phase 2i-3 via koi start)\n`);

  return ExitCode.OK;
}
