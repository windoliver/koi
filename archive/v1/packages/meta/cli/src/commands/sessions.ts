/**
 * `koi sessions` subcommand — list and inspect persisted sessions.
 *
 * Sessions are JSONL chat files written by `persistChatExchangeSafely` during
 * every `koi up` turn. Each file corresponds to one session (thread).
 */

import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { SessionsFlags } from "../args.js";
import { loadManifestOrExit } from "../load-manifest-or-exit.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionSummary {
  readonly sessionId: string;
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
 * Reads only the first and last lines to avoid loading entire files.
 */
export async function loadSessionSummary(filePath: string): Promise<SessionSummary | undefined> {
  try {
    const file = Bun.file(filePath);
    const text = await file.text();
    const lines = text.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return undefined;

    const sessionId = filePath.slice(filePath.lastIndexOf("/") + 1).replace(/\.jsonl$/, "");

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

        if (i === 0 && entry.timestamp !== undefined) {
          createdAt = entry.timestamp;
        }
        if (entry.timestamp !== undefined) {
          lastActiveAt = entry.timestamp;
        }
        if (firstUserMessage === undefined && entry.kind === "user" && entry.text !== undefined) {
          firstUserMessage = entry.text.length > 80 ? `${entry.text.slice(0, 77)}...` : entry.text;
        }
      } catch {
        // Skip malformed lines
      }
    }

    if (messageCount === 0) return undefined;
    if (createdAt === 0) createdAt = Date.now();
    if (lastActiveAt === 0) lastActiveAt = createdAt;

    return { sessionId, createdAt, lastActiveAt, messageCount, firstUserMessage };
  } catch {
    return undefined;
  }
}

/**
 * Scan the chat directory for session JSONL files and return summaries.
 */
export async function listSessionSummaries(
  workspaceRoot: string,
  agentName: string,
  limit: number,
): Promise<readonly SessionSummary[]> {
  const chatDir = join(workspaceRoot, "agents", agentName, "session", "chat");

  let files: readonly string[];
  try {
    const entries = await readdir(chatDir);
    files = entries.filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const summaries: SessionSummary[] = [];
  for (const file of files) {
    const summary = await loadSessionSummary(join(chatDir, file));
    if (summary !== undefined) summaries.push(summary);
  }

  // Sort by lastActiveAt descending (most recent first)
  summaries.sort((a, b) => b.lastActiveAt - a.lastActiveAt);

  return summaries.slice(0, limit);
}

// ---------------------------------------------------------------------------
// CLI entry points
// ---------------------------------------------------------------------------

async function runSessionsList(flags: SessionsFlags): Promise<void> {
  const manifestPath = flags.manifest ?? "koi.yaml";
  const workspaceRoot = resolve(dirname(manifestPath));
  const { manifest } = await loadManifestOrExit(manifestPath);
  const agentName = manifest.name;
  const summaries = await listSessionSummaries(workspaceRoot, agentName, flags.limit);

  if (summaries.length === 0) {
    process.stderr.write("No sessions found.\n");
    process.stderr.write(`  Sessions are created when you chat via \`koi up\`.\n`);
    return;
  }

  process.stderr.write(`Sessions for "${agentName}" (most recent first):\n\n`);

  const idWidth = Math.max(10, ...summaries.map((s) => s.sessionId.length));

  process.stderr.write(
    `  ${"SESSION ID".padEnd(idWidth)}  ${"LAST ACTIVE".padEnd(20)}  ${"MSGS".padStart(4)}  PREVIEW\n`,
  );
  process.stderr.write(
    `  ${"─".repeat(idWidth)}  ${"─".repeat(20)}  ${"─".repeat(4)}  ${"─".repeat(40)}\n`,
  );

  for (const s of summaries) {
    const date = new Date(s.lastActiveAt).toISOString().replace("T", " ").slice(0, 19);
    const preview = s.firstUserMessage ?? "(no user message)";
    process.stderr.write(
      `  ${s.sessionId.padEnd(idWidth)}  ${date.padEnd(20)}  ${String(s.messageCount).padStart(4)}  ${preview}\n`,
    );
  }

  process.stderr.write(`\nResume with: koi up --resume <session-id>\n`);
}

export async function runSessions(flags: SessionsFlags): Promise<void> {
  switch (flags.subcommand) {
    case "list":
      await runSessionsList(flags);
      break;
    default:
      // Bare `koi sessions` defaults to list
      await runSessionsList(flags);
      break;
  }
}
