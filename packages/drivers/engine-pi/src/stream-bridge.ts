/**
 * Custom streamFn bridge — routes pi's LLM calls through Koi's middleware chain.
 *
 * This is the CORE of full cooperation. When pi calls streamFn(model, context, options),
 * we convert to ModelRequest, invoke callHandlers.modelStream() (which fires middleware),
 * and pump the resulting ModelChunks back as AssistantMessageEvents.
 *
 * The bridge maintains a mutable partial AssistantMessage that mirrors what pi-ai's
 * real streamSimple builds. This is critical because pi-agent-core reads tool calls
 * from `partial.content` to decide whether to execute tools after the LLM response.
 */

import type { ModelChunk, ModelRequest, ModelStreamHandler } from "@koi/core/middleware";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { piMessagesToInbound } from "./message-map.js";
import type { PiNativeParams } from "./model-terminal.js";
import { PI_PARAMS_NONCE_KEY, piParamsStore } from "./model-terminal.js";

// ---------------------------------------------------------------------------
// Partial message builder — accumulates streaming chunks into content blocks
// ---------------------------------------------------------------------------

/** Accumulated usage from streaming chunks. */
interface StreamUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
}

interface PartialBuilder {
  /** The current partial message (mutated in place). */
  readonly partial: AssistantMessage;
  /** Process a ModelChunk, updating partial.content accordingly. */
  readonly processChunk: (chunk: ModelChunk) => void;
  /** Build the final AssistantMessage with accumulated usage. */
  readonly finalize: (usage: StreamUsage) => AssistantMessage;
}

