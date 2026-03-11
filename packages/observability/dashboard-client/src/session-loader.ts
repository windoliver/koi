/**
 * Session loading — centralized logic for loading saved sessions.
 *
 * Tries TUI log first, then shared chat log, returns parsed messages.
 * Eliminates duplication between tui-app.ts and session-picker.ts.
 */

import type { AdminClient } from "./client/admin-client.js";
import {
  CHAT_SESSION_PREFIX,
  type ChatMessage,
  parseTuiChatLog,
  TUI_SESSION_PREFIX,
} from "./types.js";

/** Load a saved session's chat messages by trying TUI log then shared chat log. */
export async function loadSavedSession(
  client: AdminClient,
  agentId: string,
  sessionId: string,
): Promise<readonly ChatMessage[]> {
  const tuiPath = `/agents/${agentId}${TUI_SESSION_PREFIX}/${sessionId}.jsonl`;
  const chatPath = `/agents/${agentId}${CHAT_SESSION_PREFIX}/${sessionId}.jsonl`;

  // Try TUI log first (richer format), fall back to shared chat log
  const [tuiResult, chatResult] = await Promise.all([
    client.fsRead(tuiPath),
    client.fsRead(chatPath),
  ]);

  const logContent = tuiResult.ok
    ? typeof tuiResult.value === "string"
      ? tuiResult.value
      : ""
    : chatResult.ok
      ? typeof chatResult.value === "string"
        ? chatResult.value
        : ""
      : "";

  return parseTuiChatLog(logContent);
}

/** Build the filesystem path for persisting a TUI session. */
export function buildSessionPath(agentId: string, sessionId: string): string {
  return `/agents/${agentId}${TUI_SESSION_PREFIX}/${sessionId}.jsonl`;
}
