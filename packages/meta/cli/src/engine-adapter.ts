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
  readonly budgetConfig?: BudgetConfig;
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

  return {
    engineId,
    capabilities: { text: true, images: false, files: false, audio: false },
    terminals: {
      modelCall: modelAdapter.complete,
      modelStream: modelAdapter.stream,
    },
    stream(input: EngineInput): AsyncIterable<EngineEvent> {
      const handlers = input.callHandlers;
      if (handlers === undefined) {
        throw new Error(
          `${engineId}: callHandlers required — adapter must be wrapped via createKoi`,
        );
      }

      const text = input.kind === "text" ? input.text : "";
      // Stage user message — only committed to transcript after a completed turn.
      // Committing early would leave orphaned user prompts on failure, breaking
      // retry semantics on the next submit.
      const stagedUserMsg: InboundMessage = {
        senderId: "user",
        timestamp: Date.now(),
        content: [{ kind: "text", text }],
      };

      return (async function* (): AsyncIterable<EngineEvent> {
        // Build context window: token-aware compaction when budgetConfig is set,
        // otherwise fall back to naive message-count tail-slice.
        let contextMessages: readonly InboundMessage[];
        if (budgetConfig !== undefined) {
          const budgetResult = await enforceBudget([...transcript], undefined, budgetConfig);
          if (budgetResult.compaction !== "noop") {
            // Splice transcript in-place so future turns see the compacted history.
            transcript.splice(0, transcript.length, ...budgetResult.messages);
          }
          contextMessages = budgetResult.messages;
        } else {
          contextMessages = transcript.slice(-maxTranscriptMessages);
        }
        const contextWindow = [...contextMessages, stagedUserMsg];

        // let: accumulated across streaming chunks, read after loop completes
        let deltaText = "";
        // #1742: when the turn terminates with a non-"completed" stop reason
        // (tool error, max_turns, security block, etc.) AND no text reached
        // the user, surface a synthetic explanation so the TUI never shows a
        // silently empty reply. Pending events are queued until we know the
        // terminal stopReason so the synthetic text_delta is injected BEFORE
        // the terminal done event (reducer contract: done closes the active
        // assistant block, so deltas that arrive after are never rendered).
        for await (const event of runTurn({
          callHandlers: handlers,
          messages: contextWindow,
          signal: input.signal,
          maxTurns,
        })) {
          if (event.kind === "text_delta") {
            deltaText += event.delta;
          }
          if (event.kind === "done") {
            const stopReason = event.output.stopReason;
            if (stopReason === "completed") {
              transcript.push(stagedUserMsg);
              // Preserve the full assistant content including tool_call and
              // tool_result blocks so follow-up turns see tool history.
              // Fall back to accumulated deltas only when content is empty.
              const fullContent = event.output.content;
              if (fullContent.length > 0) {
                transcript.push({
                  senderId: "assistant",
                  timestamp: Date.now(),
                  content: fullContent,
                });
              } else if (deltaText.length > 0) {
                transcript.push({
                  senderId: "assistant",
                  timestamp: Date.now(),
                  content: [{ kind: "text", text: deltaText }],
                });
              }
            } else if (deltaText.length === 0) {
              // No assistant text reached the user AND the turn terminated
              // non-completed. Inject a visible explanation before closing.
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
// Synthetic text for silent-termination cases (#1742)
// ---------------------------------------------------------------------------

/**
 * Build a user-visible one-liner for a non-"completed" terminal stop reason.
 *
 * When the agent loop terminates without emitting assistant text — e.g. a tool
 * threw in middleware, max_turns was reached before the model produced a final
 * summary, or an exfiltration/security gate blocked the response — the TUI
 * previously saw a `done` event with no preceding `text_delta` and rendered
 * an empty bubble. Users on the Phase 2 bug bash experienced this as "no
 * reply on the second turn".
 *
 * The message prefers `metadata.source` / `metadata.message` set by the
 * turn-runner when available so users see *why* the turn died, not just a
 * generic "turn failed" string.
 */
function explainNonCompletedStop(stopReason: string, metadata: unknown): string {
  const meta =
    (metadata as { readonly source?: string; readonly message?: string } | undefined) ?? undefined;
  const detail = meta?.message !== undefined ? ` — ${meta.message}` : "";
  const source = meta?.source !== undefined ? ` (${meta.source})` : "";
  switch (stopReason) {
    case "max_turns":
      return `\n[Turn ended: model reached the max-turns budget without producing a final reply${detail}.]\n`;
    case "interrupted":
      return "\n[Turn interrupted before the model produced a reply.]\n";
    case "hook_blocked":
      return `\n[Turn blocked by a security gate${detail}.]\n`;
    case "error":
      return `\n[Turn failed${source}${detail}.]\n`;
    default:
      return `\n[Turn ended without a reply: ${stopReason}${detail}.]\n`;
  }
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
