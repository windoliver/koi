/**
 * Session management — persistence, loading, and lifecycle.
 *
 * Extracted from tui-app to keep the orchestrator lean.
 * Handles session persistence to filesystem and loading from saved sessions.
 */

import type { AdminClient } from "@koi/dashboard-client";
import {
  buildReadableSessionPath,
  buildSessionPath,
  deriveSessionSlug,
  loadSavedSession,
} from "@koi/dashboard-client";
import type { TuiStore } from "../state/store.js";

/** Persist the current session's messages to the admin filesystem. */
export async function persistCurrentSession(store: TuiStore, client: AdminClient): Promise<void> {
  const session = store.getState().activeSession;
  if (session === null || session.messages.length === 0) return;

  const content = session.messages.map((m) => JSON.stringify(m)).join("\n");

  // Derive a human-readable filename from the first user message.
  const firstUserMsg = session.messages.find((m) => m.kind === "user");
  const slug =
    firstUserMsg !== undefined && "text" in firstUserMsg
      ? deriveSessionSlug(firstUserMsg.text)
      : "";
  const readablePath =
    slug !== ""
      ? buildReadableSessionPath(session.sessionId, slug)
      : `/session/chat/${session.sessionId}.jsonl`;

  // Write to both per-agent and namespace-root (human-readable) paths.
  const agentPath = buildSessionPath(session.agentId, session.sessionId);
  await Promise.all([
    client.fsWrite(agentPath, content).catch(() => {}),
    client.fsWrite(readablePath, content).catch(() => {}),
  ]);

  // Update the session record with the readable logPath so restore can find it.
  const agent = store.getState().agents.find((a) => a.agentId === session.agentId);
  const record = JSON.stringify({
    sessionId: session.sessionId,
    agentId: session.agentId,
    agentName: agent?.name ?? session.agentId,
    connectedAt: Date.now(),
    logPath: readablePath,
  });
  await client.fsWrite(`/session/records/${session.sessionId}.json`, record).catch(() => {});
}

/** Load a saved session and restore it into the store. */
export async function restoreSession(
  store: TuiStore,
  client: AdminClient,
  agentId: string,
  sessionId: string,
  logPath?: string,
): Promise<number> {
  const allMessages = await loadSavedSession(client, agentId, sessionId, logPath);

  // Filter out lifecycle noise — only restore actual conversation messages.
  // Lifecycle messages ("Attached to agent", "Run started", etc.) from the
  // original session are stale context that clutters the restored view.
  const messages = allMessages.filter(
    (m) => m.kind === "user" || m.kind === "assistant" || m.kind === "tool_call",
  );

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
