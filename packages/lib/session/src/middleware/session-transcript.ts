/**
 * Session transcript middleware — appends model turns to a SessionTranscript.
 *
 * Phase: observe (pure side-effect, never blocks the request path)
 * Priority: 200 (after event-trace at 100, before business middleware)
 *
 * Uses wrapModelStream to capture both user messages (from the request) and
 * assistant responses (accumulated from stream text_delta chunks).
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
  TranscriptEntry,
  TurnContext,
} from "@koi/core";
import { transcriptEntryId } from "@koi/core";

export interface SessionTranscriptMiddlewareConfig {
  /** The transcript store to append entries to. */
  readonly transcript: SessionTranscript;
  /** The session ID key used for all transcript operations. */
  readonly sessionId: SessionId;
}

/**
 * Creates an observe-phase middleware that records model turns to a session transcript.
 * Wire into the middleware chain via createKoi() or the recording script's extraMiddleware.
 */
export function createSessionTranscriptMiddleware(
  config: SessionTranscriptMiddlewareConfig,
): KoiMiddleware {
  const { transcript, sessionId } = config;

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
      // Serialize all content blocks from the last incoming message:
      // text blocks as plain text, all other block kinds as JSON strings.
      // Map senderId to the correct transcript role so tool results and
      // system messages are not mis-recorded as user messages.
      const lastMsg = request.messages.at(-1);
      if (lastMsg !== undefined) {
        const content = lastMsg.content
          .map((c) => (c.kind === "text" ? c.text : JSON.stringify(c)))
          .join("\n");
        if (content.length > 0) {
          const role: TranscriptEntry["role"] =
            lastMsg.senderId === "tool"
              ? "tool_result"
              : lastMsg.senderId === "system"
                ? "system"
                : lastMsg.senderId === "assistant"
                  ? "assistant"
                  : "user";
          const entry: TranscriptEntry = {
            id: transcriptEntryId(`${String(sessionId)}-u-${ctx.turnIndex}-${Date.now()}`),
            role,
            content,
            timestamp: lastMsg.timestamp,
          };
          void Promise.resolve(transcript.append(sessionId, [entry])).catch((e: unknown) => {
            console.error("[@koi/session:transcript] failed to append user entry:", e);
          });
        }
      }

      const inner = next(request);

      // Wrap stream: accumulate text_delta and tool_call_* chunks, capture
      // the done chunk, then append transcript entries only on successful
      // completion. Aborted/errored streams are not recorded to avoid
      // replaying truncated turns during crash recovery.
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

            // Prefer accumulated text_delta parts; fall back to done.response.content
            // for adapters that emit a complete response only in the done chunk.
            const textContent = textParts.length > 0 ? textParts.join("") : doneResponse.content;
            if (textContent.length > 0) {
              toAppend.push({
                id: transcriptEntryId(`${String(sessionId)}-a-${ctx.turnIndex}-${Date.now()}`),
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
                id: transcriptEntryId(`${String(sessionId)}-tc-${ctx.turnIndex}-${Date.now()}`),
                role: "tool_call",
                content: JSON.stringify(calls),
                timestamp: Date.now(),
              });
            }

            if (toAppend.length > 0) {
              // Await the write so the turn is durable before the generator completes.
              // The stream is already exhausted here — this is the commit boundary.
              try {
                await transcript.append(sessionId, toAppend);
              } catch (e: unknown) {
                console.error("[@koi/session:transcript] failed to append assistant entries:", e);
              }
            }
          }
        }
      })();
    },
  };
}
