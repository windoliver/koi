/**
 * Session management — persistence, loading, and lifecycle.
 *
 * Extracted from tui-app to keep the orchestrator lean.
 * Handles session persistence to filesystem and loading from saved sessions.
 */

import type { AdminClient } from "@koi/dashboard-client";
import { buildSessionPath, loadSavedSession } from "@koi/dashboard-client";
import type { TuiStore } from "../state/store.js";

/** Persist the current session's messages to the admin filesystem. */
export async function persistCurrentSession(store: TuiStore, client: AdminClient): Promise<void> {
  const session = store.getState().activeSession;
  if (session === null || session.messages.length === 0) return;

  const sessionPath = buildSessionPath(session.agentId, session.sessionId);
  const content = session.messages.map((m) => JSON.stringify(m)).join("\n");

  // Best-effort write — don't block on failure
  await client.fsWrite(sessionPath, content).catch(() => {});
}

/** Load a saved session and restore it into the store. */
export async function restoreSession(
  store: TuiStore,
  client: AdminClient,
  agentId: string,
  sessionId: string,
): Promise<number> {
  const messages = await loadSavedSession(client, agentId, sessionId);
  store.dispatch({
    kind: "set_session",
    session: {
      agentId,
      sessionId,
      messages,
      pendingText: "",
      isStreaming: false,
    },
  });
  store.dispatch({ kind: "set_view", view: "console" });
  return messages.length;
}

/** Fetch recent agent events and add them as lifecycle messages. */
export async function fetchRecentAgentActivity(
  client: AdminClient,
  store: TuiStore,
  agentId: string,
): Promise<void> {
  const result = await client.fsList(`/agents/${agentId}/events`);
  if (!result.ok || result.value.length === 0) return;
  const recent = result.value[result.value.length - 1];
  if (recent === undefined) return;
  const content = await client.fsRead(recent.path);
  if (!content.ok) return;
  const text = typeof content.value === "string" ? content.value : "";
  const tail = text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(-10);
  if (tail.length > 0) {
    store.dispatch({
      kind: "add_message",
      message: {
        kind: "lifecycle",
        event: `Recent activity:\n${tail.join("\n")}`,
        timestamp: Date.now(),
      },
    });
  }
}
