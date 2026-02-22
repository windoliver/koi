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
 * Convert a Koi ModelChunk back to a pi AssistantMessageEvent.
 * Returns undefined for chunks with no pi equivalent.
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
      return undefined; // toolcall_end needs toolCall object, handled by pi internally

    case "usage":
      return undefined; // usage tracked separately

    case "done":
      return { type: "done", reason: "stop", message: partial };
  }
}

/**
 * Build a final AssistantMessage from accumulated streaming data.
 */
function buildFinalMessage(
  partial: AssistantMessage,
  text: string,
  inputTokens: number,
  outputTokens: number,
): AssistantMessage {
  return {
    ...partial,
    content: text ? [{ type: "text", text }] : [],
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

        for await (const chunk of modelStream(modelRequest)) {
          if (chunk.kind === "text_delta") {
            text += chunk.delta;
          }
          if (chunk.kind === "usage") {
            inputTokens = chunk.inputTokens;
            outputTokens = chunk.outputTokens;
          }

          // Handle done chunk explicitly — skip modelChunkToAssistantEvent to avoid double emission
          if (chunk.kind === "done") {
            const finalMessage = buildFinalMessage(partial, text, inputTokens, outputTokens);
            stream.push({ type: "done", reason: "stop", message: finalMessage });
            stream.end(finalMessage);
            return;
          }

          const event = modelChunkToAssistantEvent(chunk, partial);
          if (event) {
            stream.push(event);
          }
        }

        // If we got here without a done chunk, end the stream
        const finalMessage = buildFinalMessage(partial, text, inputTokens, outputTokens);
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
