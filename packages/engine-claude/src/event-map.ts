/**
 * SDKMessage → EngineEvent mapping.
 *
 * Converts Claude Agent SDK streaming messages into Koi EngineEvents.
 * Separated into text, tool, and result mappers for testability.
 */

import type {
  EngineEvent,
  EngineOutput,
  EngineStopReason,
  JsonObject,
  ToolCallId,
} from "@koi/core";
import { toolCallId } from "@koi/core";
import type { SdkResultFields } from "./metrics.js";
import { mapMetrics, mapRichMetadata } from "./metrics.js";

// ---------------------------------------------------------------------------
// SDK message shapes — minimal structural types to avoid SDK type import leaks
// ---------------------------------------------------------------------------

/** Partial content block element (for array-shaped tool_result content). */
export interface SdkContentBlockElement {
  readonly type: string;
  readonly text?: string;
}

/** Partial assistant message content block. */
export interface SdkContentBlock {
  readonly type: string;
  readonly id?: string;
  readonly name?: string;
  readonly text?: string;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly partial_json?: string;
  /** tool_result blocks: the ID of the tool_use this result corresponds to. */
  readonly tool_use_id?: string;
  /** tool_result blocks: the result content (string or structured array). */
  readonly content?: string | readonly SdkContentBlockElement[];
}

/** Partial assistant message from SDK streaming. */
export interface SdkAssistantMessage {
  readonly type: "assistant";
  readonly message?: {
    readonly content?: readonly SdkContentBlock[];
  };
  readonly parent_tool_use_id?: string;
}

/** Streaming event from SDK (content_block_start/delta/stop). */
export interface SdkStreamEvent {
  readonly type: string;
  readonly index?: number;
  readonly content_block?: SdkContentBlock;
  readonly delta?: {
    readonly type?: string;
    readonly text?: string;
    readonly partial_json?: string;
  };
}

/** SDK result message. */
export interface SdkResultMessage {
  readonly type: "result";
  readonly subtype: string;
  readonly session_id?: string;
  readonly result?: string;
  readonly errors?: readonly string[];
  readonly permission_denials?: readonly {
    readonly tool_name: string;
    readonly tool_use_id: string;
  }[];
  readonly num_turns?: number;
  readonly duration_ms?: number;
  readonly duration_api_ms?: number;
  readonly total_cost_usd?: number;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_read_input_tokens?: number;
    readonly cache_creation_input_tokens?: number;
  };
  readonly modelUsage?: Readonly<Record<string, unknown>>;
}

/** SDK user message (contains tool results). */
export interface SdkUserMessage {
  readonly type: "user";
  readonly message?: {
    readonly content?: readonly SdkContentBlock[];
  };
  readonly parent_tool_use_id?: string;
}

/** SDK system message. */
export interface SdkSystemMessage {
  readonly type: "system";
  readonly subtype?: string;
  readonly session_id?: string;
  readonly compact_metadata?: {
    readonly trigger: string;
    readonly pre_tokens: number;
  };
}

/** SDK partial assistant message with streaming event (includePartialMessages: true). */
export interface SdkStreamEventMessage {
  readonly type: "stream_event";
  readonly event?: SdkStreamEvent;
  readonly session_id?: string;
}

/** Union of SDK message types we handle. */
export type SdkMessage =
  | SdkAssistantMessage
  | SdkUserMessage
  | SdkResultMessage
  | SdkSystemMessage
  | SdkStreamEventMessage
  | { readonly type: string };

// ---------------------------------------------------------------------------
// Result subtype → EngineStopReason mapping
// ---------------------------------------------------------------------------

/**
 * Map SDK result subtype to EngineStopReason with exhaustive switch.
 */
export function mapStopReason(subtype: string): EngineStopReason {
  switch (subtype) {
    case "success":
      return "completed";
    case "error_max_turns":
      return "max_turns";
    case "error_max_budget_usd":
      return "interrupted";
    case "error_during_execution":
      return "error";
    case "error_max_structured_output_retries":
      return "error";
    default:
      return "error";
  }
}

