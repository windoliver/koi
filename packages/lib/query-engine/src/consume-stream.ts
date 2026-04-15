import type { EngineEvent, ModelChunk, ToolCallId } from "@koi/core";
import type { AccumulatedToolCall } from "./types.js";

// ---------------------------------------------------------------------------
// Abort-aware promise racing
// ---------------------------------------------------------------------------

/**
 * Races a promise against an AbortSignal. If the signal fires before the
 * promise settles, rejects immediately — the caller regains control even
 * if the underlying promise (e.g., `iterator.next()`) is hung.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);

  const abortPromise = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.finally(() => signal.removeEventListener("abort", onAbort));
  });

  void abortPromise.catch(noop);
  void promise.catch(noop);

  return Promise.race([promise, abortPromise]);
}

function noop(): void {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Stream consumer
// ---------------------------------------------------------------------------

/**
 * Consumes an `AsyncIterable<ModelChunk>` from a model provider and yields
 * `EngineEvent`s, accumulating streamed tool-call argument deltas into parsed
 * payloads.
 *
 * **Invariant:** Every call produces exactly one `done` event as its final
 * emission — whether the stream completes normally, ends without a terminal
 * chunk, throws, or is cancelled via `signal`.
 *
 * **Abort preemption:** Each `iterator.next()` call is raced against the
 * signal. If the signal fires while the upstream is stalled, the consumer
 * regains control immediately. Timeouts (`AbortSignal.timeout()`) produce
 * `stopReason: "error"` with `"Stream timed out"`, while caller aborts
 * produce `stopReason: "interrupted"`.
 *
 * Usage and error chunks are absorbed — usage is folded into the final `done`
 * event metrics, and model errors produce a `done` event with `stopReason: "error"`.
 */
export async function* consumeModelStream(
  chunks: AsyncIterable<ModelChunk>,
  signal?: AbortSignal,
): AsyncGenerator<EngineEvent> {
  const accumulators = new Map<
    ToolCallId,
    { readonly toolName: string; readonly fragments: string[] }
  >();

  let inputTokens = 0;
  let outputTokens = 0;
  const completedToolCalls: AccumulatedToolCall[] = [];
  const textFragments: string[] = [];

  const iterator = chunks[Symbol.asyncIterator]();
  try {
    while (true) {
      let iterResult: IteratorResult<ModelChunk>;
      try {
        iterResult = await raceAbort(iterator.next(), signal);
      } catch (error: unknown) {
        // Abort or upstream error — emit terminal done
        const partialText = textFragments.join("");
        const dangling = buildDanglingToolCalls(accumulators);
        if (signal?.aborted) {
          const isTimeout =
            signal.reason instanceof DOMException && signal.reason.name === "TimeoutError";
          yield {
            kind: "done",
            output: {
              content: partialText.length > 0 ? [{ kind: "text", text: partialText }] : [],
              stopReason: isTimeout ? "error" : "interrupted",
              metrics: {
                totalTokens: inputTokens + outputTokens,
                inputTokens,
                outputTokens,
                turns: 0,
                durationMs: 0,
              },
              metadata: {
                error: isTimeout ? "Stream timed out" : "Stream cancelled",
                ...(dangling.length > 0 ? { danglingToolCalls: dangling } : {}),
              },
            },
          };
        } else {
          const message = error instanceof Error ? error.message : "Unknown stream error";
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
                error: message,
                ...(dangling.length > 0 ? { danglingToolCalls: dangling } : {}),
              },
            },
          };
        }
        return;
      }

      if (iterResult.done) break;
      const chunk = iterResult.value;

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
          // acc is undefined when tool_call_start was never emitted for this callId
          // (should not happen after stream-parser fix, but kept as safety fallback).
          const toolName = acc ? acc.toolName : "";
          accumulators.delete(chunk.callId);

          let parsedArgs: AccumulatedToolCall["parsedArgs"];
          let parseError: string | undefined;
          try {
            const parsed: unknown = JSON.parse(rawArgs);
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              parsedArgs = parsed as AccumulatedToolCall["parsedArgs"];
            } else {
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
            inputTokens = chunk.usage.inputTokens;
            outputTokens = chunk.usage.outputTokens;
          }
          const errorPartialText = textFragments.join("");
          // When no model text has streamed, use the error message as content
          // so hook-block denial reasons are visible to users, not swallowed.
          const errorContent = errorPartialText.length > 0 ? errorPartialText : chunk.message;
          const danglingOnError = buildDanglingToolCalls(accumulators);
          yield {
            kind: "done",
            output: {
              content: errorContent.length > 0 ? [{ kind: "text", text: errorContent }] : [],
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

          const danglingOnDone = buildDanglingToolCalls(accumulators);

          // Determine engine stop reason. Priority:
          // 1. Dangling tool calls → "error" (incomplete response)
          // 2. Non-success model stop reason (error, hook_blocked) → "error"
          //    (preserve denial/failure signal from middleware or provider)
          // 3. Truncated tool calls ("length" + completed tool calls) → "error"
          //    (model hit max_tokens — may have intended additional tool calls)
          // 4. Otherwise → "completed"
          const responseStopReason = chunk.response.stopReason;
          const isNonSuccess =
            responseStopReason !== undefined &&
            responseStopReason !== "stop" &&
            responseStopReason !== "length" &&
            responseStopReason !== "tool_use";
          // When the model hit max_tokens ("length") but completed tool calls
          // exist, the response is incomplete — the model may have intended
          // additional tool calls that were cut off. Reject all tool calls
          // rather than executing a potentially incomplete batch.
          const isTruncatedToolCall =
            responseStopReason === "length" && completedToolCalls.length > 0;
          const stopReason =
            danglingOnDone.length > 0
              ? "error"
              : isNonSuccess
                ? "error"
                : isTruncatedToolCall
                  ? "error"
                  : "completed";

          // Build metadata: merge response metadata (hook block info, etc.)
          // with dangling tool call warnings. Use distinct keys so dangling-tool-call
          // diagnostics never overwrite upstream error details from the response.
          const responseMeta = chunk.response.metadata;
          const hasDangling = danglingOnDone.length > 0;
          const hasResponseMeta =
            responseMeta !== undefined && Object.keys(responseMeta).length > 0;
          const metadata =
            hasDangling || hasResponseMeta || isTruncatedToolCall
              ? {
                  ...(hasResponseMeta ? responseMeta : {}),
                  ...(isNonSuccess && responseStopReason !== undefined
                    ? { modelStopReason: responseStopReason }
                    : {}),
                  ...(isTruncatedToolCall
                    ? {
                        modelStopReason: "length" as const,
                        truncatedToolCallError:
                          "model hit max_tokens with completed tool calls — response may be incomplete",
                        truncatedToolCalls: completedToolCalls.map((tc) => ({
                          callId: tc.callId,
                          toolName: tc.toolName,
                        })),
                      }
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
  } finally {
    // Iterator cleanup — await with a safety timeout so downstream finally
    // blocks (e.g., session-transcript writing its turn entries) complete
    // before the surrounding code observes turn_end. Without awaiting, the
    // transcript write races `onAfterTurn` hooks that read the transcript
    // file. 200ms is generous for local fs writes but short enough that a
    // misbehaving iterator cannot hang the turn indefinitely.
    try {
      const ret = iterator.return?.();
      if (ret !== undefined) {
        await Promise.race([
          ret.catch(noop),
          new Promise<void>((resolve) => setTimeout(resolve, 200)),
        ]);
      }
    } catch {
      // Swallow synchronous cleanup errors
    }
  }

  // Stream ended without terminal chunk
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
