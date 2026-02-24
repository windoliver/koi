/**
 * Custom streamFn bridge — routes pi's LLM calls through Koi's middleware chain.
 *
 * This is the CORE of full cooperation. When pi calls streamFn(model, context, options),
 * we convert to ModelRequest, invoke callHandlers.modelStream() (which fires middleware),
 * and pump the resulting ModelChunks back as AssistantMessageEvents.
 */

import type { ModelChunk, ModelRequest, ModelStreamHandler } from "@koi/core/middleware";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { piMessagesToInbound } from "./message-map.js";
import type { PiNativeParams } from "./model-terminal.js";
import { piParamsStore } from "./model-terminal.js";

/**
 * A completed tool call accumulated from streaming chunks.
 * Shape matches pi-ai ToolCall — used to populate AssistantMessage.content.
 */
type CompletedToolCall = {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
};

/**
 * Convert a Koi ModelChunk back to a pi AssistantMessageEvent.
 * Returns undefined for chunks with no pi equivalent.
 *
 * Note: tool_call_end is handled separately in the streaming IIFE (inside
 * createBridgeStreamFn) where accumulated delta data is available to reconstruct
 * the full ToolCall object. This function returns undefined for it.
 */
export function modelChunkToAssistantEvent(
  chunk: ModelChunk,
  partial: AssistantMessage,
): AssistantMessageEvent | undefined {
  switch (chunk.kind) {
    case "text_delta":
      return { type: "text_delta", contentIndex: 0, delta: chunk.delta, partial };

    case "thinking_delta":
      return { type: "thinking_delta", contentIndex: 0, delta: chunk.delta, partial };

    case "tool_call_start":
      return { type: "toolcall_start", contentIndex: 0, partial };

    case "tool_call_delta":
      return { type: "toolcall_delta", contentIndex: 0, delta: chunk.delta, partial };

    case "tool_call_end":
      return undefined; // handled by the streaming IIFE with full accumulated data

    case "usage":
      return undefined; // usage tracked separately

    case "done":
      return { type: "done", reason: "stop", message: partial };
  }
}

/**
 * Build a final AssistantMessage from accumulated streaming data.
 * Includes both text content and any completed tool calls.
 */
