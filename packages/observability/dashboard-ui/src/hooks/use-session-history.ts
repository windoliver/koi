/**
 * useSessionHistory — list and load previous chat sessions for an agent.
 *
 * Sessions are stored as JSONL files at /agents/{agentId}/session/chat/{sessionId}.jsonl
 * (same format as TUI, compatible with session-picker.ts).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { FsEntry } from "../lib/api-client.js";
import { fetchFsList, fetchFsRead, saveFile } from "../lib/api-client.js";
import type { ChatMessage } from "../stores/chat-store.js";
import { useChatStore } from "../stores/chat-store.js";

/** Path constants matching TUI conventions. */
const CHAT_SESSION_PREFIX = "/session/chat";

/** A discovered session entry with metadata. */
export interface SessionEntry {
  readonly sessionId: string;
  readonly path: string;
  readonly modifiedAt: number;
  readonly size: number;
}

export interface UseSessionHistoryResult {
  readonly sessions: readonly SessionEntry[];
  readonly isLoading: boolean;
  /** Load a previous session's messages into the chat store. */
  readonly loadSession: (entry: SessionEntry) => Promise<void>;
  /** Refresh the session list. */
  readonly refresh: () => void;
  /** Persist current session messages to filesystem. */
  readonly persistCurrentSession: () => Promise<void>;
}

/** Parse JSONL content into ChatMessage array. */
function parseChatLog(content: string): readonly ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isValidChatMessage(parsed)) {
        messages.push(parsed);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return messages;
}

/** Minimal validation that parsed JSON is a ChatMessage. */
function isValidChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.kind === "string" &&
    typeof obj.timestamp === "number" &&
    (obj.kind === "user" ||
      obj.kind === "assistant" ||
      obj.kind === "tool_call" ||
      obj.kind === "lifecycle")
  );
}

/** Extract sessionId from a path like .../session/chat/sess-abc123.jsonl */
function extractSessionId(path: string): string {
  const filename = path.split("/").pop() ?? "";
  return filename.replace(/\.jsonl$/, "");
}

export function useSessionHistory(agentId: string): UseSessionHistoryResult {
  const [sessions, setSessions] = useState<readonly SessionEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const mountedRef = useRef(true);

  const listSessions = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    try {
      const basePath = `/agents/${agentId}${CHAT_SESSION_PREFIX}`;
      let entries: readonly FsEntry[];
      try {
        entries = await fetchFsList(basePath, { glob: "*.jsonl" });
      } catch {
        // Directory may not exist yet — no sessions
        entries = [];
      }

      if (!mountedRef.current) return;

      const sorted = [...entries]
        .filter((e) => !e.isDirectory && e.name.endsWith(".jsonl"))
        .sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0))
        .map(
          (e): SessionEntry => ({
            sessionId: extractSessionId(e.path),
            path: e.path,
            modifiedAt: e.modifiedAt ?? 0,
            size: e.size ?? 0,
          }),
        );

      setSessions(sorted);
    } catch {
      // Silently fail — session list is non-critical
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    mountedRef.current = true;
    void listSessions();
    return () => {
      mountedRef.current = false;
    };
  }, [listSessions]);

  const loadSession = useCallback(
    async (entry: SessionEntry): Promise<void> => {
      try {
        const result = await fetchFsRead(entry.path);
        const messages = parseChatLog(result.content);

        const store = useChatStore.getState();
        // Use the file stem as both sessionId and threadId so the server
        // can match the conversation thread when the session is resumed.
        store.setSession({
          agentId,
          sessionId: entry.sessionId,
          threadId: entry.sessionId,
        });
        store.loadMessages(messages);
      } catch {
        useChatStore.getState().setError("Failed to load session");
      }
    },
    [agentId],
  );

  const persistCurrentSession = useCallback(async (): Promise<void> => {
    const state = useChatStore.getState();
    if (state.session === null || state.messages.length === 0) return;

    // Use threadId as filename so browser and server write to the same file.
    const path = `/agents/${agentId}${CHAT_SESSION_PREFIX}/${state.session.threadId}.jsonl`;
    const content = state.messages.map((m) => JSON.stringify(m)).join("\n");

    try {
      await saveFile(path, content);
    } catch {
      // Best-effort — don't block on failure
    }
  }, [agentId]);

  return { sessions, isLoading, loadSession, refresh: listSessions, persistCurrentSession };
}
