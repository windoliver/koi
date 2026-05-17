/**
 * Shared transcript-backed EngineAdapter factory.
 *
 * Used by both `koi start` (CLI REPL) and `koi tui` (TUI) to wrap a ModelAdapter
 * in an EngineAdapter that drives the model→tool→model loop via runTurn.
 *
 * Design decisions:
 *   - The transcript array is owned by the caller (mutable, splice to reset).
 *   - Commits user + assistant messages only on stopReason === "completed" so
 *     failed or interrupted turns leave no orphaned messages in the transcript.
 *   - callHandlers guard throws explicitly — createKoi always injects them; a
 *     missing handlers object means the adapter was called outside createKoi.
 *   - When budgetConfig is supplied, enforceBudget replaces the naive message-count
 *     slice with token-aware compaction (micro = truncate, full = optimal-split
 *     truncate). The transcript is spliced in-place so future turns see the
 *     compacted history.
 */

import type { BudgetConfig } from "@koi/context-manager";
import { budgetConfigFromResolved, enforceBudget, resolveConfig } from "@koi/context-manager";
import type {
  EngineAdapter,
  EngineEvent,
  EngineInput,
  InboundMessage,
  ModelAdapter,
} from "@koi/core";
import { runTurn } from "@koi/query-engine";
import { explainNonCompletedStop } from "./engine-stop-explanation.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TranscriptAdapterConfig {
  /** Unique identifier for this adapter instance (e.g., "koi-cli", "koi-tui"). */
  readonly engineId: string;
  /** Model HTTP adapter — its complete/stream terminals are exposed to middleware. */
  readonly modelAdapter: ModelAdapter;
  /**
   * Mutable conversation transcript array — owned by the caller.
   * Caller resets it via `transcript.splice(0)` on session clear.
   * Do NOT replace the array reference; splice in place so the adapter
   * always reads from the same object the caller controls.
   */
  readonly transcript: InboundMessage[];
  /**
   * Fallback: maximum messages to include in each context window (tail-sliced).
   * Only used when budgetConfig is not set.
   */
  readonly maxTranscriptMessages: number;
  /** Maximum model→tool→model turns per user submit. */
  readonly maxTurns: number;
  /**
   * Token-aware budget configuration. When set, enforceBudget() replaces the
   * naive maxTranscriptMessages slice. Compaction fires at softTriggerFraction
   * (micro: truncate) and hardTriggerFraction (full: optimal-split truncate).
   * Set contextWindowSize or modelId so the registry can calibrate thresholds.
   */
  readonly budgetConfig?: BudgetConfig | (() => BudgetConfig);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a transcript-backed EngineAdapter.
 *
 * Drives the model→tool→model agent loop via `runTurn` from `@koi/query-engine`.
 * The returned adapter wraps `modelAdapter` terminals so middleware (event-trace,
 * hooks, permissions) can intercept model and tool calls.
 */
