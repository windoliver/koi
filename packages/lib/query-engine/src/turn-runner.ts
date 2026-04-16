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
  ToolCallId,
} from "@koi/core";
import { DEFAULT_MAX_STOP_RETRIES } from "@koi/core";
import { coerceToolArgs } from "./coerce-tool-args.js";
import { consumeModelStream } from "./consume-stream.js";
import {
  DEFAULT_DOOM_LOOP_THRESHOLD,
  DEFAULT_MAX_DOOM_LOOP_INTERVENTIONS,
  parseDoomLoopKey,
  partitionDoomLoopKeys,
  updateStreaks,
} from "./doom-loop.js";
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
  /**
   * Consecutive turns with an identical tool call (same name + args) before
   * the runner injects a system message telling the model to stop repeating.
   * Set to 0 or 1 to disable. Default: DEFAULT_DOOM_LOOP_THRESHOLD (3).
   */
  readonly doomLoopThreshold?: number | undefined;
  /**
   * Maximum doom-loop interventions before giving up and letting tools execute.
   * `maxTurns` remains the ultimate safety valve.
   * Default: DEFAULT_MAX_DOOM_LOOP_INTERVENTIONS (2).
   */
  readonly maxDoomLoopInterventions?: number | undefined;
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
    doomLoopThreshold = DEFAULT_DOOM_LOOP_THRESHOLD,
    maxDoomLoopInterventions = DEFAULT_MAX_DOOM_LOOP_INTERVENTIONS,
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
  // let justified: mutable doom-loop streak counters (key → consecutive turn count)
  let doomLoopStreaks = new Map<string, number>();
  // let justified: mutable doom-loop intervention counters per key
  const doomLoopInterventionsByKey = new Map<string, number>();
  // let justified: mutable — tool calls blocked by doom-loop filtering in mixed turns
  let doomLoopBlockedCalls: AccumulatedToolCall[] = [];
  const startTime = performance.now();

  // #1742 loop-3 round 7: cap tool-error recovery to ONE extra turn.
  // Without this, a deterministic tool failure (permission denial,
  // policy block, broken tool) drives the outer loop until maxTurns
  // — model retry, blocked tool, synthetic error, model retry, ...
  // — burning tokens and stalling users. After one recovery turn,
  // a second tool-execution failure transitions to error and breaks
  // the loop instead of looping again.
  // let justified: mutable per-run flag, set inside the catch path
  let toolErrorRecoveryUsed = false;

  // #1768: cap truncation recovery to ONE re-prompt. If the model hits
  // max_tokens again on the retry turn, the truncation is effectively
  // structural (prompt too large, limit too low) — fail closed.
  // let justified: mutable per-run flag, set in the truncation recovery block
  let truncationRecoveryUsed = false;

  // #1754: cap schema-validation recovery to ONE consecutive re-prompt.
  // If the model sends invalid args on the very next turn after recovery,
  // the problem is structural — fail closed. Reset after any successful
  // tool-execution turn so unrelated later mistakes still get recovery.
  // let justified: mutable flag, set/cleared across turns
  let schemaValidationRecoveryPending = false;

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
    // let justified: mutable per-turn flag — set when done event has truncation metadata
    let truncationDetectedThisTurn = false;

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
            // #1768: truncation with completed tool calls is recoverable
            // when the recovery budget hasn't been spent. Detect via the
            // metadata flag set by consumeModelStream.
            const providerMeta = event.output.metadata as Record<string, unknown> | undefined;
            const isTruncation = providerMeta?.truncatedToolCallError !== undefined;

            if (isTruncation && !truncationRecoveryUsed) {
              // Recoverable — don't transition to error. The recovery
              // block after the stream loop will inject feedback and
              // re-prompt the model.
              truncationDetectedThisTurn = true;
            } else {
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

    // #1768: truncation recovery — give the model one chance to retry
    // when it hit max_tokens with completed tool calls. Mirrors the
    // stop_blocked re-prompt pattern: append context, inject feedback,
    // transition to continue, and re-enter the while loop.
    if (truncationDetectedThisTurn) {
      truncationRecoveryUsed = true;
      // Preserve partial text so the model sees what it already said
      if (turnText.length > 0) {
        appendAssistantTurn(transcript, turnText, []);
      }
      transcript.push({
        senderId: "system:truncation",
        content: [
          {
            kind: "text",
            text: "[Truncation detected]: Your previous response was cut short at the token limit. Tool calls were not executed because the response may be incomplete. Please retry with fewer tool calls or shorter arguments.",
          },
        ],
        timestamp: Date.now(),
      });
      yield {
        kind: "custom",
        type: "truncation_recovery",
        data: { turnIndex: state.turnIndex },
      };
      // model → complete (no tool calls) → continue (blocked)
      state = transitionTurn(state, { kind: "model_done", hasToolCalls: false });
      state = transitionTurn(state, { kind: "stop_blocked" });
      yield { kind: "turn_end", turnIndex: state.turnIndex - 1 };
      continue;
    }

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

    // Coerce string values to declared schema types before validation.
    // Models (especially weaker ones) sometimes send "5" for a number field.
    // Keyed by tool call ID since parsedArgs is readonly on the tool call object.
    const coercedArgsMap = new Map<string, JsonObject>();

    /** Compute a canonical dedup/loop key using coerced args when available. */
    function toolCallKey(tc: AccumulatedToolCall): string {
      const effectiveArgs = coercedArgsMap.get(tc.callId) ?? tc.parsedArgs;
      const canonical = effectiveArgs !== undefined ? stableStringify(effectiveArgs) : tc.rawArgs;
      return `${tc.toolName}\0${canonical}`;
    }
    if (validToolCalls.length > 0) {
      const descriptorMap = new Map(advertisedTools.map((t) => [t.name, t]));

      for (const tc of validToolCalls) {
        const descriptor = descriptorMap.get(tc.toolName);
        if (descriptor !== undefined && tc.parsedArgs !== undefined) {
          const coerced = coerceToolArgs(tc.parsedArgs as JsonObject, descriptor.inputSchema);
          coercedArgsMap.set(tc.callId, coerced);
        }
      }

      // Emit observability event when coercion changed any arguments.
      // Transcript records raw model output; execution uses coerced values.
      const coercedEntries = validToolCalls.filter((tc) => {
        const coerced = coercedArgsMap.get(tc.callId);
        return coerced !== undefined && coerced !== tc.parsedArgs;
      });
      if (coercedEntries.length > 0) {
        yield {
          kind: "custom",
          type: "args_coerced",
          data: {
            coerced: coercedEntries.map((tc) => ({
              toolName: tc.toolName,
              callId: tc.callId,
            })),
          },
        };
      }

      // Validate tool arguments against advertised inputSchema
      const schemaErrors: string[] = [];
      const schemaErrorsByCallId = new Map<string, string>();
      for (const tc of validToolCalls) {
        const descriptor = descriptorMap.get(tc.toolName);
        if (descriptor !== undefined) {
          const args = coercedArgsMap.get(tc.callId) ?? (tc.parsedArgs as JsonObject);
          const error = validateToolArgs(args, descriptor);
          if (error !== undefined) {
            schemaErrors.push(`${tc.toolName}: ${error}`);
            schemaErrorsByCallId.set(tc.callId, `${tc.toolName}: ${error}`);
          }
        }
      }
      if (schemaErrors.length > 0) {
        errorMetadata = { source: "schema_validation", errors: schemaErrors };

        // #1754: consecutive schema failure after a recovery turn → hard error.
        // Also hard-fail when maxTurns is exhausted — the recovery turn would
        // be consumed by the budget check, misclassifying the failure as max_turns.
        const turnBudgetExhausted = maxTurns !== undefined && state.turnIndex + 1 >= maxTurns;
        if (schemaValidationRecoveryPending || turnBudgetExhausted) {
          state = transitionTurn(state, {
            kind: "error",
            message: schemaValidationRecoveryPending
              ? `tool argument validation failed again after recovery turn — ${schemaErrors.join("; ")}`
              : `tool argument validation failed and no turn budget for recovery — ${schemaErrors.join("; ")}`,
          });
          yield { kind: "turn_end", turnIndex: state.turnIndex };
          break;
        }
        schemaValidationRecoveryPending = true;

        // Record the assistant's tool-call intents in the transcript so
        // every streamed tool_call event has a matching intent.
        appendAssistantTurn(transcript, turnText, validToolCalls);

        // Synthesize error tool_results for every tool call in this turn.
        // Calls that passed validation also get a synthetic result because
        // the whole batch is rejected — partial execution would be surprising.
        for (const tc of validToolCalls) {
          const errorMsg =
            schemaErrorsByCallId.get(tc.callId) ??
            "Co-occurring tool call skipped due to validation failure in this batch";
          const syntheticOutput = {
            error: `Schema validation failed: ${errorMsg}`,
            code: "SCHEMA_VALIDATION_ERROR",
          } as const;
          appendToolResult(transcript, {
            callId: tc.callId,
            toolName: tc.toolName,
            output: syntheticOutput,
          });
          yield {
            kind: "tool_result",
            callId: tc.callId as ToolCallId,
            output: syntheticOutput,
          };
        }

        // Schema-invalid turns break doom-loop streaks for the tools
        // in this batch — the model's corrected retry must not be counted
        // as consecutive. Only clear entries whose tool name appeared in
        // the invalid batch; preserve streaks for unrelated tools.
        const invalidToolNames = new Set(validToolCalls.map((tc) => tc.toolName));
        for (const key of [...doomLoopStreaks.keys()]) {
          if (invalidToolNames.has(parseDoomLoopKey(key).toolName)) {
            doomLoopStreaks.delete(key);
          }
        }
        for (const key of [...doomLoopInterventionsByKey.keys()]) {
          if (invalidToolNames.has(parseDoomLoopKey(key).toolName)) {
            doomLoopInterventionsByKey.delete(key);
          }
        }

        // Transition to continue so the model gets a recovery turn.
        state = transitionTurn(state, { kind: "model_done", hasToolCalls: false });
        if (state.stopReason === "completed") {
          state = transitionTurn(state, { kind: "stop_blocked" });
        }
        yield { kind: "turn_end", turnIndex: state.turnIndex - 1 };
        continue;
      }
    }

    // Schema-recovery pending state is cleared after successful tool
    // execution (tools_done path below), not here. Validation passing
    // alone is insufficient — the tool call may still be doom-loop-blocked
    // or throw at execution time.

    // Dedup: within this turn, skip tool calls with identical (toolName + args).
    // Models occasionally emit the same call twice in one response (e.g. Sonnet
    // via OpenRouter). Keep the first occurrence; record skipped duplicates for
    // observability. Uses coerced args (when available) so that semantically
    // identical calls like {"count":"5"} and {"count":5} are treated as dupes.
    const seen = new Set<string>();
    // let justified: mutable — doom loop detection may filter out repeated calls
    let dedupedToolCalls: typeof validToolCalls = [];
    const skippedToolCalls: typeof validToolCalls = [];
    for (const tc of validToolCalls) {
      const key = toolCallKey(tc);
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

    // Doom loop detection: check if any deduped tool call has been repeated
    // across consecutive turns. Per-key detection blocks individual repeated
    // calls while allowing new/different calls in the same turn to execute.
    // If ALL calls are repeated, inject a system message and re-prompt.
    if (dedupedToolCalls.length > 0 && doomLoopThreshold >= 2) {
      const currentKeys = dedupedToolCalls.map(toolCallKey);

      doomLoopStreaks = updateStreaks(doomLoopStreaks, currentKeys);

      // Prune per-key intervention counters for keys no longer in the streak
      // map. This resets budgets when a loop is broken and resumed later.
      const currentKeySet = new Set(currentKeys);
      for (const key of doomLoopInterventionsByKey.keys()) {
        if (!currentKeySet.has(key)) {
          doomLoopInterventionsByKey.delete(key);
        }
      }

      const { repeatedKeys, hasRepeated, allRepeated } = partitionDoomLoopKeys(
        doomLoopStreaks,
        currentKeys,
        doomLoopThreshold,
      );

      // Check per-key intervention budgets. A key is blockable if it hasn't
      // exhausted its per-key cap yet.
      const blockableKeys = new Set<string>();
      for (const key of repeatedKeys) {
        const count = doomLoopInterventionsByKey.get(key) ?? 0;
        if (count < maxDoomLoopInterventions) {
          blockableKeys.add(key);
        }
      }

      if (
        hasRepeated &&
        allRepeated &&
        blockableKeys.size > 0 &&
        blockableKeys.size === repeatedKeys.size
      ) {
        // ALL calls are repeated — full intervention: re-prompt the model.
        const blockedToolNames = [
          ...new Set([...repeatedKeys].map((k) => parseDoomLoopKey(k).toolName)),
        ];
        const toolNameList = blockedToolNames.join(", ");

        yield {
          kind: "custom",
          type: "doom_loop_detected",
          data: {
            toolNames: blockedToolNames,
            consecutiveTurns: doomLoopThreshold,
            turnIndex: state.turnIndex,
          },
        };

        // Record the assistant's tool-call intents so the transcript stays
        // paired — every streamed tool_call event has a matching intent.
        appendAssistantTurn(transcript, turnText, validToolCalls);

        // Append per-call synthetic blocked results (including within-turn
        // duplicates) so callId pairing is complete.
        for (const tc of validToolCalls) {
          appendToolResult(transcript, {
            callId: tc.callId,
            toolName: tc.toolName,
            output: `[Doom loop]: Blocked — "${tc.toolName}" called with identical arguments ${doomLoopThreshold} turns in a row.`,
          });
        }

        transcript.push({
          senderId: "system:doom-loop",
          content: [
            {
              kind: "text",
              text: `[Doom loop detected]: You have called ${toolNameList} with the same arguments ${doomLoopThreshold} turns in a row. Stop repeating and try a different approach.`,
            },
          ],
          timestamp: Date.now(),
        });

        for (const key of repeatedKeys) {
          doomLoopInterventionsByKey.set(key, (doomLoopInterventionsByKey.get(key) ?? 0) + 1);
        }

        // Re-prompt the model. Doom loop interventions count against maxTurns
        // so the turn budget remains the ultimate safety valve.
        state = transitionTurn(state, { kind: "model_done", hasToolCalls: false });
        if (state.stopReason === "completed") {
          state = transitionTurn(state, { kind: "stop_blocked" });
        }
        yield { kind: "turn_end", turnIndex: state.turnIndex - 1 };
        continue;
      }

      if (hasRepeated && blockableKeys.size > 0 && blockableKeys.size < currentKeys.length) {
        // Mixed turn (or all-repeated with partial budget exhaustion):
        // filter out blockable repeated calls, let new/exhausted calls execute.
        const blockedNames = [...blockableKeys].map((k) => parseDoomLoopKey(k).toolName);
        for (const key of blockableKeys) {
          doomLoopInterventionsByKey.set(key, (doomLoopInterventionsByKey.get(key) ?? 0) + 1);
        }
        // let justified: mutable — partition into blocked and allowed calls
        const doomLoopBlocked: typeof dedupedToolCalls = [];
        const allowed: typeof dedupedToolCalls = [];
        for (const tc of dedupedToolCalls) {
          const key = toolCallKey(tc);
          if (blockableKeys.has(key)) {
            doomLoopBlocked.push(tc);
          } else {
            allowed.push(tc);
          }
        }
        dedupedToolCalls = allowed;
        // Collect ALL blocked callIds — both deduped and within-turn duplicates
        // of blocked keys — so every emitted tool_call intent gets a synthetic result.
        doomLoopBlockedCalls = [...doomLoopBlocked];
        for (const tc of skippedToolCalls) {
          const key = toolCallKey(tc);
          if (blockableKeys.has(key)) {
            doomLoopBlockedCalls.push(tc);
          }
        }
        yield {
          kind: "custom",
          type: "doom_loop_filtered",
          data: { blockedTools: blockedNames, turnIndex: state.turnIndex },
        };
      }
    } else if (dedupedToolCalls.length === 0 && doomLoopThreshold >= 2) {
      // Text-only turn: clear streaks and per-key intervention budgets so
      // protection remains active for future unrelated loops.
      doomLoopStreaks = new Map();
      doomLoopInterventionsByKey.clear();
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
        const key = toolCallKey(tc);
        const existing = skippedByKey.get(key);
        if (existing !== undefined) {
          existing.push(tc);
        } else {
          skippedByKey.set(key, [tc]);
        }
      }

      // Remove skippedByKey entries for doom-loop-blocked calls so live
      // execution doesn't try to replicate results for them.
      for (const blocked of doomLoopBlockedCalls) {
        skippedByKey.delete(toolCallKey(blocked));
      }

      // Emit synthetic results for doom-loop-blocked calls in their original
      // position (before live execution) to preserve transcript result ordering.
      // This must happen before the try block so partial failures don't orphan them.
      for (const blocked of doomLoopBlockedCalls) {
        const syntheticOutput = `[Doom loop]: This call was blocked because "${blocked.toolName}" was called with identical arguments ${doomLoopThreshold} turns in a row.`;
        appendToolResult(transcript, {
          callId: blocked.callId,
          toolName: blocked.toolName,
          output: syntheticOutput,
        });
      }
      doomLoopBlockedCalls = [];

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
            // Use coerced args when available, fall back to raw parsedArgs
            input:
              coercedArgsMap.get(tc.callId) ?? (tc.parsedArgs as import("@koi/core").JsonObject),
            // Thread callId through the dedicated `callId` field so UI
            // layers (TUI permission bridge / tool-call timer reset) can
            // target a specific invocation. NOT in `metadata` —
            // UI/observability identifiers must not pollute policy
            // queries or approval-cache identity. (#1759 round 6)
            callId: tc.callId as string,
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
          // Emit tool_result so the TUI receives the actual execution output
          // (not the AccumulatedToolCall args that tool_call_end carries).
          yield { kind: "tool_result", callId: tc.callId as ToolCallId, output: response.output };

          // Replicate the real result to skipped duplicates so the model
          // sees the actual output for every callId, not a placeholder.
          const duplicates = skippedByKey.get(toolCallKey(tc));
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
                kind: "tool_result",
                callId: dup.callId as ToolCallId,
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
          // #1754: successful tool execution proves the model recovered.
          // Clear schema-recovery state so unrelated later mistakes
          // still get one recovery attempt. Also clear stale errorMetadata.
          if (schemaValidationRecoveryPending) {
            schemaValidationRecoveryPending = false;
            errorMetadata = undefined;
          }
        }
      } catch (e: unknown) {
        if (state.phase !== "complete") {
          const msg = e instanceof Error ? e.message : String(e);
          // #1742: cancellation must short-circuit before the recovery
          // path. If the run signal is aborted (user pressed Ctrl+C, the
          // host triggered /clear, etc.) OR the thrown error is an
          // AbortError, the user already cancelled — do NOT synthesize
          // tool results and re-prompt the model. That would cost extra
          // provider calls AFTER the user said stop.
          const isAbortError =
            e instanceof Error &&
            (e.name === "AbortError" || (e as { code?: unknown }).code === "ABORT_ERR");
          if (isAborted(signal) || isAbortError) {
            errorMetadata = { source: "tool_execution", message: msg };
            state = transitionTurn(state, { kind: "abort" });
            yield { kind: "turn_end", turnIndex: state.turnIndex };
            break;
          }
          // Non-cancellation throw: a tool or its wrapping middleware (e.g.
          // a security guard) crashed. Previously this transitioned the
          // turn to "error" and killed the agent loop without giving the
          // model a chance to react — the user saw a silent empty turn.
          //
          // Instead, synthesize a tool_result for every tool call in this
          // batch that has not yet produced one and feed it back to the
          // model. Every tool_call intent in the transcript must be paired
          // with a tool_result (or the provider rejects the next request),
          // so include the skipped duplicates too. The model then sees the
          // error in the next turn and can explain it to the user or try
          // a different approach. The "error" state is still recorded via
          // errorMetadata so observability / stop reasons remain accurate.
          //
          // #1742 loop-3 round 7: cap recovery to ONE extra model turn.
          // If a SECOND tool-execution failure happens after we already
          // gave the model a recovery turn, the failure is effectively
          // deterministic (permission denial, policy block, broken
          // tool). Looping again would burn budget and stall the user —
          // fail closed instead.
          if (toolErrorRecoveryUsed) {
            errorMetadata = { source: "tool_execution", message: msg };
            state = transitionTurn(state, {
              kind: "error",
              message: `Tool execution failed again after recovery turn: ${msg}`,
            });
            yield { kind: "turn_end", turnIndex: state.turnIndex };
            break;
          }
          toolErrorRecoveryUsed = true;
          errorMetadata = { source: "tool_execution", message: msg };
          const syntheticOutput = {
            error: `Tool execution failed: ${msg}`,
            code: "TOOL_EXECUTION_ERROR",
          } as const;
          // Pair every emitted tool_call intent (deduped + within-turn
          // duplicates) with an error result, but skip ones that already
          // got a real result before the throw.
          const alreadyResolved = new Set<string>();
          for (const completed of dedupedToolCalls) {
            if (transcriptHasToolResult(transcript, completed.callId)) {
              alreadyResolved.add(completed.callId);
            }
          }
          const allPendingCalls = [
            ...dedupedToolCalls.filter((tc) => !alreadyResolved.has(tc.callId)),
            ...skippedToolCalls.filter(
              (tc) =>
                !alreadyResolved.has(tc.callId) && !transcriptHasToolResult(transcript, tc.callId),
            ),
          ];
          for (const tc of allPendingCalls) {
            appendToolResult(transcript, {
              callId: tc.callId,
              toolName: tc.toolName,
              output: syntheticOutput,
            });
            yield {
              kind: "tool_result",
              callId: tc.callId as ToolCallId,
              output: syntheticOutput,
            };
          }
          // Continue the loop so the model gets a chance to respond to the
          // error. The turn budget still applies via maxTurns above.
          state = transitionTurn(state, { kind: "tools_done" });
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

  // #1754: clear stale schema-validation errorMetadata when the run completed
  // successfully. Recovery metadata is transient — it should not leak into
  // the terminal done event for completed runs.
  if (
    (state.stopReason === "completed" || state.stopReason === undefined) &&
    errorMetadata !== undefined
  ) {
    const source = (errorMetadata as { source?: unknown }).source;
    if (source === "schema_validation") {
      errorMetadata = undefined;
    }
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
      // Transcript records rawArgs (model output) for replay fidelity.
      // Execution uses coercedArgsMap values. When they differ, a
      // "coerced_args" custom event is emitted for observability.
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
 * Check whether a tool result has already been appended to the transcript
 * for the given callId. Used by the tool-execution error recovery path
 * (#1742) to avoid double-appending results when some calls in a batch
 * completed before a later one threw.
 */
function transcriptHasToolResult(transcript: readonly InboundMessage[], callId: string): boolean {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const msg = transcript[i];
    if (msg?.senderId !== "tool") continue;
    const metaCallId = (msg.metadata as { readonly callId?: unknown } | undefined)?.callId;
    if (metaCallId === callId) return true;
  }
  return false;
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
