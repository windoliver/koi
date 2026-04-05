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
      // Append last user message synchronously before the stream starts
      const lastMsg = request.messages.at(-1);
      if (lastMsg !== undefined) {
        const text = lastMsg.content
          .filter((c): c is { readonly kind: "text"; readonly text: string } => c.kind === "text")
          .map((c) => c.text)
          .join("\n");
        if (text.length > 0) {
          const entry: TranscriptEntry = {
            id: transcriptEntryId(`${String(sessionId)}-u-${ctx.turnIndex}-${Date.now()}`),
            role: "user",
            content: text,
            timestamp: lastMsg.timestamp,
          };
          void Promise.resolve(transcript.append(sessionId, [entry])).catch(() => {});
        }
      }

      const inner = next(request);

      // Wrap stream: accumulate text_delta chunks, append assistant entry on completion
      return (async function* (): AsyncIterable<ModelChunk> {
        const parts: string[] = [];
        try {
          for await (const chunk of inner) {
            if (chunk.kind === "text_delta") parts.push(chunk.delta);
            yield chunk;
          }
        } finally {
          const content = parts.join("");
          if (content.length > 0) {
            const entry: TranscriptEntry = {
              id: transcriptEntryId(`${String(sessionId)}-a-${ctx.turnIndex}-${Date.now()}`),
              role: "assistant",
              content,
              timestamp: Date.now(),
            };
            void Promise.resolve(transcript.append(sessionId, [entry])).catch(() => {});
          }
        }
      })();
    },
  };
}