function buildFinalMessage(
  partial: AssistantMessage,
  text: string,
  toolCalls: readonly CompletedToolCall[],
  inputTokens: number,
  outputTokens: number,
): AssistantMessage {
  // Build content preserving order: text first (if any), then tool calls.
  // pi-agent-core filters content for { type: "toolCall" } to execute tools.
  const content = [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...toolCalls,
  ] as AssistantMessage["content"];
  return {
    ...partial,
    content,
    usage: {
      input: inputTokens,
      output: outputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: inputTokens + outputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

/**
 * Create a bridge streamFn that routes through Koi's middleware via callHandlers.modelStream().
 *
 * The returned function has the StreamFn signature expected by pi Agent.
 * It captures callHandlers from the enclosing stream() call scope.
 */
export function createBridgeStreamFn(
  modelStream: ModelStreamHandler,
  realStreamSimpleFn: StreamFn,
): StreamFn {
  return (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();

    // Build a bound streamSimple that captures model + context.
    // Return type is AssistantMessageEventStream | Promise<...> because StreamFn supports both.
    const callBoundStream = (
      overrides?: Record<string, unknown>,
    ): AssistantMessageEventStream | Promise<AssistantMessageEventStream> =>
      realStreamSimpleFn(model, context, { ...options, ...overrides });

    // Build pi-native params for the terminal side-channel
    const piNativeParams: PiNativeParams = {
      callBoundStream,
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      ...(options?.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      ...(options?.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
    };

    // Build ModelRequest
    const modelRequest: ModelRequest = {
      messages: piMessagesToInbound(context.messages),
      model: model.id,
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    };

    // Store pi-native params in WeakMap side-channel (avoids smuggling via metadata)
    piParamsStore.set(modelRequest, piNativeParams);

    // Build a mutable partial AssistantMessage for streaming
    const partial: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    // Pump ModelChunks → AssistantMessageEvents asynchronously
    void (async () => {
      try {
        // let justified: accumulate text for final message
        let text = "";
        let inputTokens = 0;
        let outputTokens = 0;
        // let justified: track whether "start" has been emitted — pi-agent-core requires it
        // to initialize partialMessage before processing any text/tool events.
        let startEmitted = false;

        // let justified: mutable Maps/arrays for streaming tool call reconstruction.
        // Tool calls stream as (tool_call_start → tool_call_delta* → tool_call_end).
        // We accumulate the JSON delta and reconstruct the full ToolCall on end.
        const activeCalls = new Map<string, { name: string; deltaAcc: string }>();
        const completedCalls: CompletedToolCall[] = [];

        for await (const chunk of modelStream(modelRequest)) {
          // Emit "start" before the first content chunk so pi sets partialMessage.
          // Without this, pi silently drops all text_delta / toolcall_start events.
          if (!startEmitted && chunk.kind !== "done" && chunk.kind !== "usage") {
            startEmitted = true;
            stream.push({ type: "start", partial });
          }

          if (chunk.kind === "text_delta") {
            text += chunk.delta;
          }
          if (chunk.kind === "usage") {
            inputTokens = chunk.inputTokens;
            outputTokens = chunk.outputTokens;
          }

          // Track tool call JSON accumulation across start/delta/end chunks.
          if (chunk.kind === "tool_call_start") {
            activeCalls.set(chunk.callId, { name: chunk.toolName, deltaAcc: "" });
          }
          if (chunk.kind === "tool_call_delta") {
            const tc = activeCalls.get(chunk.callId);
            if (tc) {
              tc.deltaAcc += chunk.delta;
            }
          }

          // Handle done chunk explicitly — skip modelChunkToAssistantEvent to avoid double emission
          if (chunk.kind === "done") {
            const finalMessage = buildFinalMessage(
              partial,
              text,
              completedCalls,
              inputTokens,
              outputTokens,
            );
            stream.push({ type: "done", reason: "stop", message: finalMessage });
            stream.end(finalMessage);
            return;
          }

          // Handle tool_call_end specially: reconstruct full ToolCall and emit toolcall_end.
          // pi-agent-core uses the final AssistantMessage.content (from stream.end()) to execute
          // tools — not the streaming events — so completedCalls must be populated here.
          if (chunk.kind === "tool_call_end") {
            const tc = activeCalls.get(chunk.callId);
            activeCalls.delete(chunk.callId);
            if (tc) {
              // let justified: args starts as empty object, overwritten on successful parse
              let args: Record<string, unknown> = {};
              try {
                const parsed = JSON.parse(tc.deltaAcc || "{}") as unknown;
                if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                  args = parsed as Record<string, unknown>;
                }
              } catch {
                // Keep empty args on malformed JSON — tool will receive {} and can handle it
              }
              const toolCall: CompletedToolCall = {
                type: "toolCall",
                id: chunk.callId,
                name: tc.name,
                arguments: args,
              };
              completedCalls.push(toolCall);
              // Emit toolcall_end so pi-agent-core updates its partialMessage for UI streaming.
              // Boundary cast: CompletedToolCall is structurally compatible with pi-ai ToolCall
              // (arguments: Record<string,unknown> satisfies Record<string,any>).
              stream.push({
                type: "toolcall_end",
                contentIndex: 0,
                toolCall,
                partial,
              } as unknown as AssistantMessageEvent);
            }
            // tool_call_end is fully handled above; modelChunkToAssistantEvent returns
            // undefined for it anyway, so skip the call below.
            continue;
          }

          const event = modelChunkToAssistantEvent(chunk, partial);
          if (event) {
            stream.push(event);
          }
        }

        // If we got here without a done chunk, end the stream
        const finalMessage = buildFinalMessage(
          partial,
          text,
          completedCalls,
          inputTokens,
          outputTokens,
        );
        stream.push({ type: "done", reason: "stop", message: finalMessage });
        stream.end(finalMessage);
      } catch (error: unknown) {
        const errMessage: AssistantMessage = {
          ...partial,
          stopReason: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
        };
        stream.push({ type: "error", reason: "error", error: errMessage });
        stream.end(errMessage);
      }
    })();

    return stream;
  };
}
