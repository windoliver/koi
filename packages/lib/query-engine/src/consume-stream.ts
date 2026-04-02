import type { EngineEvent, ModelChunk, ToolCallId } from "@koi/core";
import type { AccumulatedToolCall } from "./types.js";

/** Extract dangling (in-flight, never completed) tool call info from accumulators. */
function buildDanglingToolCalls(
  accumulators: ReadonlyMap<
    ToolCallId,
    { readonly toolName: string; readonly fragments: string[] }
  >,
): readonly { readonly callId: string; readonly toolName: string; readonly partialArgs: string }[] {
  if (accumulators.size === 0) return [];
  const result: {
    readonly callId: string;
    readonly toolName: string;
    readonly partialArgs: string;
  }[] = [];
  for (const [callId, acc] of accumulators) {
    result.push({ callId, toolName: acc.toolName, partialArgs: acc.fragments.join("") });
  }
  return result;
}

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
  const textFragments: string[] = [];

  for await (const chunk of chunks) {
    switch (chunk.kind) {
      case "text_delta": {
        textFragments.push(chunk.delta);
        yield chunk;
        break;
      }

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
        let parseError: string | undefined;
        try {
          const parsed: unknown = JSON.parse(rawArgs);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            parsedArgs = parsed as AccumulatedToolCall["parsedArgs"];
          } else {
            // Valid JSON but not a JsonObject (e.g., array, string, number, boolean)
            parseError = `expected JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`;
          }
        } catch (e: unknown) {
          parseError = e instanceof Error ? e.message : "JSON parse failed";
        }

        const accumulated: AccumulatedToolCall = {
          toolName,
          callId: chunk.callId,
          rawArgs,
          parsedArgs,
          ...(parseError !== undefined ? { parseError } : {}),
        };
        completedToolCalls.push(accumulated);

        yield { kind: "tool_call_end", callId: chunk.callId, result: accumulated };
        break;
      }

      case "usage": {
        inputTokens += chunk.inputTokens;
        outputTokens += chunk.outputTokens;
        // Yield as custom event so callers can track partial usage
        // on early exit (abort/error/truncation). Still folded into
        // the done event metrics for the normal completion path.
        yield {
          kind: "custom",
          type: "usage",
          data: { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens },
        };
        break;
      }

      case "error": {
        if (chunk.usage) {
          // Terminal error usage is authoritative — overwrite, not accumulate,
          // consistent with the done path. Prevents double-counting when
          // providers emit both incremental usage chunks and a terminal total.
          inputTokens = chunk.usage.inputTokens;
          outputTokens = chunk.usage.outputTokens;
        }
        const errorPartialText = textFragments.join("");
        // Surface any in-flight tool calls that never completed
        const danglingOnError = buildDanglingToolCalls(accumulators);
        yield {
          kind: "done",
          output: {
            content: errorPartialText.length > 0 ? [{ kind: "text", text: errorPartialText }] : [],
            stopReason: "error",
            metrics: {
              totalTokens: inputTokens + outputTokens,
              inputTokens,
              outputTokens,
              turns: 0,
              durationMs: 0,
            },
            metadata: {
              error: chunk.message,
              // Propagate structured error fields so consumers can distinguish
              // hook blocks (code: "PERMISSION") from provider errors.
              ...(chunk.code !== undefined ? { errorCode: chunk.code } : {}),
              ...(chunk.retryable !== undefined ? { retryable: chunk.retryable } : {}),
              ...(chunk.retryAfterMs !== undefined ? { retryAfterMs: chunk.retryAfterMs } : {}),
              ...(danglingOnError.length > 0 ? { danglingToolCalls: danglingOnError } : {}),
            },
          },
        };
        return;
      }

      case "done": {
        const responseUsage = chunk.response.usage;
        if (responseUsage) {
          inputTokens = responseUsage.inputTokens;
          outputTokens = responseUsage.outputTokens;
        }
        const finalText =
          chunk.response.content.length > 0 ? chunk.response.content : textFragments.join("");

        // Check for in-flight tool calls that the provider never completed.
        // If present, downgrade to error so incomplete tool calls cannot
        // disappear silently behind a "completed" stop reason.
        const danglingOnDone = buildDanglingToolCalls(accumulators);

        // Determine engine stop reason. Priority:
        // 1. Dangling tool calls → "error" (incomplete response)
        // 2. Non-success model stop reason (error, hook_blocked) → "error"
        //    (preserve denial/failure signal from middleware or provider)
        // 3. Otherwise → "completed"
        const responseStopReason = chunk.response.stopReason;
        const isNonSuccess =
          responseStopReason !== undefined &&
          responseStopReason !== "stop" &&
          responseStopReason !== "length" &&
          responseStopReason !== "tool_use";
        const stopReason =
          danglingOnDone.length > 0 ? "error" : isNonSuccess ? "error" : "completed";

        // Build metadata: merge response metadata (hook block info, etc.)
        // with dangling tool call warnings. Use distinct keys so dangling-tool-call
        // diagnostics never overwrite upstream error details from the response.
        const responseMeta = chunk.response.metadata;
        const hasDangling = danglingOnDone.length > 0;
        const hasResponseMeta = responseMeta !== undefined && Object.keys(responseMeta).length > 0;
        const metadata =
          hasDangling || hasResponseMeta
            ? {
                ...(hasResponseMeta ? responseMeta : {}),
                ...(isNonSuccess && responseStopReason !== undefined
                  ? { modelStopReason: responseStopReason }
                  : {}),
                ...(hasDangling
                  ? {
                      danglingToolCallsError: "done received with in-flight tool calls",
                      danglingToolCalls: danglingOnDone,
                    }
                  : {}),
              }
            : undefined;

        yield {
          kind: "done",
          output: {
            content: finalText.length > 0 ? [{ kind: "text", text: finalText }] : [],
            stopReason,
            metrics: {
              totalTokens: inputTokens + outputTokens,
              inputTokens,
              outputTokens,
              turns: 0,
              durationMs: 0,
            },
            ...(metadata !== undefined ? { metadata } : {}),
          },
        };
        return;
      }
    }
  }

  // Stream ended without a terminal "done" or "error" chunk — transport
  // breakage, iterator cancellation, or provider version skew. Synthesize
  // a terminal error so downstream consumers always get a deterministic
  // end-of-stream signal. Include any accumulated text so partial output
  // is not lost.
  const partialText = textFragments.join("");
  const danglingOnTruncate = buildDanglingToolCalls(accumulators);
  yield {
    kind: "done",
    output: {
      content: partialText.length > 0 ? [{ kind: "text", text: partialText }] : [],
      stopReason: "error",
      metrics: {
        totalTokens: inputTokens + outputTokens,
        inputTokens,
        outputTokens,
        turns: 0,
        durationMs: 0,
      },
      metadata: {
        error: "stream ended without terminal chunk",
        ...(danglingOnTruncate.length > 0 ? { danglingToolCalls: danglingOnTruncate } : {}),
      },
    },
  };
}
