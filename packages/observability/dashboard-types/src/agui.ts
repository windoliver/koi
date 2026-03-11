/**
 * AG-UI (Agent-User Interaction) protocol types and validated parser.
 *
 * Shared between @koi/tui and @koi/dashboard-ui for streaming agent chat.
 * Protocol: HTTP POST → SSE stream of typed JSON events.
 */

import type { SSEEvent } from "./sse-parser.js";

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

// ─── Chat Input Types ───────────────────────────────────────────────

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

// ─── Validated Parser ───────────────────────────────────────────────

/**
 * Parse a raw SSE event into a typed AguiEvent with field validation.
 *
 * Returns null for:
 * - Malformed JSON
 * - Missing `type` field
 * - Missing required fields for the given event type
 */
export function parseAguiEvent(sse: SSEEvent): AguiEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(sse.data);
  } catch {
    return null;
  }

  if (typeof data !== "object" || data === null) return null;

  const obj = data as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== "string") return null;

  // Validate required fields per event type
  switch (type) {
    case "RUN_STARTED":
    case "RUN_FINISHED":
      if (!isString(obj.threadId) || !isString(obj.runId)) return null;
      break;
    case "RUN_ERROR":
      if (!isString(obj.message)) return null;
      break;
    case "STATE_SNAPSHOT":
      // snapshot can be any value — no extra validation needed
      break;
    case "STATE_DELTA":
      // delta can be any value — no extra validation needed
      break;
    case "STEP_STARTED":
    case "STEP_FINISHED":
      if (!isString(obj.stepName)) return null;
      break;
    case "TEXT_MESSAGE_START":
      if (!isString(obj.messageId) || !isString(obj.role)) return null;
      break;
    case "TEXT_MESSAGE_CONTENT":
      if (!isString(obj.messageId) || !isString(obj.delta)) return null;
      break;
    case "TEXT_MESSAGE_END":
      if (!isString(obj.messageId)) return null;
      break;
    case "REASONING_MESSAGE_START":
    case "REASONING_MESSAGE_END":
      if (!isString(obj.messageId)) return null;
      break;
    case "REASONING_MESSAGE_CONTENT":
      if (!isString(obj.messageId) || !isString(obj.delta)) return null;
      break;
    case "TOOL_CALL_START":
      if (!isString(obj.toolCallId) || !isString(obj.toolCallName)) return null;
      break;
    case "TOOL_CALL_ARGS":
      if (!isString(obj.toolCallId) || !isString(obj.delta)) return null;
      break;
    case "TOOL_CALL_END":
      if (!isString(obj.toolCallId)) return null;
      break;
    case "TOOL_CALL_RESULT":
      if (!isString(obj.toolCallId) || !isString(obj.result)) return null;
      break;
    case "CUSTOM":
      if (!isString(obj.name)) return null;
      break;
    default:
      // Unknown event type — reject
      return null;
  }

  return data as AguiEvent;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
