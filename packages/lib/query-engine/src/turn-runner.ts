/**
 * Turn runner — async generator that drives the model→tool→model loop.
 *
 * Uses the pure turn state machine for transitions and `consumeModelStream`
 * for stream consumption. Interacts with the engine through `ComposedCallHandlers`.
 */

import type {
  ComposedCallHandlers,
  ContentBlock,
  EngineEvent,
  InboundMessage,
  JsonObject,
  ModelRequest,
  StopGateResult,
} from "@koi/core";
import { DEFAULT_MAX_STOP_RETRIES } from "@koi/core";
import { consumeModelStream } from "./consume-stream.js";
import type { TurnState } from "./turn-machine.js";
import { createTurnState, transitionTurn } from "./turn-machine.js";
import type { AccumulatedToolCall } from "./types.js";
import { validateToolArgs } from "./validate-tool-args.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TurnRunnerConfig {
  readonly callHandlers: ComposedCallHandlers;
  readonly messages: readonly InboundMessage[];
  readonly signal?: AbortSignal | undefined;
  readonly maxTurns?: number | undefined;
  /**
   * Optional stop gate callback. Called when the model completes without tool calls.
   * If it returns `{ kind: "block", reason }`, the reason is injected into the
   * transcript and the model is re-prompted instead of completing.
   */
  readonly stopGate?: (turnIndex: number) => Promise<StopGateResult>;
  /** Maximum stop-gate re-prompts per session. Default: DEFAULT_MAX_STOP_RETRIES (3). */
  readonly maxStopRetries?: number | undefined;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function* runTurn(config: TurnRunnerConfig): AsyncGenerator<EngineEvent> {
  const {
    callHandlers,
    messages,
    signal,
    maxTurns,
    stopGate,
    maxStopRetries = DEFAULT_MAX_STOP_RETRIES,
  } = config;

  // let justified: mutable state driven by pure transition function
  let state: TurnState = createTurnState(0);
  // let justified: mutable conversation transcript, grows across turns
  const transcript: InboundMessage[] = [...messages];
  // let justified: mutable usage accumulators
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  // let justified: mutable ref to the last (terminal) turn's text for done.output.content
  let lastTurnText: readonly string[] = [];
  // let justified: mutable error metadata for structured error reporting in done event
  let errorMetadata: JsonObject | undefined;
  // let justified: mutable counter for stop-gate re-prompts
  let stopRetryCount = 0;
  const startTime = performance.now();

  // Pre-flight: handle already-aborted signal before entering the state machine.
  // The idle state only accepts "start", so we short-circuit here.
  if (isAborted(signal)) {
    state = { ...state, phase: "complete", stopReason: "interrupted" };
  }

  // Pre-flight: enforce zero-turn budget before any work.
  if (state.phase !== "complete" && maxTurns !== undefined && maxTurns <= 0) {
    state = { ...state, phase: "complete", stopReason: "max_turns" };
  }

  while (state.phase !== "complete") {
    // Check abort before each model call
    if (isAborted(signal)) {
      state = transitionTurn(state, { kind: "abort" });
      break;
    }

    // Check max turns at continue boundary
    if (state.phase === "continue" && maxTurns !== undefined && state.turnIndex >= maxTurns) {
      state = transitionTurn(state, { kind: "max_turns" });
      break;
    }

    // idle/continue → model
    state = transitionTurn(state, { kind: "start" });
    yield { kind: "turn_start", turnIndex: state.turnIndex };

    // Build model request from accumulated transcript.
    // Snapshot the tool descriptors at request time — validation uses this
    // immutable set, not the live callHandlers.tools which can change.
    //
    // Note: middleware can further filter modelRequest.tools before the model
    // sees them. This runner validates against the pre-middleware snapshot.
    // Defense-in-depth: callHandlers.toolCall also goes through the middleware
    // chain, so middleware-filtered tools are rejected at execution time too.
    // Defensive clone — prevents middleware or getter mutations from
    // affecting the allowlist/schema snapshot used for validation.
    const advertisedTools = [...callHandlers.tools];
    const advertisedToolIds = new Set(advertisedTools.map((t) => t.name));
    const modelRequest = buildModelRequest(transcript, advertisedTools, signal);

    // Stream model response and collect tool calls
    const toolCalls: AccumulatedToolCall[] = [];
    // let justified: mutable per-turn text for transcript accumulation
    const turnText: string[] = [];
    // let justified: mutable sentinel — true only when a terminal done/error chunk was seen
    let sawTerminal = false;
    // let justified: mutable flag — true when terminal done already committed metrics
    let terminalMetricsCommitted = false;
    // let justified: mutable per-turn usage tracked from custom events
    let turnInputTokens = 0;
    let turnOutputTokens = 0;

    try {
      const stream =
        callHandlers.modelStream !== undefined
          ? callHandlers.modelStream(modelRequest)
          : synthesizeStream(callHandlers, modelRequest);

      for await (const event of consumeModelStream(stream)) {
        if (isAborted(signal)) {
          state = transitionTurn(state, { kind: "abort" });
          yield { kind: "turn_end", turnIndex: state.turnIndex };
          break;
        }

        if (event.kind === "done") {
          sawTerminal = true;
          // Intercept done — runner owns the final done event.
          // Propagate non-completed stop reasons as errors.
          // Use authoritative terminal metrics for this turn (supersedes
          // incremental custom events). Add to cross-turn totals.
          if (event.output.metrics) {
            totalInputTokens += event.output.metrics.inputTokens;
            totalOutputTokens += event.output.metrics.outputTokens;
            terminalMetricsCommitted = true;
          } else {
            // No terminal metrics — fall back to incrementally tracked usage
            totalInputTokens += turnInputTokens;
            totalOutputTokens += turnOutputTokens;
            terminalMetricsCommitted = true;
          }
          if (event.output.stopReason !== "completed") {
            errorMetadata = {
              source: "model_stream",
              originalStopReason: event.output.stopReason,
              ...(event.output.metadata !== undefined
                ? { providerDetail: event.output.metadata }
                : {}),
            };
            state = transitionTurn(state, {
              kind: "error",
              message: `model stream ended with stopReason: ${event.output.stopReason}`,
            });
          }
          break;
        }

        // Intercept usage custom events for partial usage tracking.
        // Per-turn usage is tracked so early exits (abort/error) still
        // report consumed tokens. Not forwarded to the consumer.
        if (event.kind === "custom" && event.type === "usage") {
          const usage = event.data as {
            readonly inputTokens: number;
            readonly outputTokens: number;
          };
          turnInputTokens += usage.inputTokens;
          turnOutputTokens += usage.outputTokens;
          continue;
        }

        // Accumulate per-turn text for transcript
        if (event.kind === "text_delta") {
          turnText.push(event.delta);
        }

        if (event.kind === "tool_call_end") {
          const accumulated = event.result as AccumulatedToolCall;
          toolCalls.push(accumulated);
        }

        yield event;
      }
    } catch (e: unknown) {
      lastTurnText = turnText;
      // Preserve partial usage from this turn on early exit
      totalInputTokens += turnInputTokens;
      totalOutputTokens += turnOutputTokens;
      const msg = e instanceof Error ? e.message : String(e);
      errorMetadata = { source: "stream_exception", message: msg };
      state = transitionTurn(state, { kind: "error", message: msg });
      yield { kind: "turn_end", turnIndex: state.turnIndex };
      break;
    }

    // Update lastTurnText eagerly so error/abort breaks report
    // the current turn's text, not a previous turn's.
    lastTurnText = turnText;

    // If abort or stream error happened, we already transitioned.
    // Preserve partial usage only if terminal metrics weren't already committed.
    if (state.phase === "complete") {
      if (!terminalMetricsCommitted) {
        totalInputTokens += turnInputTokens;
        totalOutputTokens += turnOutputTokens;
      }
      break;
    }

    // Fail if stream ended without a terminal done/error chunk (truncated)
    if (!sawTerminal) {
      totalInputTokens += turnInputTokens;
      totalOutputTokens += turnOutputTokens;
      errorMetadata = { source: "truncated_stream" };
      state = transitionTurn(state, {
        kind: "error",
        message: "model stream ended without a terminal done/error chunk",
      });
      yield { kind: "turn_end", turnIndex: state.turnIndex };
      break;
    }

    // Validate tool calls — fail closed on malformed/orphaned calls.
    // Empty toolName ("") means the function name was never received in the stream;
    // "unknown" is the legacy fallback (kept for safety, should no longer appear).
    const validToolCalls = toolCalls.filter(
      (tc) => tc.toolName !== "" && tc.toolName !== "unknown" && tc.parsedArgs !== undefined,
    );
    if (validToolCalls.length < toolCalls.length) {
      const invalidCount = toolCalls.length - validToolCalls.length;
      errorMetadata = { source: "malformed_tool_call", invalidCount };
      state = transitionTurn(state, {
        kind: "error",
        message: `${invalidCount} tool call(s) had malformed or missing arguments — failing closed`,
      });
      yield { kind: "turn_end", turnIndex: state.turnIndex };
      break;
    }

    // Validate tool calls against the advertised snapshot — fail closed on
    // undeclared tool IDs to prevent model hallucination or prompt injection
    // from reaching internal/undeclared tools.
    // When no tools were advertised, any model-issued tool call is undeclared.
    if (validToolCalls.length > 0) {
      const undeclared = validToolCalls.filter((tc) => !advertisedToolIds.has(tc.toolName));
      if (undeclared.length > 0) {
        const names = undeclared.map((tc) => tc.toolName).join(", ");
        errorMetadata = { source: "undeclared_tool", tools: names };
        state = transitionTurn(state, {
          kind: "error",
          message: `tool call(s) for undeclared tool(s): ${names} — failing closed`,
        });
        yield { kind: "turn_end", turnIndex: state.turnIndex };
        break;
      }
    }

    // Validate tool arguments against advertised inputSchema
    if (validToolCalls.length > 0) {
      const descriptorMap = new Map(advertisedTools.map((t) => [t.name, t]));
      const schemaErrors: string[] = [];
      for (const tc of validToolCalls) {
        const descriptor = descriptorMap.get(tc.toolName);
        if (descriptor !== undefined) {
          const error = validateToolArgs(tc.parsedArgs as JsonObject, descriptor);
          if (error !== undefined) {
            schemaErrors.push(`${tc.toolName}: ${error}`);
          }
        }
      }
      if (schemaErrors.length > 0) {
        errorMetadata = { source: "schema_validation", errors: schemaErrors };
        state = transitionTurn(state, {
          kind: "error",
          message: `tool argument validation failed — ${schemaErrors.join("; ")}`,
        });
        yield { kind: "turn_end", turnIndex: state.turnIndex };
        break;
      }
    }

    // Dedup: within this turn, skip tool calls with identical (toolName + args).
    // Models occasionally emit the same call twice in one response (e.g. Sonnet
    // via OpenRouter). Keep the first occurrence; record skipped duplicates for
    // observability. Uses canonicalized JSON of parsed args (recursively sorted
    // keys) to catch semantically identical calls even with different key ordering.
    const seen = new Set<string>();
    const dedupedToolCalls: typeof validToolCalls = [];
    const skippedToolCalls: typeof validToolCalls = [];
    for (const tc of validToolCalls) {
      const canonicalArgs =
        tc.parsedArgs !== undefined ? stableStringify(tc.parsedArgs) : tc.rawArgs;
      const key = `${tc.toolName}\0${canonicalArgs}`;
      if (seen.has(key)) {
        skippedToolCalls.push(tc);
      } else {
        seen.add(key);
        dedupedToolCalls.push(tc);
      }
    }
    if (skippedToolCalls.length > 0) {
      yield {
        kind: "custom",
        type: "dedup_skipped",
        data: {
          skipped: skippedToolCalls.map((tc) => ({ toolName: tc.toolName, callId: tc.callId })),
        },
      };
    }

    // Transition based on model response
    state = transitionTurn(state, {
      kind: "model_done",
      hasToolCalls: dedupedToolCalls.length > 0,
    });

    // Stop gate: when model completes (no tool calls), check if any hook
    // blocks completion. If blocked, inject reason and re-prompt the model.
    if (
      state.phase === "complete" &&
      state.stopReason === "completed" &&
      stopGate !== undefined &&
      stopRetryCount < maxStopRetries
    ) {
      const gateResult = await stopGate(state.turnIndex);
      if (gateResult.kind === "block") {
        // Append the assistant's text so it's visible in context
        if (turnText.length > 0) {
          appendAssistantTurn(transcript, turnText, []);
        }
        // Inject block reason as a system message for the next model call
        transcript.push({
          senderId: "system",
          content: [
            {
              kind: "text",
              text: `[Completion blocked]: ${gateResult.reason}. Address this before completing.`,
            },
          ],
          timestamp: Date.now(),
        });
        stopRetryCount++;
        // Transition back to continue phase for re-prompting
        state = transitionTurn(state, { kind: "stop_blocked" });
        yield { kind: "turn_end", turnIndex: state.turnIndex - 1 };
        continue;
      }
    }

    if (state.phase === "tool_execution") {
      // Append ALL tool call intents (including skipped duplicates) to the
      // transcript so session-repair's callId pairing stays consistent —
      // every tool_call_* event the model emitted has a matching intent.
      appendAssistantTurn(transcript, turnText, validToolCalls);

      // Build a map from dedup key → skipped callIds for result replication.
      const skippedByKey = new Map<string, typeof skippedToolCalls>();
      for (const tc of skippedToolCalls) {
        const canonicalArgs =
          tc.parsedArgs !== undefined ? stableStringify(tc.parsedArgs) : tc.rawArgs;
        const key = `${tc.toolName}\0${canonicalArgs}`;
        const existing = skippedByKey.get(key);
        if (existing !== undefined) {
          existing.push(tc);
        } else {
          skippedByKey.set(key, [tc]);
        }
      }

      // Execute deduped tool calls sequentially. On success, replicate the
      // real result to any skipped duplicates so the model sees consistent
      // output for every callId. On failure (throw), the duplicates remain
      // without a result — the error propagates and the turn fails.
      try {
        const results: ToolResult[] = [];
        for (const tc of dedupedToolCalls) {
          if (isAborted(signal)) {
            state = transitionTurn(state, { kind: "abort" });
            break;
          }
          const response = await callHandlers.toolCall({
            toolId: tc.toolName,
            // parsedArgs is guaranteed defined by the filter above
            input: tc.parsedArgs as import("@koi/core").JsonObject,
            ...(signal !== undefined ? { signal } : {}),
          });
          // Record result BEFORE checking abort — the tool already ran and
          // committed side effects, so the transcript must reflect that.
          const result: ToolResult = {
            callId: tc.callId,
            toolName: tc.toolName,
            output: response.output,
          };
          results.push(result);
          appendToolResult(transcript, result);
          yield {
            kind: "tool_result" as const,
            callId: tc.callId,
            toolName: tc.toolName,
            output: response.output,
          };

          // Replicate the real result to skipped duplicates so the model
          // sees the actual output for every callId, not a placeholder.
          const canonicalArgs =
            tc.parsedArgs !== undefined ? stableStringify(tc.parsedArgs) : tc.rawArgs;
          const key = `${tc.toolName}\0${canonicalArgs}`;
          const duplicates = skippedByKey.get(key);
          if (duplicates !== undefined) {
            for (const dup of duplicates) {
              const dupResult: ToolResult = {
                callId: dup.callId,
                toolName: dup.toolName,
                output: response.output,
              };
              results.push(dupResult);
              appendToolResult(transcript, dupResult);
              yield {
                kind: "tool_result" as const,
                callId: dup.callId,
                toolName: dup.toolName,
                output: response.output,
              };
            }
          }

          if (isAborted(signal)) {
            state = transitionTurn(state, { kind: "abort" });
            break;
          }
        }
        if (state.phase === "tool_execution") {
          state = transitionTurn(state, { kind: "tools_done" });
        }
      } catch (e: unknown) {
        if (state.phase !== "complete") {
          const msg = e instanceof Error ? e.message : String(e);
          errorMetadata = { source: "tool_execution", message: msg };
          state = transitionTurn(state, { kind: "error", message: msg });
        }
      }
    } else if (turnText.length > 0) {
      // Text-only turn — append assistant message to transcript
      appendAssistantTurn(transcript, turnText, []);
    }

    yield {
      kind: "turn_end",
      turnIndex: state.phase === "continue" ? state.turnIndex - 1 : state.turnIndex,
    };
  }

  // Final done event — only the terminal turn's text, not all turns concatenated
  const durationMs = performance.now() - startTime;
  const finalText = lastTurnText.join("");
  const content: readonly ContentBlock[] =
    finalText.length > 0 ? [{ kind: "text", text: finalText }] : [];
  yield {
    kind: "done",
    output: {
      content,
      stopReason: state.stopReason ?? "completed",
      metrics: {
        totalTokens: totalInputTokens + totalOutputTokens,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        turns: state.modelCalls,
        durationMs,
      },
      ...(errorMetadata !== undefined || stopRetryCount > 0
        ? {
            metadata: {
              ...(errorMetadata ?? {}),
              ...(stopRetryCount > 0 ? { stopRetryCount } : {}),
            },
          }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check abort without TS narrowing the signal type for subsequent checks. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

interface ToolResult {
  readonly callId: string;
  readonly toolName: string;
  readonly output: unknown;
}

function buildModelRequest(
  transcript: readonly InboundMessage[],
  tools: ComposedCallHandlers["tools"],
  signal: AbortSignal | undefined,
): ModelRequest {
  return {
    // Snapshot the transcript so later mutations don't affect this request
    messages: [...transcript],
    tools,
    ...(signal !== undefined ? { signal } : {}),
  };
}

/**
 * Append assistant turn messages to the transcript.
 *
 * Combines text content and tool-call intents into a SINGLE assistant message
 * with `metadata.toolCalls` so the request-mapper can reconstruct the OpenAI
 * `tool_calls` array. Splitting them into separate messages causes
 * `fixTranscriptOrdering` to clear `pendingCallIds` between the text message
 * and tool-call messages, which drops all subsequent tool results as orphaned.
 *
 * When there are no tool calls, the message has just text content and no
 * tool-call metadata.
 */
function appendAssistantTurn(
  transcript: InboundMessage[],
  textParts: readonly string[],
  toolCalls: readonly AccumulatedToolCall[],
): void {
  const text = textParts.join("");

  // No tool calls — simple text-only assistant message
  if (toolCalls.length === 0) {
    if (text.length > 0) {
      transcript.push({
        senderId: "assistant",
        content: [{ kind: "text", text }],
        timestamp: Date.now(),
      });
    }
    return;
  }

  // Build OpenAI-compatible tool_calls metadata so the request-mapper
  // reconstructs the full assistant message with tool_calls array.
  const toolCallsMeta = toolCalls.map((tc) => ({
    id: tc.callId,
    type: "function" as const,
    function: {
      name: tc.toolName,
      arguments: tc.rawArgs,
    },
  }));

  transcript.push({
    senderId: "assistant",
    content: [{ kind: "text", text: text.length > 0 ? text : "" }],
    timestamp: Date.now(),
    metadata: { toolCalls: toolCallsMeta },
  });
}

/**
 * Append a tool result to the transcript.
 *
 * Uses `senderId: "tool"` and `metadata.callId` to match the
 * session-repair pairing contract (map-call-id-pairs.ts).
 */
function appendToolResult(transcript: InboundMessage[], result: ToolResult): void {
  transcript.push({
    senderId: "tool",
    content: [
      {
        kind: "text",
        text: safeStringify({ callId: result.callId, output: result.output }),
      },
    ],
    timestamp: Date.now(),
    metadata: { callId: result.callId, toolName: result.toolName },
  });
}

/**
 * Serialize a value to JSON. On non-serializable values (BigInt, circular refs),
 * returns a structured error envelope so the model can see serialization failed
 * rather than reasoning over a lossy `[object Object]` string.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (e: unknown) {
    return JSON.stringify({
      __serialization_error: true,
      type: typeof value,
      message: e instanceof Error ? e.message : "JSON serialization failed",
      preview: truncate(String(value), 200),
    });
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * Recursively sort object keys and serialize to JSON for stable comparison.
 * Arrays preserve order; nested objects are sorted at every level.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortDeep);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortDeep((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Fallback for non-streaming model calls. Calls modelCall and synthesizes
 * a minimal ModelChunk stream from the response.
 */
async function* synthesizeStream(
  callHandlers: ComposedCallHandlers,
  request: ModelRequest,
): AsyncIterable<import("@koi/core").ModelChunk> {
  const response = await callHandlers.modelCall(request);
  if (response.content) {
    yield { kind: "text_delta", delta: response.content };
  }
  yield {
    kind: "done",
    response,
  };
}
