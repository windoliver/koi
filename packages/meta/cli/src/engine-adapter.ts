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
 */

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
  /** Maximum messages to include in each context window (tail-sliced). */
  readonly maxTranscriptMessages: number;
  /** Maximum model→tool→model turns per user submit. */
  readonly maxTurns: number;
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
  const { engineId, modelAdapter, transcript, maxTranscriptMessages, maxTurns } = config;

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

      const contextWindow = [...transcript.slice(-maxTranscriptMessages), stagedUserMsg];

      return (async function* (): AsyncIterable<EngineEvent> {
        // let: accumulated across streaming chunks, read after loop completes
        let deltaText = "";
        let doneContentText = "";

        for await (const event of runTurn({
          callHandlers: handlers,
          messages: contextWindow,
          signal: input.signal,
          maxTurns,
        })) {
          yield event;
          if (event.kind === "text_delta") {
            deltaText += event.delta;
          }
          if (event.kind === "done") {
            // Prefer authoritative done.output.content over accumulated deltas.
            // Providers may finalize text in done.output.content in addition to
            // (or instead of) emitting text_delta chunks.
            doneContentText = event.output.content
              .filter(
                (b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text",
              )
              .map((b) => b.text)
              .join("");

            // Only persist completed turns — interrupted/errored turns must not
            // corrupt the transcript. Commit user + assistant atomically so a
            // failed turn leaves no orphaned user prompt for the next turn.
            if (event.output.stopReason === "completed") {
              const assistantText = doneContentText.length > 0 ? doneContentText : deltaText;
              transcript.push(stagedUserMsg);
              if (assistantText.length > 0) {
                transcript.push({
                  senderId: "assistant",
                  timestamp: Date.now(),
                  content: [{ kind: "text", text: assistantText }],
                });
              }
            }
          }
        }
      })();
    },
  };
}
