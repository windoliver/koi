/**
 * Session picker — interactive overlay for browsing and reopening saved sessions.
 *
 * Lists engine SessionRecord files from `/agents/{id}/session/records/`
 * and TUI chat logs from `/agents/{id}/session/tui/`. On selection,
 * restores the session context (threadId for AG-UI continuity) and
 * replays any saved TUI chat history.
 */

import { type OverlayHandle, type SelectItem, SelectList, type TUI } from "@mariozechner/pi-tui";
import type { AdminClient } from "../client/admin-client.js";
import type { TuiStore } from "../state/store.js";
import type { ChatMessage } from "../state/types.js";
import { KOI_SELECT_THEME } from "../theme.js";

/** TUI session persistence path prefix (separate from engine session records). */
export const TUI_SESSION_PREFIX = "/session/tui";

/** Engine session records path prefix (canonical SessionRecord storage). */
const ENGINE_SESSION_PREFIX = "/session/records";

/** Parsed metadata from a SessionRecord JSON file. */
export interface SessionInfo {
  readonly sessionId: string;
  readonly connectedAt: number;
  readonly agentName: string;
  readonly path: string;
}

/** Dependencies injected from the main app. */
export interface SessionPickerDeps {
  readonly client: AdminClient;
  readonly store: TuiStore;
  readonly tui: TUI;
  readonly addLifecycleMessage: (event: string) => void;
}

/** Handle for managing the session picker overlay. */
export interface SessionPickerHandle {
  /** Show the session picker overlay. Returns false if no sessions found or error. */
  readonly show: () => Promise<boolean>;
  /** Hide the session picker overlay if visible. */
  readonly hide: () => void;
}

