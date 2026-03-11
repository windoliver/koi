/**
 * AG-UI SSE client for streaming agent chat.
 *
 * Connects to the AG-UI endpoint (POST /agent → SSE stream)
 * and parses the event protocol for the TUI console view.
 */

import type { TuiError } from "../state/types.js";
import { type SSEEvent, SSEParser } from "./sse-stream.js";

// ─── AG-UI Event Types ───────────────────────────────────────────────

/** AG-UI SSE event types emitted by @koi/channel-agui. */
export type AguiEventType =
  | "RUN_STARTED"
  | "RUN_FINISHED"
  | "RUN_ERROR"
  | "STATE_SNAPSHOT"
  | "STATE_DELTA"
  | "STEP_STARTED"
  | "STEP_FINISHED"
  | "TEXT_MESSAGE_START"
  | "TEXT_MESSAGE_CONTENT"
  | "TEXT_MESSAGE_END"
  | "REASONING_MESSAGE_START"
  | "REASONING_MESSAGE_CONTENT"
  | "REASONING_MESSAGE_END"
  | "TOOL_CALL_START"
  | "TOOL_CALL_ARGS"
  | "TOOL_CALL_END"
  | "TOOL_CALL_RESULT"
  | "CUSTOM";

/** Parsed AG-UI event with typed fields. */
export type AguiEvent =
  | { readonly type: "RUN_STARTED"; readonly threadId: string; readonly runId: string }
  | { readonly type: "RUN_FINISHED"; readonly threadId: string; readonly runId: string }
  | { readonly type: "RUN_ERROR"; readonly message: string }
  | { readonly type: "STATE_SNAPSHOT"; readonly snapshot: unknown }
  | { readonly type: "STATE_DELTA"; readonly delta: unknown }
  | { readonly type: "STEP_STARTED"; readonly stepName: string }
  | { readonly type: "STEP_FINISHED"; readonly stepName: string }
  | {
      readonly type: "TEXT_MESSAGE_START";
      readonly messageId: string;
      readonly role: string;
    }
  | {
      readonly type: "TEXT_MESSAGE_CONTENT";
      readonly messageId: string;
      readonly delta: string;
    }
  | { readonly type: "TEXT_MESSAGE_END"; readonly messageId: string }
  | {
      readonly type: "REASONING_MESSAGE_START";
      readonly messageId: string;
    }
  | {
      readonly type: "REASONING_MESSAGE_CONTENT";
      readonly messageId: string;
      readonly delta: string;
    }
  | { readonly type: "REASONING_MESSAGE_END"; readonly messageId: string }
  | {
      readonly type: "TOOL_CALL_START";
      readonly toolCallId: string;
      readonly toolCallName: string;
    }
  | {
      readonly type: "TOOL_CALL_ARGS";
      readonly toolCallId: string;
      readonly delta: string;
    }
  | { readonly type: "TOOL_CALL_END"; readonly toolCallId: string }
  | {
      readonly type: "TOOL_CALL_RESULT";
      readonly toolCallId: string;
      readonly result: string;
    }
  | {
      readonly type: "CUSTOM";
      readonly name: string;
      readonly value: unknown;
    };

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

/** Input for starting a chat run. */
export interface ChatRunInput {
  readonly threadId: string;
  readonly runId: string;
  readonly message: string;
  /** Prior messages for context (optional — agent may have memory middleware). */
  readonly history?: readonly ChatHistoryMessage[];
}

/** Minimal message shape for AG-UI history. */
export interface ChatHistoryMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
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

// ─── Event Parsing ───────────────────────────────────────────────────

/** Parse a raw SSE event into a typed AguiEvent. */
function parseAguiEvent(sse: SSEEvent): AguiEvent | null {
  try {
    const data: unknown = JSON.parse(sse.data);
    if (typeof data !== "object" || data === null) return null;

    const obj = data as Record<string, unknown>;
    const type = obj.type;
    if (typeof type !== "string") return null;

    return data as AguiEvent;
  } catch {
    // Malformed JSON — skip
    return null;
  }
}

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
