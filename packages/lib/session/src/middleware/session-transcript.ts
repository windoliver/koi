/**
 * Session transcript middleware — appends model turns to a SessionTranscript.
 *
 * Phase: observe / Priority: 200
 *
 * Uses wrapModelStream + wrapToolCall to record turns durably.
 * Session routing always uses ctx.session.sessionId (live turn) to prevent
 * data-isolation failures when a single middleware instance is shared or when
 * session IDs change between calls.
 *
 * Commit semantics:
 * - User + assistant entries are written together in the wrapModelStream finally
 *   block, only on successful turn completion. This prevents duplicate user
 *   entries when semantic-retry (resolve phase) rewrites the request and calls
 *   next() again — recording once-per-committed-turn, not once-per-attempt.
 * - Tool results are written immediately in wrapToolCall (awaited), closing the
 *   crash window between tool completion and the next model call. If the write
 *   fails, the error is re-thrown so the engine surfaces it rather than silently
 *   risking duplicate execution of a non-idempotent tool on replay.
 *
 * Failure semantics for model-turn writes: transcript errors are logged but do
 * not propagate. If the transcript store is unavailable (disk full, I/O error),
 * the agent continues. Operators should alert on [@koi/session:transcript] errors.
 *
 * This makes @koi/session observable in ATIF trajectories via
 * wrapMiddlewareWithTrace (shows as MW:@koi/session:transcript steps).
 */

import type {
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  ModelStopReason,
  ModelStreamHandler,
  SessionId,
  SessionTranscript,
  ToolRequest,
  ToolResponse,
  TranscriptEntry,
  TurnContext,
} from "@koi/core";
import { transcriptEntryId } from "@koi/core";
import { extractMessage } from "@koi/errors";

export interface SessionTranscriptMiddlewareConfig {
  /** The transcript store to append entries to. */
  readonly transcript: SessionTranscript;
  /**
   * Session ID used for entry ID generation (uniqueness prefix).
   * Routing always uses ctx.session.sessionId — this field does NOT control
   * which session the entries are written to.
   */
  readonly sessionId: SessionId;
}

/**
 * Creates an observe-phase middleware that records model turns to a session transcript.
 * Wire into the middleware chain via createKoi() or the recording script's extraMiddleware.
 */