function createPartialBuilder(initial: AssistantMessage): PartialBuilder {
  // Mutable content array — pi-agent-core reads partial.content for tool calls.
  // SAFETY: items are cast to the union type when pushed; mutation is required
  // because pi-agent-core reads partial.content in-place to detect tool calls.
  const content: (TextContent | ThinkingContent | ToolCall)[] = [];
  // let justified: mutable text accumulator for text content block
  let textBlock: { type: "text"; text: string } | undefined;
  // let justified: mutable thinking accumulator
  let thinkingBlock: { type: "thinking"; thinking: string } | undefined;
  // let justified: tool call being built — tracks both the ToolCall (pushed to content)
  // and the raw JSON accumulator (for incremental argument parsing)
  let currentToolCallEntry: ToolCall | undefined;
  // let justified: mutable JSON accumulator for incremental argument parsing
  let currentArgsJson = "";

  const partial: AssistantMessage = {
    ...initial,
    content,
  };

  return {
    partial,
    processChunk(chunk: ModelChunk): void {
      switch (chunk.kind) {
        case "text_delta":
          if (textBlock === undefined) {
            textBlock = { type: "text", text: chunk.delta };
            content.push(textBlock);
          } else {
            textBlock.text += chunk.delta;
          }
          break;

        case "thinking_delta":
          if (thinkingBlock === undefined) {
            thinkingBlock = { type: "thinking", thinking: chunk.delta };
            content.push(thinkingBlock);
          } else {
            thinkingBlock.thinking += chunk.delta;
          }
          break;

        case "tool_call_start":
          currentToolCallEntry = {
            type: "toolCall",
            id: chunk.callId,
            name: chunk.toolName,
            arguments: {},
          };
          currentArgsJson = "";
          content.push(currentToolCallEntry);
          break;

        case "tool_call_delta":
          if (currentToolCallEntry !== undefined) {
            currentArgsJson += chunk.delta;
          }
          break;

        case "tool_call_end":
          if (currentToolCallEntry !== undefined) {
            try {
              currentToolCallEntry.arguments = JSON.parse(currentArgsJson || "{}") as Record<
                string,
                unknown
              >;
            } catch {
              currentToolCallEntry.arguments = {};
            }
            currentToolCallEntry = undefined;
            currentArgsJson = "";
          }
          break;

        // usage, error, done — handled by the pump loop, not content
        default:
          break;
      }
    },
    finalize(usage: StreamUsage): AssistantMessage {
      // Finalize any in-flight tool call (shouldn't happen with well-formed streams)
      if (currentToolCallEntry !== undefined) {
        try {
          currentToolCallEntry.arguments = JSON.parse(currentArgsJson || "{}") as Record<
            string,
            unknown
          >;
        } catch {
          currentToolCallEntry.arguments = {};
        }
      }
      return {
        ...partial,
        content: [...content],
        usage: {
          input: usage.inputTokens,
          output: usage.outputTokens,
          cacheRead: usage.cacheReadTokens,
          cacheWrite: usage.cacheCreationTokens,
          totalTokens: usage.inputTokens + usage.outputTokens,
          cost: usage.cost,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Chunk → AssistantMessageEvent conversion
// ---------------------------------------------------------------------------

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

    case "error":
      return undefined; // handled by the pump loop

    case "done":
      return { type: "done", reason: "stop", message: partial };
  }
}

// ---------------------------------------------------------------------------
// Bridge factory
// ---------------------------------------------------------------------------

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
    // Accepts optional messageOverride to apply middleware-modified messages.
    const callBoundStream = (
      overrides?: Record<string, unknown>,
      messageOverride?: readonly Message[],
    ): AssistantMessageEventStream | Promise<AssistantMessageEventStream> => {
      const effectiveContext =
        messageOverride !== undefined ? { ...context, messages: [...messageOverride] } : context;
      return realStreamSimpleFn(model, effectiveContext, { ...options, ...overrides });
    };

    // Convert messages for the ModelRequest and store as originalMessages for change detection
    const originalMessages = piMessagesToInbound(context.messages);

    // Build pi-native params for the terminal side-channel
    const piNativeParams: PiNativeParams = {
      callBoundStream,
      originalMessages,
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      ...(options?.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      ...(options?.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
    };

    // Generate nonce for the nonce-based piParamsStore (survives middleware object spread)
    const nonce = crypto.randomUUID();

    // Build ModelRequest with nonce in metadata
    const modelRequest: ModelRequest = {
      messages: originalMessages,
      model: model.id,
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      metadata: { [PI_PARAMS_NONCE_KEY]: nonce },
    };

    // Store pi-native params in nonce-based Map (auto-deleted on one-shot lookup)
    piParamsStore.set(nonce, piNativeParams);

    // Build a mutable partial AssistantMessage with content tracking.
    // pi-agent-core reads partial.content to detect tool calls after the stream ends.
    const builder = createPartialBuilder({
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
    });

    // Pump ModelChunks → AssistantMessageEvents asynchronously
    void (async () => {
      try {
        // let justified: accumulate usage from stream
        const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
        // let justified: mutable usage accumulator updated from stream chunks
        let usage: StreamUsage = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          cost: zeroCost,
        };

        // Push initial "start" event — pi-agent-core's streamAssistantResponse
        // requires this to set partialMessage, without which all subsequent
        // message_update events (text_delta, toolcall_start, etc.) are silently dropped.
        stream.push({ type: "start", partial: builder.partial });

        for await (const chunk of modelStream(modelRequest)) {
          // Update partial content for all chunk types
          builder.processChunk(chunk);

          if (chunk.kind === "usage") {
            usage = { ...usage, inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens };
          }

          // Handle error chunk — propagate as pi-ai error event, not done
          if (chunk.kind === "error") {
            if (chunk.usage) {
              usage = {
                ...usage,
                inputTokens: chunk.usage.inputTokens,
                outputTokens: chunk.usage.outputTokens,
              };
            }
            const errMessage: AssistantMessage = {
              ...builder.finalize(usage),
              stopReason: "error",
              errorMessage: chunk.message,
            };
            stream.push({ type: "error", reason: "error", error: errMessage });
            stream.end(errMessage);
            return;
          }

          // Handle done chunk explicitly — build final message with proper content + usage
          if (chunk.kind === "done") {
            const finalMessage = builder.finalize(usage);
            stream.push({ type: "done", reason: "stop", message: finalMessage });
            stream.end(finalMessage);
            return;
          }

          // Handle tool_call_end: builder has already parsed arguments into partial.content.
          // Emit toolcall_end so pi-agent-core updates its partialMessage for UI streaming.
          if (chunk.kind === "tool_call_end") {
            // Find the completed toolCall in partial.content by callId
            const toolCall = builder.partial.content.find(
              (c) => c.type === "toolCall" && (c as { readonly id: string }).id === chunk.callId,
            );
            if (toolCall !== undefined) {
              stream.push({
                type: "toolcall_end",
                contentIndex: 0,
                toolCall,
                partial: builder.partial,
              } as unknown as AssistantMessageEvent);
            }
            continue;
          }

          const event = modelChunkToAssistantEvent(chunk, builder.partial);
          if (event) {
            stream.push(event);
          }
        }

        // If we got here without a done chunk, end the stream
        const finalMessage = builder.finalize(usage);
        stream.push({ type: "done", reason: "stop", message: finalMessage });
        stream.end(finalMessage);
      } catch (error: unknown) {
        // Clean up nonce entry if terminal was never reached (prevents memory leak)
        piParamsStore.delete(nonce);
        const errMessage: AssistantMessage = {
          ...builder.partial,
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
