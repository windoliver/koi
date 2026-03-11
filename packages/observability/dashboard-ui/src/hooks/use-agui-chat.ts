/**
 * useAguiChat — React hook for AG-UI streaming chat.
 *
 * Uses fetch + SSEParser from @koi/dashboard-types for POST-based SSE.
 * Implements ref-based token buffering with requestAnimationFrame flush
 * to limit re-renders to ~60fps (Issue 13A).
 */

import type { AguiEvent, ChatHistoryMessage } from "@koi/dashboard-types";
import { parseAguiEvent, SSEParser } from "@koi/dashboard-types";
import { useCallback, useEffect, useRef } from "react";
import { getDashboardConfig } from "../lib/dashboard-config.js";
import { useChatStore } from "../stores/chat-store.js";

/** Configuration for the AG-UI chat hook. */
export interface UseAguiChatOptions {
  /** Agent ID to chat with. */
  readonly agentId: string;
  /** Optional auth token. */
  readonly authToken?: string;
  /** Request timeout in milliseconds (default: 120000). */
  readonly timeoutMs?: number;
}

export interface UseAguiChatResult {
  /** Send a message to the agent. Starts an AG-UI stream. */
  readonly sendMessage: (text: string, history?: readonly ChatHistoryMessage[]) => void;
  /** Cancel the active stream. */
  readonly cancel: () => void;
}

/**
 * Hook for streaming AG-UI chat with an agent.
 *
 * Writes to the chat store (messages, streaming state, tool calls).
 * Token buffering is handled via ref + requestAnimationFrame.
 */
