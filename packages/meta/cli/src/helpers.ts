/**
 * Shared utilities for CLI commands (start, serve).
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContentBlock } from "@koi/core";

export { createLocalFileSystem } from "./local-filesystem.js";

/**
 * Extracts text from an array of content blocks, joining with newlines.
 */
/**
 * Resolves the dashboard-ui dist directory for serving static SPA assets.
 * Returns undefined if the package is not available (e.g. not built yet).
 */
export function resolveDashboardAssetsDir(): string | undefined {
  try {
    const pkgUrl = import.meta.resolve("@koi/dashboard-ui/package.json");
    const pkgPath = fileURLToPath(pkgUrl);
    return resolve(dirname(pkgPath), "dist");
  } catch {
    return undefined;
  }
}

/**
 * Extracts text from an array of content blocks, joining with newlines.
 */
export function extractTextFromBlocks(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Shared session chat log prefix (accessible from admin API filesystem). */
export const CHAT_SESSION_PREFIX = "/session/chat";

/**
 * Persist a chat exchange (user + assistant) to the shared session log.
 *
 * Appends JSONL entries so multiple exchanges accumulate in the same file.
 * Uses the same format as TUI session logs so the session picker can
 * read them without any changes.
 */
export async function persistChatExchange(
  workspaceRoot: string,
  agentName: string,
  threadId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  const chatDir = join(workspaceRoot, "agents", agentName, "session", "chat");
  await mkdir(chatDir, { recursive: true });
  const logPath = join(chatDir, `${threadId}.jsonl`);
  const entries = `${[
    JSON.stringify({ kind: "user", text: userText, timestamp: Date.now() }),
    JSON.stringify({ kind: "assistant", text: assistantText, timestamp: Date.now() }),
  ].join("\n")}\n`;
  await appendFile(logPath, entries);
}
