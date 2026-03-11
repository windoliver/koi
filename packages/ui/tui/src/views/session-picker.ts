/**
 * Session picker — interactive overlay for browsing and reopening saved sessions.
 *
 * Shows a SelectList of available sessions for the current agent.
 * On selection, loads session content and populates the active session state.
 */

import { type OverlayHandle, type SelectItem, SelectList, type TUI } from "@mariozechner/pi-tui";
import type { AdminClient } from "../client/admin-client.js";
import type { TuiStore } from "../state/store.js";
import type { ChatMessage } from "../state/types.js";
import { KOI_SELECT_THEME } from "../theme.js";

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
    const result = await client.fsList(`/agents/${agentId}/session`);
    if (!result.ok) {
      addLifecycleMessage(`Failed to list sessions: ${result.error.kind}`);
      return false;
    }

    const sessions = result.value;
    if (sessions.length === 0) {
      addLifecycleMessage("No saved sessions found");
      return false;
    }

    const items: readonly SelectItem[] = sessions.map((entry) => ({
      value: entry.path,
      label: entry.name,
      description: entry.isDirectory ? "session folder" : "session file",
    }));

    const picker = new SelectList([...items], Math.min(sessions.length, 10), KOI_SELECT_THEME);

    picker.onSelect = (item: SelectItem) => {
      hide();
      loadSession(agentId, item.value, item.label).catch(() => {
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

  async function loadSession(
    agentId: string,
    sessionPath: string,
    sessionName: string,
  ): Promise<void> {
    const content = await client.fsRead(sessionPath);
    if (!content.ok) {
      addLifecycleMessage(`Failed to load session: ${content.error.kind}`);
      return;
    }

    const messages = parseSessionMessages(typeof content.value === "string" ? content.value : "");

    store.dispatch({
      kind: "set_session",
      session: {
        agentId,
        sessionId: sessionName,
        messages,
        pendingText: "",
        isStreaming: false,
      },
    });
    store.dispatch({ kind: "set_view", view: "console" });
    addLifecycleMessage(`Loaded session: ${sessionName} (${String(messages.length)} messages)`);
  }

  return { show, hide };
}

/** Parse stored session content into ChatMessage array. */
export function parseSessionMessages(content: string): readonly ChatMessage[] {
  if (content.trim() === "") return [];

  // Try JSON-lines format (one JSON message per line)
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

  // If JSON-lines worked, return
  if (messages.length > 0) return messages;

  // Fallback: treat entire content as a single lifecycle event
  return [{ kind: "lifecycle", event: content.slice(0, 2000), timestamp: Date.now() }];
}
