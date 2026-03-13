/**
 * Model terminal — the innermost layer of the middleware chain.
 *
 * Calls pi's streamSimple() and converts pi AssistantMessageEvent → Koi ModelChunk.
 * Provides both modelCall (collect all) and modelStream (async iterable) terminals.
 *
 * Pi-native parameters (including the bound streamSimple function) are passed via
 * a nonce-based Map side-channel. The nonce is stored in ModelRequest.metadata so
 * it survives object spread by middleware (e.g., compactor creating { ...request, messages }).
 */

import { toolCallId } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import type {
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
} from "@koi/core/middleware";
import type {
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Message,
} from "@mariozechner/pi-ai";
import { findToolCallAtContentIndex } from "./content-utils.js";
import { inboundToPiMessages } from "./message-map.js";

/** Metadata key for the nonce stored in ModelRequest.metadata. */
export const PI_PARAMS_NONCE_KEY = "piParamsNonce";

/**
 * Create a mutable side-channel for cache/cost data from pi done/error events.
 * Terminal writes here; bridge reads after the model stream ends.
 *
 * Intentionally mutable — this is a write-once communication channel, not a domain type.
 * ModelChunk (L0) only carries inputTokens/outputTokens, so cache/cost must bypass it.
 */
export function createCacheResultChannel(): {
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
} {
  return {
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Pi-native parameters for the terminal.
 * Stored in a Map keyed by nonce string (survives middleware object spread).
 */
export interface PiNativeParams {
  /** Pre-bound streamSimple function. Accepts optional message override for middleware-modified messages. */
  readonly callBoundStream: (
    options?: Record<string, unknown>,
    messageOverride?: readonly Message[],
  ) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
  /** Original messages at bridge creation time — used for change detection. */
  readonly originalMessages: readonly InboundMessage[];
  /** Temperature override (may be modified by middleware). */
  readonly temperature?: number;
  /** Max tokens override (may be modified by middleware). */
  readonly maxTokens?: number;
  /** Abort signal for cancellation. */
  readonly signal?: AbortSignal;
  /** API key for this call. */
  readonly apiKey?: string;
  /** Thinking/reasoning level. */
  readonly reasoning?: string;
  /** Mutable side-channel: terminal writes cache/cost here, bridge reads after stream. */
  readonly cacheResult?: ReturnType<typeof createCacheResultChannel> | undefined;
}

/**
 * Side-channel for passing pi-native params from stream-bridge to model-terminal.
 * Nonce-based Map — entries are auto-deleted after one-shot lookup (equivalent GC to WeakMap).
 */
export const piParamsStore: Map<string, PiNativeParams> = new Map<string, PiNativeParams>();

/**
 * Look up pi-native params by nonce from ModelRequest.metadata.
 * Auto-deletes the entry after retrieval (one-shot cleanup prevents memory leaks).
 */
export function getPiParams(request: ModelRequest): PiNativeParams | undefined {
  const raw = request.metadata?.[PI_PARAMS_NONCE_KEY];
  if (typeof raw !== "string") return undefined;
  const params = piParamsStore.get(raw);
  if (params !== undefined) {
    piParamsStore.delete(raw);
  }
  return params;
}

/**
 * Convert a pi AssistantMessageEvent to a Koi ModelChunk.
 * Returns undefined for events with no Koi equivalent.
 */
export function assistantEventToModelChunk(event: AssistantMessageEvent): ModelChunk | undefined {
  switch (event.type) {
    case "text_delta":
      return { kind: "text_delta", delta: event.delta };

    case "thinking_delta":
      return { kind: "thinking_delta", delta: event.delta };

    case "toolcall_start": {
      const toolCall = findToolCallAtContentIndex(event.partial.content, event.contentIndex);
      if (toolCall) {
        return {
          kind: "tool_call_start",
          toolName: toolCall.name,
          callId: toolCallId(toolCall.id),
        };
      }
      return undefined;
    }

    case "toolcall_delta": {
      const toolCall = findToolCallAtContentIndex(event.partial.content, event.contentIndex);
      return {
        kind: "tool_call_delta",
        callId: toolCallId(toolCall?.id ?? ""),
        delta: event.delta,
      };
    }

    case "toolcall_end":
      return { kind: "tool_call_end", callId: toolCallId(event.toolCall.id) };

    case "done":
      return {
        kind: "usage",
        inputTokens: event.message.usage.input,
        outputTokens: event.message.usage.output,
      };

    case "error":
      return {
        kind: "error",
        message: event.error.errorMessage ?? "Model provider error",
        usage: {
          inputTokens: event.error.usage.input,
          outputTokens: event.error.usage.output,
        },
      };

    // start, text_start, text_end, thinking_start, thinking_end → no ModelChunk equivalent
    default:
      return undefined;
  }
}

/**
 * Assemble final ModelResponse from accumulated streaming data.
 */
function assembleResponse(
  text: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): ModelResponse {
  return {
    content: text,
    model,
    usage: { inputTokens, outputTokens },
  };
}

/**
 * Create a model stream terminal that calls streamSimple and yields ModelChunks.
 */
export function createModelStreamTerminal(): ModelStreamHandler {
  return async function* modelStreamTerminal(request: ModelRequest): AsyncIterable<ModelChunk> {
    const piParams = getPiParams(request);

    if (!piParams?.callBoundStream) {
      throw new Error(
        "Pi model terminal requires pi-native params. Use piParamsStore.set() before calling.",
      );
    }

    const streamOptions: Record<string, unknown> = {};
    if (request.temperature !== undefined) streamOptions.temperature = request.temperature;
    if (request.maxTokens !== undefined) streamOptions.maxTokens = request.maxTokens;
    if (piParams.temperature !== undefined && request.temperature === undefined) {
      streamOptions.temperature = piParams.temperature;
    }
    if (piParams.maxTokens !== undefined && request.maxTokens === undefined) {
      streamOptions.maxTokens = piParams.maxTokens;
    }
    if (piParams.signal) streamOptions.signal = piParams.signal;
    if (piParams.apiKey) streamOptions.apiKey = piParams.apiKey;
    if (piParams.reasoning) streamOptions.reasoning = piParams.reasoning;

    // Detect middleware-modified messages (e.g., compactor replaced the array)
    // Relies on Koi's immutability contract: middleware returns a new array
    // reference when modifying messages. Reference equality avoids O(n) comparison.
    const messagesChanged = request.messages !== piParams.originalMessages;
    const messageOverride = messagesChanged ? inboundToPiMessages(request.messages) : undefined;

    const eventStream = await piParams.callBoundStream(streamOptions, messageOverride);

    // let justified: accumulate text for final response
    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let errorChunk: ModelChunk | undefined;
    const modelId = request.model ?? "unknown";

    for await (const event of eventStream) {
      // Write cache/cost from raw pi event to side-channel (bypasses ModelChunk L0 contract)
      if (piParams.cacheResult !== undefined) {
        if (event.type === "done") {
          const { usage } = event.message;
          piParams.cacheResult.cacheReadTokens = usage.cacheRead;
          piParams.cacheResult.cacheCreationTokens = usage.cacheWrite;
          piParams.cacheResult.cost = usage.cost;
        } else if (event.type === "error") {
          const { usage } = event.error;
          piParams.cacheResult.cacheReadTokens = usage.cacheRead;
          piParams.cacheResult.cacheCreationTokens = usage.cacheWrite;
          piParams.cacheResult.cost = usage.cost;
        }
      }

      const chunk = assistantEventToModelChunk(event);
      if (chunk) {
        if (chunk.kind === "text_delta") {
          text += chunk.delta;
        }
        if (chunk.kind === "usage") {
          inputTokens = chunk.inputTokens;
          outputTokens = chunk.outputTokens;
        }
        if (chunk.kind === "error") {
          if (chunk.usage) {
            inputTokens = chunk.usage.inputTokens;
            outputTokens = chunk.usage.outputTokens;
          }
          errorChunk = chunk;
        }
        yield chunk;
      }
    }

    // Don't emit done after an error — the error chunk signals failure
    if (errorChunk !== undefined) {
      return;
    }

    yield {
      kind: "done",
      response: assembleResponse(text, modelId, inputTokens, outputTokens),
    };
  };
}

/**
 * Create a model call terminal that collects stream chunks into a single response.
 */
export function createModelCallTerminal(streamTerminal: ModelStreamHandler): ModelHandler {
  return async function modelCallTerminal(request: ModelRequest): Promise<ModelResponse> {
    // let justified: accumulate text from stream
    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;
    const modelId = request.model ?? "unknown";

    for await (const chunk of streamTerminal(request)) {
      switch (chunk.kind) {
        case "text_delta":
          text += chunk.delta;
          break;
        case "usage":
          inputTokens = chunk.inputTokens;
          outputTokens = chunk.outputTokens;
          break;
        case "error":
          throw new Error(chunk.message);
        case "done":
          return chunk.response;
      }
    }

    return assembleResponse(text, modelId, inputTokens, outputTokens);
  };
}