// ---------------------------------------------------------------------------
// Assistant message → EngineEvent[] mapping
// ---------------------------------------------------------------------------

/**
 * Extract EngineEvents from a complete assistant message (non-streaming).
 *
 * For each text block → text_delta event.
 * For each tool_use block → tool_call_start (with args) event.
 */
export function mapAssistantMessage(msg: SdkAssistantMessage): readonly EngineEvent[] {
  const content = msg.message?.content;
  if (content === undefined || content.length === 0) return [];

  const events: EngineEvent[] = [];

  for (const block of content) {
    switch (block.type) {
      case "text":
        if (block.text !== undefined && block.text.length > 0) {
          events.push({ kind: "text_delta", delta: block.text });
        }
        break;
      case "tool_use":
        if (block.id !== undefined && block.name !== undefined) {
          events.push({
            kind: "tool_call_start",
            toolName: block.name,
            callId: toolCallId(block.id),
            args: (block.input ?? {}) as JsonObject,
          });
        }
        break;
      default:
        break;
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// User message → tool_call_end EngineEvents
// ---------------------------------------------------------------------------

/**
 * Extract tool_call_end events from a user message containing tool_result blocks.
 *
 * The SDK sends tool execution results inside user messages. Each tool_result
 * block maps to a tool_call_end event with the execution result.
 */
export function mapUserMessage(msg: SdkUserMessage): readonly EngineEvent[] {
  const content = msg.message?.content;
  if (content === undefined || content.length === 0) return [];

  const events: EngineEvent[] = [];

  for (const block of content) {
    if (block.type === "tool_result" && block.tool_use_id !== undefined) {
      const resultText =
        typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c) => c.text ?? "").join("")
            : "";
      events.push({
        kind: "tool_call_end",
        callId: toolCallId(block.tool_use_id),
        result: resultText,
      });
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Result message → done EngineEvent
// ---------------------------------------------------------------------------

/**
 * Map SDK result message to a `done` EngineEvent.
 */
export function mapResultMessage(msg: SdkResultMessage): EngineEvent {
  const stopReason = mapStopReason(msg.subtype);
  const resultFields: SdkResultFields = msg;
  const metrics = mapMetrics(resultFields);
  const metadata = mapRichMetadata(resultFields);

  const resultText = msg.result ?? "";
  const output: EngineOutput = {
    content: resultText.length > 0 ? [{ kind: "text", text: resultText }] : [],
    stopReason,
    metrics,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };

  return { kind: "done", output };
}

// ---------------------------------------------------------------------------
// Streaming event mapper
// ---------------------------------------------------------------------------

/**
 * Stateful event mapper for SDK streaming messages.
 *
 * Tracks tool call context across content_block_start/delta/stop events
 * and emits corresponding EngineEvents.
 */
export interface StreamEventMapper {
  /** Map a single SDK stream event to zero or more EngineEvents. */
  readonly map: (event: SdkStreamEvent) => readonly EngineEvent[];
}

/**
 * Create a streaming event mapper that converts SDK content block events
 * to EngineEvents.
 */
export function createStreamEventMapper(): StreamEventMapper {
  // Track active tool call IDs by content block index
  const activeToolCalls = new Map<
    number,
    { readonly callId: ToolCallId; readonly toolName: string }
  >();

  return {
    map(event: SdkStreamEvent): readonly EngineEvent[] {
      switch (event.type) {
        case "content_block_start": {
          const block = event.content_block;
          if (block === undefined) return [];

          if (block.type === "tool_use" && block.id !== undefined && block.name !== undefined) {
            const cid = toolCallId(block.id);
            if (event.index !== undefined) {
              activeToolCalls.set(event.index, { callId: cid, toolName: block.name });
            }
            return [
              {
                kind: "tool_call_start",
                toolName: block.name,
                callId: cid,
              },
            ];
          }
          return [];
        }

        case "content_block_delta": {
          const delta = event.delta;
          if (delta === undefined) return [];

          if (delta.type === "text_delta" && delta.text !== undefined && delta.text.length > 0) {
            return [{ kind: "text_delta", delta: delta.text }];
          }

          if (delta.type === "input_json_delta" && delta.partial_json !== undefined) {
            const toolInfo =
              event.index !== undefined ? activeToolCalls.get(event.index) : undefined;
            if (toolInfo !== undefined) {
              return [
                {
                  kind: "tool_call_delta",
                  callId: toolInfo.callId,
                  delta: delta.partial_json,
                },
              ];
            }
          }
          return [];
        }

        case "content_block_stop": {
          if (event.index !== undefined) {
            activeToolCalls.delete(event.index);
          }
          return [];
        }

        default:
          return [];
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Top-level message mapper
// ---------------------------------------------------------------------------

/**
 * Map a full SDK message to EngineEvents.
 *
 * Returns the events plus optional session_id if this was an init message.
 */
export interface MapResult {
  readonly events: readonly EngineEvent[];
  readonly sessionId?: string;
  readonly isDone: boolean;
}

/**
 * Map a single SDK message to EngineEvents and metadata.
 */
export function mapSdkMessage(msg: SdkMessage): MapResult {
  switch (msg.type) {
    case "system": {
      const systemMsg = msg as SdkSystemMessage;
      if (systemMsg.subtype === "init" && systemMsg.session_id !== undefined) {
        return { events: [], sessionId: systemMsg.session_id, isDone: false };
      }
      if (systemMsg.subtype === "compact_boundary") {
        return {
          events: [
            {
              kind: "custom",
              type: "compact_boundary",
              data: {
                sessionId: systemMsg.session_id,
                ...(systemMsg.compact_metadata !== undefined
                  ? { compactMetadata: systemMsg.compact_metadata }
                  : {}),
              },
            },
          ],
          isDone: false,
        };
      }
      return { events: [], isDone: false };
    }

    case "user": {
      const userMsg = msg as SdkUserMessage;
      const events = mapUserMessage(userMsg);
      return { events, isDone: false };
    }

    case "assistant": {
      const assistantMsg = msg as SdkAssistantMessage;
      const events = mapAssistantMessage(assistantMsg);
      return { events, isDone: false };
    }

    case "result": {
      const resultMsg = msg as SdkResultMessage;
      const doneEvent = mapResultMessage(resultMsg);
      return {
        events: [doneEvent],
        ...(resultMsg.session_id !== undefined ? { sessionId: resultMsg.session_id } : {}),
        isDone: true,
      };
    }

    default:
      return { events: [], isDone: false };
  }
}

// ---------------------------------------------------------------------------
// Stateful message mapper (wraps stream + complete message handling)
// ---------------------------------------------------------------------------

/**
 * Stateful message mapper that routes `stream_event` messages to
 * the internal `StreamEventMapper` and suppresses duplicate `assistant`
 * messages when streaming is active.
 */
export interface MessageMapper {
  /** Map a single SDK message to EngineEvents and metadata. */
  readonly map: (msg: SdkMessage) => MapResult;
}

/**
 * Create a stateful message mapper.
 *
 * Holds a `StreamEventMapper` internally and tracks whether streaming
 * is active. When streaming is active, complete `assistant` messages
 * are suppressed to avoid duplicate events (the stream events already
 * emitted the granular version).
 */
export function createMessageMapper(): MessageMapper {
  const streamMapper = createStreamEventMapper();
  // let: toggled when first stream_event arrives, reset on assistant/result
  let streamingActive = false;

  return {
    map(msg: SdkMessage): MapResult {
      if (msg.type === "stream_event") {
        const streamMsg = msg as SdkStreamEventMessage;
        if (streamMsg.event === undefined) {
          return { events: [], isDone: false };
        }
        streamingActive = true;
        const events = streamMapper.map(streamMsg.event);
        return { events, isDone: false };
      }

      if (msg.type === "assistant" && streamingActive) {
        // Suppress the complete assistant message — stream events
        // already emitted the granular text_delta / tool_call_start events
        streamingActive = false;
        return { events: [], isDone: false };
      }

      // Reset streaming flag on non-stream messages
      streamingActive = false;
      return mapSdkMessage(msg);
    },
  };
}
