/**
 * Session loading — centralized logic for loading saved sessions.
 *
 * All session logs live under /session/chat/ (namespace-root for cross-restart
 * persistence, per-agent for backward compatibility). Legacy /session/tui/ paths
 * are tried as fallback for old data.
 */

import type { AdminClient } from "./client/admin-client.js";
import {
  CHAT_SESSION_PREFIX,
  type ChatMessage,
  parseTuiChatLog,
  TUI_SESSION_PREFIX,
} from "./types.js";

/** Extract string content from fsRead result (may be string or {content} object). */
function extractFsContent(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw === "object" && raw !== null && "content" in raw) {
    return String((raw as Record<string, unknown>).content);
  }
  return "";
}

/** Load a saved session's chat messages, trying multiple paths for backward compat. */
export async function loadSavedSession(
  client: AdminClient,
  agentId: string,
  sessionId: string,
  logPath?: string,
): Promise<readonly ChatMessage[]> {
  // If the record has an explicit logPath, try it first (human-readable filenames)
  if (logPath !== undefined) {
    const directResult = await client.fsRead(logPath);
    if (directResult.ok) {
      return parseTuiChatLog(extractFsContent(directResult.value));
    }
  }

  // Canonical: namespace-root /session/chat/ (survives koi-up restarts)
  const rootChatPath = `${CHAT_SESSION_PREFIX}/${sessionId}.jsonl`;
  // Per-agent /session/chat/ (same koi-up session)
  const agentChatPath = `/agents/${agentId}${CHAT_SESSION_PREFIX}/${sessionId}.jsonl`;
  // Legacy fallbacks: old /session/tui/ paths
  const rootTuiPath = `${TUI_SESSION_PREFIX}/${sessionId}.jsonl`;
  const agentTuiPath = `/agents/${agentId}${TUI_SESSION_PREFIX}/${sessionId}.jsonl`;

  const [rootChat, agentChat, rootTui, agentTui] = await Promise.all([
    client.fsRead(rootChatPath),
    client.fsRead(agentChatPath),
    client.fsRead(rootTuiPath),
    client.fsRead(agentTuiPath),
  ]);

  // Priority: namespace-root chat > per-agent chat > legacy tui paths
  const logContent = rootChat.ok
    ? extractFsContent(rootChat.value)
    : agentChat.ok
      ? extractFsContent(agentChat.value)
      : rootTui.ok
        ? extractFsContent(rootTui.value)
        : agentTui.ok
          ? extractFsContent(agentTui.value)
          : "";

  return parseTuiChatLog(logContent);
}

/** Build the per-agent path for persisting a session. */
export function buildSessionPath(agentId: string, sessionId: string): string {
  return `/agents/${agentId}${CHAT_SESSION_PREFIX}/${sessionId}.jsonl`;
}

/** Build the namespace-root path for persisting a session (survives koi-up restarts). */
export function buildRootSessionPath(sessionId: string): string {
  return `${CHAT_SESSION_PREFIX}/${sessionId}.jsonl`;
}

/**
 * Derive a human-readable filename slug from the first user message.
 * Returns something like "how-many-employees-does-herb-have".
 */
export function deriveSessionSlug(firstUserMessage: string): string {
  return firstUserMessage
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 50)
    .replace(/-$/, "");
}

/** Build a human-readable namespace-root path from the first user message + sessionId. */
export function buildReadableSessionPath(sessionId: string, slug: string): string {
  // Short timestamp suffix for uniqueness (last 4 chars of sessionId)
  const suffix = sessionId.slice(-4);
  return `${CHAT_SESSION_PREFIX}/${slug}-${suffix}.jsonl`;
}
