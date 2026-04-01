import type { EngineEvent, ModelChunk, ToolCallId } from "@koi/core";
import type { AccumulatedToolCall } from "./types.js";

/**
 * Consumes an `AsyncIterable<ModelChunk>` from a model provider and yields
 * `EngineEvent`s, accumulating streamed tool-call argument deltas into parsed
 * payloads.
 *
 * Usage and error chunks are absorbed — usage is folded into the final `done`
 * event metrics, and model errors produce a `done` event with `stopReason: "error"`.
 */
export async function* consumeModelStream(
  chunks: AsyncIterable<ModelChunk>,
): AsyncGenerator<EngineEvent> {
  const accumulators = new Map<
    ToolCallId,
    { readonly toolName: string; readonly fragments: string[] }
  >();

  let inputTokens = 0;
  let outputTokens = 0;
  const completedToolCalls: AccumulatedToolCall[] = [];

  for await (const chunk of chunks) {
    switch (chunk.kind) {
      case "text_delta":
      case "thinking_delta": {
        yield chunk;
        break;
      }

      case "tool_call_start": {
        accumulators.set(chunk.callId, {
          toolName: chunk.toolName,
          fragments: [],
        });
        yield {
          kind: "tool_call_start",
          toolName: chunk.toolName,
          callId: chunk.callId,
        };
        break;
      }

      case "tool_call_delta": {
        const acc = accumulators.get(chunk.callId);
        if (acc) {
          acc.fragments.push(chunk.delta);
        }
        yield { kind: "tool_call_delta", callId: chunk.callId, delta: chunk.delta };
        break;
      }

      case "tool_call_end": {
        const acc = accumulators.get(chunk.callId);
        const rawArgs = acc ? acc.fragments.join("") : "";
        const toolName = acc ? acc.toolName : "unknown";
        accumulators.delete(chunk.callId);

        let parsedArgs: AccumulatedToolCall["parsedArgs"];
        try {
          const parsed: unknown = JSON.parse(rawArgs);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            parsedArgs = parsed as AccumulatedToolCall["parsedArgs"];
          }
        } catch {
          // Malformed JSON — parsedArgs stays undefined
        }

        const accumulated: AccumulatedToolCall = {
          toolName,
          callId: chunk.callId,
          rawArgs,
          parsedArgs,
        };
        completedToolCalls.push(accumulated);

        yield { kind: "tool_call_end", callId: chunk.callId, result: accumulated };
        break;
      }

      case "usage": {
        inputTokens += chunk.inputTokens;
        outputTokens += chunk.outputTokens;
        // Not yielded — folded into done event
        break;
      }

      case "error": {
        if (chunk.usage) {
          inputTokens += chunk.usage.inputTokens;
          outputTokens += chunk.usage.outputTokens;
        }
        yield {
          kind: "done",
          output: {
            content: [],
            stopReason: "error",
            metrics: {
              totalTokens: inputTokens + outputTokens,
              inputTokens,
              outputTokens,
              turns: 0,
              durationMs: 0,
            },
            metadata: { error: chunk.message },
          },
        };
        return;
      }

      case "done": {
        const responseUsage = chunk.response.usage;
        if (responseUsage) {
          // Final response usage is authoritative when the provider emits both
          // incremental usage chunks and a terminal total.
          inputTokens = responseUsage.inputTokens;
          outputTokens = responseUsage.outputTokens;
        }
        yield {
          kind: "done",
          output: {
            content:
              chunk.response.content.length > 0
                ? [{ kind: "text", text: chunk.response.content }]
                : [],
            stopReason: "completed",
            metrics: {
              totalTokens: inputTokens + outputTokens,
              inputTokens,
              outputTokens,
              turns: 0,
              durationMs: 0,
            },
          },
        };
        return;
      }
    }
  }

  // Stream ended without a terminal "done" or "error" chunk — transport
  // breakage, iterator cancellation, or provider version skew. Synthesize
  // a terminal error so downstream consumers always get a deterministic
  // end-of-stream signal.
  yield {
    kind: "done",
    output: {
      content: [],
      stopReason: "error",
      metrics: {
        totalTokens: inputTokens + outputTokens,
        inputTokens,
        outputTokens,
        turns: 0,
        durationMs: 0,
      },
      metadata: { error: "stream ended without terminal chunk" },
    },
  };
}
