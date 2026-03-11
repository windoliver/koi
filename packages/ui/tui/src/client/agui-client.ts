/**
 * AG-UI SSE client for streaming agent chat.
 *
 * Connects to the AG-UI endpoint (POST /agent → SSE stream)
 * and parses the event protocol for the TUI console view.
 *
 * AG-UI types and SSE parser are imported from @koi/dashboard-types
 * (shared with @koi/dashboard-ui).
 */

import type { AguiEvent, ChatRunInput } from "@koi/dashboard-types";
import { parseAguiEvent, SSEParser } from "@koi/dashboard-types";
import type { TuiError } from "../state/types.js";

// Re-export shared types for existing consumers
export type {
  AguiEvent,
  AguiEventType,
  ChatHistoryMessage,
  ChatRunInput,
} from "@koi/dashboard-types";

// ─── Client Configuration ────────────────────────────────────────────

/** Configuration for the AG-UI chat client. */
export interface AguiClientConfig {
  /** Base URL of the AG-UI endpoint (e.g., "http://localhost:3100"). */
  readonly baseUrl: string;
  /** Path to the AG-UI endpoint (default: "/agent"). */
  readonly path?: string;
  /** Optional auth token. */
  readonly authToken?: string;
  /** Request timeout in milliseconds (default: 120000 — 2 minutes for LLM calls). */
  readonly timeoutMs?: number;
}

/** Callbacks for AG-UI stream events. */
export interface AguiStreamCallbacks {
  readonly onEvent: (event: AguiEvent) => void;
  readonly onClose?: () => void;
  readonly onError?: (error: TuiError) => void;
}

// ─── Client Implementation ───────────────────────────────────────────

/** AG-UI chat client handle with cancel support. */
export interface AguiStreamHandle {
  /** Cancel the active stream. */
  readonly cancel: () => void;
  /** Promise that resolves when the stream ends (or is cancelled). */
  readonly done: Promise<void>;
}

/**
 * Start a chat run via AG-UI POST + SSE stream.
 *
 * Returns a handle for cancelling and awaiting completion.
 */
export function startChatStream(
  config: AguiClientConfig,
  input: ChatRunInput,
  callbacks: AguiStreamCallbacks,
): AguiStreamHandle {
  const { baseUrl, path = "/agent", authToken, timeoutMs = 120_000 } = config;
  const controller = new AbortController();

  const messages = [
    ...(input.history ?? []).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
    })),
    {
      id: `msg-${Date.now().toString(36)}`,
      role: "user" as const,
      content: input.message,
    },
  ];

  const body = JSON.stringify({
    threadId: input.threadId,
    runId: input.runId,
    messages,
    tools: [],
    context: [],
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken !== undefined) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const done = (async (): Promise<void> => {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        callbacks.onError?.({
          kind: "api_error",
          code: String(response.status),
          message: text || `HTTP ${String(response.status)}`,
        });
        return;
      }

      const reader = response.body?.getReader();
      if (reader === undefined) {
        callbacks.onClose?.();
        return;
      }

      const parser = new SSEParser();
      const decoder = new TextDecoder();

      for (;;) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;

        const chunk = decoder.decode(value, { stream: true });
        const sseEvents = parser.feed(chunk);

        for (const sse of sseEvents) {
          const parsed = parseAguiEvent(sse);
          if (parsed !== null) {
            callbacks.onEvent(parsed);
          }
        }
      }

      callbacks.onClose?.();
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        callbacks.onClose?.();
      } else {
        callbacks.onError?.(mapStreamError(error, baseUrl, timeoutMs));
      }
    } finally {
      clearTimeout(timer);
    }
  })();

  return {
    cancel: () => {
      controller.abort();
    },
    done,
  };
}

// ─── Error Mapping ──────────────────────────────────────────────────

/** Map a stream error to TuiError. */
function mapStreamError(error: unknown, url: string, timeoutMs: number): TuiError {
  if (error instanceof DOMException && error.name === "AbortError") {
    return { kind: "timeout", operation: "chat_stream", ms: timeoutMs };
  }
  if (error instanceof TypeError) {
    return { kind: "connection_refused", url };
  }
  return { kind: "unexpected", cause: error };
}