export function useAguiChat(options: UseAguiChatOptions): UseAguiChatResult {
  const { agentId, authToken, timeoutMs = 120_000 } = options;

  // Ref-based token buffer (no re-renders on token accumulation)
  const tokenBufferRef = useRef("");
  const rafIdRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Flush token buffer to store on requestAnimationFrame
  const flushBuffer = useCallback(() => {
    const buffer = tokenBufferRef.current;
    if (buffer !== "") {
      tokenBufferRef.current = "";
      const store = useChatStore.getState();
      store.appendTokens(buffer);
      store.flushTokens();
    }
    rafIdRef.current = null;
  }, []);

  // Schedule a flush on next animation frame (coalesces multiple tokens)
  const scheduleFlush = useCallback(() => {
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(flushBuffer);
    }
  }, [flushBuffer]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
      // Final flush of any remaining tokens
      if (tokenBufferRef.current !== "") {
        const store = useChatStore.getState();
        store.appendTokens(tokenBufferRef.current);
        store.flushTokens();
        tokenBufferRef.current = "";
      }
    };
  }, []);

  const handleEvent = useCallback(
    (event: AguiEvent): void => {
      const store = useChatStore.getState();

      switch (event.type) {
        case "RUN_STARTED":
          store.setStreaming(true);
          store.setError(null);
          break;

        case "RUN_FINISHED":
          // Final flush before ending
          if (tokenBufferRef.current !== "") {
            store.appendTokens(tokenBufferRef.current);
            tokenBufferRef.current = "";
          }
          store.flushTokens();
          store.setStreaming(false);
          break;

        case "RUN_ERROR":
          store.setStreaming(false);
          store.setError(event.message);
          break;

        case "TEXT_MESSAGE_START":
          // Nothing to do — tokens come via TEXT_MESSAGE_CONTENT
          break;

        case "TEXT_MESSAGE_CONTENT":
          tokenBufferRef.current += event.delta;
          scheduleFlush();
          break;

        case "TEXT_MESSAGE_END":
          // Final flush for this message
          if (tokenBufferRef.current !== "") {
            store.appendTokens(tokenBufferRef.current);
            tokenBufferRef.current = "";
          }
          store.flushTokens();
          break;

        case "TOOL_CALL_START":
          store.startToolCall(event.toolCallId, event.toolCallName);
          break;

        case "TOOL_CALL_ARGS":
          store.appendToolCallArgs(event.toolCallId, event.delta);
          break;

        case "TOOL_CALL_END":
          // Tool call args complete, wait for result
          break;

        case "TOOL_CALL_RESULT":
          store.finishToolCall(event.toolCallId, event.result);
          break;

        case "REASONING_MESSAGE_START":
        case "REASONING_MESSAGE_CONTENT":
        case "REASONING_MESSAGE_END":
          // Reasoning messages are not displayed in the console currently
          break;

        case "STEP_STARTED":
          store.addMessage({
            kind: "lifecycle",
            event: `Step: ${event.stepName}`,
            timestamp: Date.now(),
          });
          break;

        case "STEP_FINISHED":
          // No explicit UI for step completion
          break;

        case "STATE_SNAPSHOT":
        case "STATE_DELTA":
        case "CUSTOM":
          // These events are not displayed in the basic console
          break;
      }
    },
    [scheduleFlush],
  );

  const sendMessage = useCallback(
    (text: string, history?: readonly ChatHistoryMessage[]): void => {
      // Cancel any existing stream
      abortRef.current?.abort();

      const controller = new AbortController();
      abortRef.current = controller;

      const store = useChatStore.getState();
      store.addMessage({ kind: "user", text, timestamp: Date.now() });
      store.setStreaming(true);
      store.setError(null);

      const { apiPath } = getDashboardConfig();
      const threadId = store.session?.threadId ?? `thread-${Date.now().toString(36)}`;
      const runId = `run-${Date.now().toString(36)}`;

      const messages = [
        ...(history ?? []).map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
        })),
        {
          id: `msg-${Date.now().toString(36)}`,
          role: "user" as const,
          content: text,
        },
      ];

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (authToken !== undefined) {
        headers.Authorization = `Bearer ${authToken}`;
      }

      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      void (async (): Promise<void> => {
        try {
          const response = await fetch(`${apiPath}/agents/${encodeURIComponent(agentId)}/chat`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              threadId,
              runId,
              messages,
              tools: [],
              context: [],
            }),
            signal: controller.signal,
          });

          if (!response.ok) {
            const errorText = await response.text().catch(() => "");
            store.setStreaming(false);
            store.setError(errorText || `HTTP ${String(response.status)}`);
            return;
          }

          const reader = response.body?.getReader();
          if (reader === undefined) {
            store.setStreaming(false);
            return;
          }

          const parser = new SSEParser();
          const decoder = new TextDecoder();

          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const sseEvents = parser.feed(chunk);

            for (const sse of sseEvents) {
              const parsed = parseAguiEvent(sse);
              if (parsed !== null) {
                handleEvent(parsed);
              }
            }
          }

          // Stream ended normally — ensure streaming flag is off
          const currentState = useChatStore.getState();
          if (currentState.isStreaming) {
            currentState.setStreaming(false);
          }
        } catch (error: unknown) {
          if (controller.signal.aborted) {
            useChatStore.getState().setStreaming(false);
          } else {
            const msg =
              error instanceof TypeError
                ? "Connection refused"
                : error instanceof Error
                  ? error.message
                  : "Unexpected error";
            const currentStore = useChatStore.getState();
            currentStore.setStreaming(false);
            currentStore.setError(msg);
          }
        } finally {
          clearTimeout(timer);
          if (abortRef.current === controller) {
            abortRef.current = null;
          }
        }
      })();
    },
    [agentId, authToken, timeoutMs, handleEvent],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    // Flush remaining tokens
    if (tokenBufferRef.current !== "") {
      const store = useChatStore.getState();
      store.appendTokens(tokenBufferRef.current);
      store.flushTokens();
      tokenBufferRef.current = "";
    }
    useChatStore.getState().setStreaming(false);
  }, []);

  return { sendMessage, cancel };
}
