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
import { createCacheResultChannel, PI_PARAMS_NONCE_KEY, piParamsStore } from "./model-terminal.js";

// ---------------------------------------------------------------------------
// Tool argument parsing — attaches parse error metadata for tool-bridge to throw
// ---------------------------------------------------------------------------

/**
 * Marker property attached to tool call arguments when JSON parsing fails.
 * The tool-bridge checks for this and throws a VALIDATION KoiError during
 * tool execution (inside wrapToolCall), where retry middleware can catch it.
 *
 * Throwing here would abort the entire stream (caught by the pump loop's
 * outer catch) — the error must surface during tool *execution*, not streaming.
 */
export const PARSE_ERROR_KEY = "__koi_parse_error__" as const;

/**
 * Parse accumulated tool call argument JSON. On failure, returns an object
 * with a parse error marker instead of throwing — the error is deferred
 * to tool execution time where middleware can intercept it.
 */
function parseToolCallArgs(argsJson: string, toolName: string): Record<string, unknown> {
  const raw = argsJson || "{}";
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (parseError: unknown) {
    const message = parseError instanceof Error ? parseError.message : String(parseError);
    // Return a marker object; tool-bridge will detect and throw at execution time
    return {
      [PARSE_ERROR_KEY]: `Tool '${toolName}' received malformed JSON arguments: ${message}`,
    };
  }
}

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
            currentToolCallEntry.arguments = parseToolCallArgs(
              currentArgsJson,
              currentToolCallEntry.name,
            );
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
        currentToolCallEntry.arguments = parseToolCallArgs(
          currentArgsJson,
          currentToolCallEntry.name,
        );
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
    // Filter invalid signal from pi-agent-core options — pi may pass signal: {}
    // (empty object) which causes fetch() to abort immediately with "Connection error".
    const safeOptions = options !== undefined
      ? Object.fromEntries(Object.entries(options).filter(([k, v]) => k !== "signal" || v instanceof AbortSignal))
      : undefined;

    const callBoundStream = (
      overrides?: Record<string, unknown>,
      messageOverride?: readonly Message[],
    ): AssistantMessageEventStream | Promise<AssistantMessageEventStream> => {
      const effectiveContext =
        messageOverride !== undefined ? { ...context, messages: [...messageOverride] } : context;
      return realStreamSimpleFn(model, effectiveContext, { ...safeOptions, ...overrides });
    };

    // Convert messages for the ModelRequest and store as originalMessages for change detection
    const originalMessages = piMessagesToInbound(context.messages);

    // Cache/cost side-channel — terminal writes from pi done/error, bridge reads after stream
    const cacheResult = createCacheResultChannel();

    // Build pi-native params for the terminal side-channel
    const piNativeParams: PiNativeParams = {
      callBoundStream,
      originalMessages,
      cacheResult,
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options?.signal instanceof AbortSignal ? { signal: options.signal } : {}),
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

        if (process.env.KOI_DEBUG_EVENTS === "1") {
          const fs = require("fs");
          const msgCount = modelRequest.messages?.length ?? 0;
          const toolCount = modelRequest.tools?.length ?? 0;
          const totalChars = (modelRequest.messages ?? []).reduce((sum: number, m: {readonly content: readonly {readonly kind: string; readonly text?: string}[]}) => sum + m.content.reduce((s: number, b: {readonly kind: string; readonly text?: string}) => s + (b.kind === "text" ? (b.text?.length ?? 0) : 0), 0), 0);
          fs.appendFileSync("/tmp/koi-events.log", `[stream-bridge] modelStream call: ${String(msgCount)} msgs, ${String(totalChars)} chars, ${String(toolCount)} tools\n`);
        }

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
            // Read cache/cost written by terminal before yielding this chunk
            usage = {
              ...usage,
              cacheReadTokens: cacheResult.cacheReadTokens,
              cacheCreationTokens: cacheResult.cacheCreationTokens,
              cost: { ...cacheResult.cost },
            };
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
            // Read cache/cost written by terminal before yielding this chunk
            usage = {
              ...usage,
              cacheReadTokens: cacheResult.cacheReadTokens,
              cacheCreationTokens: cacheResult.cacheCreationTokens,
              cost: { ...cacheResult.cost },
            };
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
        if (process.env.KOI_DEBUG_EVENTS === "1") {
          const fs = require("fs");
          fs.appendFileSync("/tmp/koi-events.log", `[stream-bridge] stream ended without done chunk, text=${String(builder.partial.content.length)} blocks\n`);
        }
        const finalMessage = builder.finalize(usage);
        stream.push({ type: "done", reason: "stop", message: finalMessage });
        stream.end(finalMessage);
      } catch (error: unknown) {
        if (process.env.KOI_DEBUG_EVENTS === "1") {
          const fs = require("fs");
          fs.appendFileSync("/tmp/koi-events.log", `[stream-bridge] CATCH ERROR: ${error instanceof Error ? error.message : String(error)}\n${error instanceof Error ? error.stack : ""}\n`);
        }
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