export function createSessionTranscriptMiddleware(
  config: SessionTranscriptMiddlewareConfig,
): KoiMiddleware {
  const { transcript, sessionId: idPrefix } = config;

  return {
    name: "@koi/session:transcript",
    phase: "observe",
    priority: 200,
    describeCapabilities: () => undefined,

    wrapModelStream: (
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> => {
      // Always derive the routing key from the live turn context — never from
      // config.sessionId — to prevent data-isolation failures when a single
      // middleware instance is reused across multiple sessions.
      const sid: SessionId = ctx.session.sessionId;
      const inner = next(request);

      // Wrap stream: accumulate text_delta and tool_call_* chunks, capture
      // the done chunk, then append transcript entries only on successful
      // completion. Aborted/errored streams and retry attempts (semantic-retry
      // rewrites the request and calls next() again) are not recorded to avoid
      // replaying truncated or retry-internal turns during crash recovery.
      return (async function* (): AsyncIterable<ModelChunk> {
        const textParts: string[] = [];
        // Map preserves insertion order — use as ordered tool-call accumulator
        const toolCallArgs = new Map<string, { toolName: string; args: string }>();
        // let — set when the stream signals successful completion via "done" chunk
        let doneResponse: ModelResponse | undefined;

        try {
          for await (const chunk of inner) {
            if (chunk.kind === "text_delta") {
              textParts.push(chunk.delta);
            } else if (chunk.kind === "tool_call_start") {
              toolCallArgs.set(String(chunk.callId), { toolName: chunk.toolName, args: "" });
            } else if (chunk.kind === "tool_call_delta") {
              const prev = toolCallArgs.get(String(chunk.callId));
              if (prev !== undefined) {
                toolCallArgs.set(String(chunk.callId), {
                  toolName: prev.toolName,
                  args: prev.args + chunk.delta,
                });
              }
            } else if (chunk.kind === "done") {
              doneResponse = chunk.response;
            }
            yield chunk;
          }
        } finally {
          // Only persist on successful completion:
          // - doneResponse undefined → stream aborted/errored before done
          // - stopReason "error"/"hook_blocked" → engine will retry/reject this turn
          // - stopReason absent → legacy adapter (treat as success)
          const successReasons = new Set<ModelStopReason | undefined>([
            undefined,
            "stop",
            "length",
            "tool_use",
          ]);
          if (doneResponse !== undefined && successReasons.has(doneResponse.stopReason)) {
            const toAppend: TranscriptEntry[] = [];

            // Persist the inbound user/system message on commit (not before the
            // stream starts) so that retry-rewritten requests from semantic-retry do
            // not produce duplicate or synthetic user entries in the transcript.
            //
            // Skip senderId === "tool": wrapToolCall already wrote a tool_result entry
            // immediately after execution. Re-writing it here would produce duplicates
            // that break one-to-one tool_call/result reconstruction on replay.
            const lastMsg = request.messages.at(-1);
            if (lastMsg !== undefined && lastMsg.senderId !== "tool") {
              const content = lastMsg.content
                .map((c) => (c.kind === "text" ? c.text : JSON.stringify(c)))
                .join("\n");
              if (content.length > 0) {
                const role: TranscriptEntry["role"] =
                  lastMsg.senderId === "system"
                    ? "system"
                    : lastMsg.senderId === "assistant"
                      ? "assistant"
                      : "user";
                toAppend.push({
                  id: transcriptEntryId(`${String(idPrefix)}-u-${ctx.turnIndex}-${Date.now()}`),
                  role,
                  content,
                  timestamp: lastMsg.timestamp,
                });
              }
            }

            // Prefer accumulated text_delta parts; fall back to done.response.content
            // for adapters that emit a complete response only in the done chunk.
            const textContent = textParts.length > 0 ? textParts.join("") : doneResponse.content;
            if (textContent.length > 0) {
              toAppend.push({
                id: transcriptEntryId(`${String(idPrefix)}-a-${ctx.turnIndex}-${Date.now()}`),
                role: "assistant",
                content: textContent,
                timestamp: Date.now(),
              });
            }

            if (toolCallArgs.size > 0) {
              const calls = [...toolCallArgs.entries()].map(([id, call]) => ({
                id,
                toolName: call.toolName,
                args: call.args,
              }));
              toAppend.push({
                id: transcriptEntryId(`${String(idPrefix)}-tc-${ctx.turnIndex}-${Date.now()}`),
                role: "tool_call",
                content: JSON.stringify(calls),
                timestamp: Date.now(),
              });
            }

            if (toAppend.length > 0) {
              // Await the write so the turn is durable before the generator completes.
              // The stream is already exhausted here — this is the commit boundary.
              try {
                const appendResult = await transcript.append(sid, toAppend);
                if (!appendResult.ok) {
                  console.error(
                    `[@koi/session:transcript] failed to append turn entries for session ${String(sid)}:`,
                    appendResult.error.message,
                  );
                }
              } catch (e: unknown) {
                console.error(
                  `[@koi/session:transcript] failed to append turn entries for session ${String(sid)}:`,
                  extractMessage(e),
                );
              }
            }
          }
        }
      })();
    },

    // Persist tool results immediately after the tool executes — closes the crash
    // window between tool completion and the next model call that would otherwise
    // be the first opportunity to record the result. Without this, a crash after
    // a non-idempotent tool runs but before the next model request causes the
    // recovery path to lose the result and potentially re-issue the tool call.
    //
    // Failure semantics: if the transcript write fails, the error is re-thrown.
    // The tool already ran, so silently continuing would risk re-execution on
    // crash recovery. Surfacing the error lets the engine handle it explicitly.
    wrapToolCall: async (
      ctx: TurnContext,
      request: ToolRequest,
      next: (request: ToolRequest) => Promise<ToolResponse>,
    ): Promise<ToolResponse> => {
      const sid: SessionId = ctx.session.sessionId;
      const response = await next(request);
      const entry: TranscriptEntry = {
        id: transcriptEntryId(`${String(idPrefix)}-tr-${ctx.turnIndex}-${Date.now()}`),
        role: "tool_result",
        content: JSON.stringify({ toolId: request.toolId, output: response.output }),
        timestamp: Date.now(),
      };
      let appendError: unknown;
      try {
        const appendResult = await transcript.append(sid, [entry]);
        if (!appendResult.ok) {
          appendError = appendResult.error;
        }
      } catch (e: unknown) {
        appendError = e;
      }
      if (appendError !== undefined) {
        throw new Error(
          `[@koi/session:transcript] tool_result for "${request.toolId}" not persisted in session ${String(sid)} — ` +
            `crashing turn to prevent duplicate tool execution on replay. Cause: ${extractMessage(appendError)}`,
          { cause: appendError },
        );
      }
      return response;
    },
  };
}