export function createTranscriptAdapter(config: TranscriptAdapterConfig): EngineAdapter {
  const { engineId, modelAdapter, transcript, maxTranscriptMessages, maxTurns, budgetConfig } =
    config;
  const threadedTranscripts = new Map<string, InboundMessage[]>();

  function resolveTranscript(input: EngineInput): {
    readonly transcript: InboundMessage[];
    readonly threadId: string | undefined;
  } {
    if (input.kind !== "messages") return { transcript, threadId: undefined };
    const threadId = input.messages.find((msg) => msg.threadId !== undefined)?.threadId;
    if (threadId === undefined || threadId.length === 0) return { transcript, threadId: undefined };
    let scoped = threadedTranscripts.get(threadId);
    if (scoped === undefined) {
      scoped = [];
      threadedTranscripts.set(threadId, scoped);
    }
    return { transcript: scoped, threadId };
  }

  // Adapter-instance state for cancel-resume (issue #1683): the in-flight
  // user message of the currently-streaming turn. Committed to transcript
  // on successful turn_end/done; cleared when the stream completes. If a
  // cancel terminal fires while this is set, saveState captures it so the
  // resume can re-inject the canceled prompt instead of silently dropping
  // it. let: justified — assigned per stream call and read by saveState
  // from outside the generator function.
  let inFlightUserRef: InboundMessage | undefined;

  return {
    engineId,
    capabilities: { text: true, images: false, files: false, audio: false },
    terminals: {
      modelCall: modelAdapter.complete,
      modelStream: modelAdapter.stream,
    },
    dispose: async () => {
      await modelAdapter.dispose?.();
    },
    // Cancel-resume hooks (issue #1683). The transcript-backed adapter has
    // no partial-turn state to capture — interrupted turns are discarded
    // entirely and the next stream starts from the committed transcript.
    // The state we persist on cancel is therefore a "transcript cursor": a
    // snapshot of the committed message count + a content fingerprint at
    // cancel time. On resume, `loadState` validates that the live
    // transcript array still matches that cursor; if it does, the cancel
    // checkpoint is consistent with the JSONL replay and the wrapper's
    // engineId-based compatibility gate has done its job. If the live
    // transcript has diverged (e.g. external edit, partial JSONL load),
    // loadState throws so the wrapper signals onPersistError and the host
    // can fall back to transcript-only resume. This makes the
    // sessionPersistence runtime option real (durable cancel-resume row
    // is written) while honestly reflecting what state this adapter can
    // recover. Adapters with richer state (partial-stream cursor,
    // langgraph checkpointer) implement saveState/loadState differently.
    saveState: async () => ({
      engineId,
      data: {
        kind: "transcript-cursor",
        transcriptLen: transcript.length,
        // Last message's timestamp acts as a lightweight fingerprint —
        // catches replace-in-place mutations that preserve length.
        lastMessageTimestamp:
          transcript.length > 0 ? (transcript[transcript.length - 1]?.timestamp ?? 0) : 0,
        // In-flight user message of the canceled turn, when one was
        // staged but not yet committed. Reinjected on resume so the
        // canceled prompt isn't silently dropped.
        ...(inFlightUserRef !== undefined ? { stagedUser: inFlightUserRef } : {}),
      },
    }),
    loadState: async (state) => {
      const data = state.data as
        | {
            readonly kind?: string;
            readonly transcriptLen?: number;
            readonly lastMessageTimestamp?: number;
            readonly stagedUser?: InboundMessage;
          }
        | undefined;
      if (data?.kind !== "transcript-cursor") {
        throw new Error(
          `[${engineId}] EngineState shape mismatch — expected kind="transcript-cursor"`,
        );
      }
      const expectedLen = data.transcriptLen ?? -1;
      if (transcript.length !== expectedLen) {
        throw new Error(
          `[${engineId}] transcript divergence — checkpoint snapshotted ${expectedLen} messages, live transcript has ${transcript.length}`,
        );
      }
      const expectedTs = data.lastMessageTimestamp ?? 0;
      const liveTs =
        transcript.length > 0 ? (transcript[transcript.length - 1]?.timestamp ?? 0) : 0;
      if (liveTs !== expectedTs) {
        throw new Error(
          `[${engineId}] transcript fingerprint mismatch — last message timestamp ${liveTs} ≠ checkpoint ${expectedTs}`,
        );
      }
      // Cursor validated. We deliberately do NOT push `data.stagedUser`
      // into the in-memory transcript here:
      //   1. The JSONL store (the only durable resume source) was not
      //      written when the cancel happened, so a push-here-only would
      //      diverge from JSONL and break repeated cancel-resume cycles
      //      (next saveState would record transcriptLen=committed+1 which
      //      JSONL can never reproduce; loadState would then trip its own
      //      length check and the wrapper would clear the checkpoint).
      //   2. The UI store rehydrates from `resumeResult.value.messages`
      //      independently of the adapter; pushing here would let the
      //      model see a user message the operator can't see.
      // Hosts that want canceled-prompt resubmission must extract
      // `data.stagedUser` from the resumed engine state themselves and
      // route it through the same path they use for new user prompts —
      // appending to JSONL, dispatching UI rehydrate, and feeding the
      // adapter — so all surfaces stay consistent.
    },
    stream(input: EngineInput): AsyncIterable<EngineEvent> {
      const handlers = input.callHandlers;
      if (handlers === undefined) {
        throw new Error(
          `${engineId}: callHandlers required — adapter must be wrapped via createKoi`,
        );
      }

      const active = resolveTranscript(input);
      const activeTranscript = active.transcript;
      const activeThreadId = active.threadId;
      // Stage user message(s) — only committed to transcript after a completed turn.
      // Committing early would leave orphaned user prompts on failure, breaking
      // retry semantics on the next submit.
      const stagedMessages: readonly InboundMessage[] =
        input.kind === "messages"
          ? input.messages
          : [
              {
                senderId: "user",
                timestamp: Date.now(),
                content: [{ kind: "text", text: input.kind === "text" ? input.text : "" }],
              },
            ];
      // Cancel-resume (#1683): expose the in-flight user prompt to
      // saveState for the text-input path (TUI). If the wrapper observes
      // an interrupted terminal before this turn commits, it captures
      // this pointer so the canceled prompt is reinjected on resume.
      // Multi-message inputs (gateway flows) own their own message
      // lifecycle externally and don't participate in this hook.
      if (input.kind === "text" && stagedMessages[0] !== undefined) {
        inFlightUserRef = stagedMessages[0];
      }

      return (async function* (): AsyncIterable<EngineEvent> {
        // Build context window: token-aware compaction when budgetConfig is set,
        // otherwise fall back to naive message-count tail-slice.
        let contextMessages: readonly InboundMessage[];
        if (budgetConfig !== undefined) {
          // Resolve per-turn so mid-session model switches pick up the new
          // model's context window immediately on the next turn, without
          // requiring the adapter to be rebuilt.
          const resolvedBudget = typeof budgetConfig === "function" ? budgetConfig() : budgetConfig;
          const budgetResult = await enforceBudget(
            [...activeTranscript],
            undefined,
            resolvedBudget,
          );
          if (budgetResult.compaction !== "noop") {
            // Splice transcript in-place so future turns see the compacted history.
            activeTranscript.splice(0, activeTranscript.length, ...budgetResult.messages);
          }
          contextMessages = budgetResult.messages;
        } else {
          contextMessages = activeTranscript.slice(-maxTranscriptMessages);
        }
        const contextWindow = [...contextMessages, ...stagedMessages];

        // Accumulate tool history so follow-up turns see the full context
        // (assistant tool_call intents + tool results), not just final text.
        //
        // Architecture note: createKoi breaks on turn_end and restarts the
        // adapter stream for each model→tool→model cycle. The done event
        // from runTurn is never consumed by this adapter. So we commit to
        // the transcript on turn_end, not on done.

        // let: accumulated across streaming chunks (for #1742 silent-termination detection)
        let deltaText = "";
        // let: tool calls accumulated per model turn, flushed on turn_end
        let pendingToolCalls: {
          readonly id: string;
          readonly name: string;
          readonly args: string;
        }[] = [];
        // let: tool results accumulated per model turn, flushed on turn_end
        let pendingToolResults: InboundMessage[] = [];
        // let: text accumulated per model turn, flushed on turn_end
        let pendingTurnText: string[] = [];
        // let: whether we've committed the user message for this stream call
        let userMessageCommitted = false;

        for await (const event of runTurn({
          callHandlers: handlers,
          messages: contextWindow,
          signal: input.signal,
          maxTurns,
        })) {
          if (event.kind === "text_delta") {
            deltaText += event.delta;
            pendingTurnText.push(event.delta);
          }
          if (event.kind === "tool_call_start") {
            pendingToolCalls.push({
              id: event.callId as string,
              name: event.toolName,
              args: "",
            });
          }
          if (event.kind === "tool_call_delta") {
            const tc = pendingToolCalls.find((c) => c.id === (event.callId as string));
            if (tc !== undefined) {
              const idx = pendingToolCalls.indexOf(tc);
              pendingToolCalls[idx] = { ...tc, args: tc.args + event.delta };
            }
          }
          if (event.kind === "tool_result") {
            pendingToolResults.push({
              senderId: "tool",
              ...(activeThreadId !== undefined ? { threadId: activeThreadId } : {}),
              timestamp: Date.now(),
              content: [
                {
                  kind: "text",
                  text: JSON.stringify({
                    callId: event.callId,
                    output: event.output,
                  }),
                },
              ],
              metadata: { callId: event.callId as string },
            });
          }
          if (event.kind === "turn_end") {
            // Commit user message once (first turn_end in this stream call).
            if (!userMessageCommitted) {
              activeTranscript.push(...stagedMessages);
              userMessageCommitted = true;
              // Cancel-resume: prompt is now in transcript, so saveState
              // no longer needs to capture it as the in-flight staged user.
              inFlightUserRef = undefined;
            }

            // Flush assistant message with tool_call metadata (if any).
            // Only commit tool calls that have matching results — dangling
            // calls from interrupted turns would poison the transcript and
            // cause provider rejection on the next turn.
            const turnText = pendingTurnText.join("");
            const pairedCallIds = new Set(
              pendingToolResults.map((r) => (r.metadata as { callId: string }).callId),
            );
            const pairedCalls = pendingToolCalls.filter((tc) => pairedCallIds.has(tc.id));
            if (pairedCalls.length > 0) {
              activeTranscript.push({
                senderId: "assistant",
                ...(activeThreadId !== undefined ? { threadId: activeThreadId } : {}),
                timestamp: Date.now(),
                content: turnText.length > 0 ? [{ kind: "text", text: turnText }] : [],
                metadata: {
                  toolCalls: pairedCalls.map((tc) => ({
                    id: tc.id,
                    type: "function" as const,
                    function: { name: tc.name, arguments: tc.args },
                  })),
                },
              });
              for (const msg of pendingToolResults) {
                activeTranscript.push(msg);
              }
            } else if (turnText.length > 0) {
              activeTranscript.push({
                senderId: "assistant",
                ...(activeThreadId !== undefined ? { threadId: activeThreadId } : {}),
                timestamp: Date.now(),
                content: [{ kind: "text", text: turnText }],
              });
            }

            pendingToolCalls = [];
            pendingToolResults = [];
            pendingTurnText = [];
          }
          // #1742: synthetic explanation for silent terminations.
          // Also: fallback transcript commit for streams that emit done
          // without turn_end (e.g. createKoi breaks on turn_end and
          // restarts the adapter, so the terminal done from runTurn is
          // sometimes consumed here instead of being swallowed).
          if (event.kind === "done") {
            const stopReason = event.output.stopReason;
            if (stopReason === "completed" && !userMessageCommitted) {
              // Fallback: turn_end never fired — commit from done event.
              activeTranscript.push(...stagedMessages);
              userMessageCommitted = true;
              inFlightUserRef = undefined;
              const fallbackText = pendingTurnText.join("");
              if (fallbackText.length > 0) {
                activeTranscript.push({
                  senderId: "assistant",
                  ...(activeThreadId !== undefined ? { threadId: activeThreadId } : {}),
                  timestamp: Date.now(),
                  content: [{ kind: "text", text: fallbackText }],
                });
              } else {
                const fullContent = event.output.content;
                if (fullContent.length > 0) {
                  activeTranscript.push({
                    senderId: "assistant",
                    ...(activeThreadId !== undefined ? { threadId: activeThreadId } : {}),
                    timestamp: Date.now(),
                    content: fullContent,
                  });
                } else if (deltaText.length > 0) {
                  activeTranscript.push({
                    senderId: "assistant",
                    ...(activeThreadId !== undefined ? { threadId: activeThreadId } : {}),
                    timestamp: Date.now(),
                    content: [{ kind: "text", text: deltaText }],
                  });
                }
              }
            }
            if (stopReason !== "completed" && deltaText.length === 0) {
              const synthetic = explainNonCompletedStop(stopReason, event.output.metadata);
              yield { kind: "text_delta", delta: synthetic };
            }
          }
          yield event;
        }
      })();
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip the provider prefix from a model name.
 * "anthropic:claude-opus-4-6" → "claude-opus-4-6"
 * "claude-opus-4-6" → "claude-opus-4-6"
 */
export function bareModelId(modelName: string): string {
  const colonIdx = modelName.indexOf(":");
  return colonIdx >= 0 ? modelName.slice(colonIdx + 1) : modelName;
}

/**
 * Build a fully-resolved BudgetConfig for a given model name.
 *
 * Calls resolveConfig({ modelId }) so the context window size is looked up
 * from @koi/model-registry (e.g. claude-opus-4-6 → 1_000_000, gpt-4o → 128_000).
 * Falls back to COMPACTION_DEFAULTS.contextWindowSize (200_000) for unknown models.
 *
 * Use this instead of passing { modelId } directly to enforceBudget — the raw
 * modelId field in BudgetConfig is only used for token estimation, not window resolution.
 *
 * @param contextWindowOverride - Override the resolved window size (e.g. for testing
 *   compaction with a tiny window without changing the real model config).
 */
export function budgetConfigForModel(
  modelName: string,
  contextWindowOverride?: number,
): BudgetConfig {
  const modelId = bareModelId(modelName);
  const result = resolveConfig({ modelId });
  // resolveConfig only fails on invalid fraction values — model registry lookup
  // never produces invalid fractions, so this path is unreachable in practice.
  if (!result.ok) {
    return {
      modelId,
      ...(contextWindowOverride !== undefined ? { contextWindowSize: contextWindowOverride } : {}),
    };
  }
  const resolved = budgetConfigFromResolved(result.value);
  if (contextWindowOverride !== undefined) {
    return { ...resolved, contextWindowSize: contextWindowOverride };
  }
  return resolved;
}