/** Create a session picker bound to the given dependencies. */
export function createSessionPicker(deps: SessionPickerDeps): SessionPickerHandle {
  const { client, store, tui, addLifecycleMessage } = deps;
  let overlay: OverlayHandle | null = null;

  async function show(): Promise<boolean> {
    const session = store.getState().activeSession;
    if (session === null) {
      addLifecycleMessage("No active agent — select an agent first");
      return false;
    }

    const agentId = session.agentId;

    // List engine session records and TUI chat logs in parallel
    const [recordsResult, tuiResult] = await Promise.all([
      client.fsList(`/agents/${agentId}${ENGINE_SESSION_PREFIX}`),
      client.fsList(`/agents/${agentId}${TUI_SESSION_PREFIX}`),
    ]);

    const items: SelectItem[] = [];

    // Build set of session IDs that have TUI chat logs (restorable history)
    const tuiSessionIds = new Set<string>();
    if (tuiResult.ok) {
      for (const entry of tuiResult.value) {
        if (entry.name.endsWith(".jsonl")) {
          tuiSessionIds.add(entry.name.replace(/\.jsonl$/, ""));
        }
      }
    }

    // Parse engine SessionRecord files for session metadata
    if (recordsResult.ok) {
      const infos = await loadSessionInfos(agentId, recordsResult.value);
      for (const info of infos) {
        const date = new Date(info.connectedAt).toLocaleString();
        const hasChatLog = tuiSessionIds.has(info.sessionId);
        items.push({
          value: info.sessionId,
          label: `${info.sessionId.slice(0, 12)}…`,
          description: hasChatLog
            ? `${info.agentName} — ${date}`
            : `${info.agentName} — ${date} (no chat history)`,
        });
      }
    }

    // Add TUI chat log entries (these have local message history)
    if (tuiResult.ok) {
      for (const entry of tuiResult.value) {
        if (!entry.name.endsWith(".jsonl")) continue;
        const sid = entry.name.replace(/\.jsonl$/, "");
        // Skip if already listed from engine records
        if (items.some((i) => i.value === sid)) continue;
        items.push({
          value: sid,
          label: sid,
          description: "TUI chat log",
        });
      }
    }

    if (items.length === 0) {
      addLifecycleMessage("No saved sessions found");
      return false;
    }

    const picker = new SelectList([...items], Math.min(items.length, 10), KOI_SELECT_THEME);

    picker.onSelect = (item: SelectItem) => {
      hide();
      loadSession(agentId, item.value).catch(() => {
        addLifecycleMessage("Failed to load session");
      });
    };

    picker.onCancel = () => {
      hide();
    };

    overlay = tui.showOverlay(picker, {
      width: "60%",
      maxHeight: "50%",
      anchor: "top-center",
      offsetY: 3,
    });

    return true;
  }

  function hide(): void {
    if (overlay !== null) {
      overlay.hide();
      overlay = null;
    }
  }

  /** Load SessionRecord files and extract metadata. */
  async function loadSessionInfos(
    _agentId: string,
    entries: readonly {
      readonly name: string;
      readonly path: string;
      readonly isDirectory: boolean;
    }[],
  ): Promise<readonly SessionInfo[]> {
    const infos: SessionInfo[] = [];
    const jsonFiles = entries.filter((e) => e.name.endsWith(".json") && !e.isDirectory);
    // Load up to 20 most recent records
    const toLoad = jsonFiles.slice(-20);

    for (const entry of toLoad) {
      const content = await client.fsRead(entry.path);
      if (!content.ok) continue;
      const info = parseSessionRecord(typeof content.value === "string" ? content.value : "");
      if (info !== null) {
        infos.push({ ...info, path: entry.path });
      }
    }

    return infos;
  }

  /** Load a session by sessionId — tries TUI chat log first, falls back to event log. */
  async function loadSession(agentId: string, sessionId: string): Promise<void> {
    // Try to load TUI chat log for message history
    const tuiLogPath = `/agents/${agentId}${TUI_SESSION_PREFIX}/${sessionId}.jsonl`;
    const logResult = await client.fsRead(tuiLogPath);
    const messages = logResult.ok
      ? parseTuiChatLog(typeof logResult.value === "string" ? logResult.value : "")
      : [];

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

    if (messages.length > 0) {
      addLifecycleMessage(`Loaded session: ${sessionId} (${String(messages.length)} messages)`);
    } else {
      // No TUI chat log — fetch recent agent events as context
      addLifecycleMessage(`Resumed session ${sessionId} (no prior chat history)`);
      await loadRecentActivity(agentId);
    }
  }

  /** Fetch recent agent events and display as lifecycle context. */
  async function loadRecentActivity(agentId: string): Promise<void> {
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
    if (tail.length > 0) addLifecycleMessage(`Recent activity:\n${tail.join("\n")}`);
  }

  return { show, hide };
}

/** Parse a SessionRecord JSON file to extract session metadata. */
export function parseSessionRecord(content: string): Omit<SessionInfo, "path"> | null {
  if (content.trim() === "") return null;

  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) return null;

    const record = parsed as Record<string, unknown>;
    const sessionId = record.sessionId;
    if (typeof sessionId !== "string") return null;

    const connectedAt = typeof record.connectedAt === "number" ? record.connectedAt : Date.now();

    // Extract agent name from manifest snapshot if available
    let agentName = "unknown";
    const manifest = record.manifestSnapshot;
    if (typeof manifest === "object" && manifest !== null) {
      const name = (manifest as Record<string, unknown>).name;
      if (typeof name === "string") {
        agentName = name;
      }
    }

    return { sessionId, connectedAt, agentName };
  } catch {
    return null;
  }
}

/** Parse TUI chat log (JSON-lines format) into ChatMessage array. */
export function parseTuiChatLog(content: string): readonly ChatMessage[] {
  if (content.trim() === "") return [];

  const lines = content.split("\n").filter((l) => l.trim() !== "");
  const messages: ChatMessage[] = [];
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && "kind" in parsed) {
        const msg = parsed as Record<string, unknown>;
        const kind = msg.kind;
        if (
          kind === "user" ||
          kind === "assistant" ||
          kind === "lifecycle" ||
          kind === "tool_call"
        ) {
          messages.push(parsed as ChatMessage);
        }
      }
    } catch {
      // Not JSON — skip line
    }
  }

  return messages;
}
