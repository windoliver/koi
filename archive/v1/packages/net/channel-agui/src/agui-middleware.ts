/**
 * AG-UI stream middleware.
 *
 * Intercepts model streams and tool calls and emits AG-UI SSE events to the
 * per-run SSE stream registered in the RunContextStore.
 *
 * wrapModelStream:
 *   - Intercepts ModelChunk stream from the engine adapter.
 *   - STEP_STARTED emitted before the first chunk; STEP_FINISHED after the last.
 *   - text_delta     → TEXT_MESSAGE_START (once) + TEXT_MESSAGE_CONTENT (per chunk)
 *                    + TEXT_MESSAGE_END (on first non-text chunk or stream end)
 *   - tool_call_start → TOOL_CALL_START
 *   - tool_call_delta → TOOL_CALL_ARGS
 *   - tool_call_end  → TOOL_CALL_END
 *   - thinking_delta → emitted as REASONING_MESSAGE_CONTENT (modern AG-UI)
 *   - Early-exit if the writer is gone (client disconnected) to avoid wasting
 *     model API tokens.
 *
 * wrapToolCall:
 *   - Intercepts tool calls and emits TOOL_CALL_RESULT.
 */

import type { BaseEvent } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import type {
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelStreamHandler,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import type { RunContextStore, SseWriter } from "./run-context-store.js";

// Reuse encoder — stateless for SSE (acceptsProtobuf = false).
const SSE_ENCODER = new EventEncoder();
const TEXT_ENCODER = new TextEncoder();

function encodeEvent(event: BaseEvent): Uint8Array {
  return TEXT_ENCODER.encode(SSE_ENCODER.encodeSSE(event));
}

/** Write event to SSE stream, swallowing close errors (client disconnect). */
async function writeEvent(writer: SseWriter, event: BaseEvent): Promise<void> {
  try {
    await writer.write(encodeEvent(event));
  } catch {
    // Client disconnected or stream already closed.
  }
}

export interface AguiStreamMiddlewareConfig {
  /** The RunContextStore created by createAguiChannel(). */
  readonly store: RunContextStore;
}

export function createAguiStreamMiddleware(config: AguiStreamMiddlewareConfig): KoiMiddleware {
  const { store } = config;

  return {
    name: "@koi/agui/stream",
    describeCapabilities: () => ({
      label: "agui",
      description:
        "AG-UI SSE bridge: emits stream events (text, reasoning, tool calls) and tool call results",
    }),
    priority: 200, // Run after outer governance/pay middleware, before context hydration

    wrapModelStream: async function* (
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      // Prefer the AG-UI runId carried in the first inbound message's metadata.
      // The store was registered with the client-provided RunAgentInput.runId, which
      // differs from the Koi-internal session runId assigned by createKoi.
      // Fall back to the session runId for non-AG-UI callers.
      // Last resort: if exactly 1 run is active, use that writer (covers koi serve
      // where dispatch uses { kind: "text" } which strips AG-UI metadata).
      // Resolve the AG-UI runId for this stream. Try in order:
      // 1. AG-UI runId from inbound message metadata (ideal path)
      // 2. Koi session runId (non-AG-UI callers)
      // 3. Single active run fallback (koi serve dispatch via { kind: "text" })
      const aguiRunId = ctx.messages[0]?.metadata?.runId;
      const runId =
        typeof aguiRunId === "string" && store.get(aguiRunId) !== undefined
          ? aguiRunId
          : store.get(ctx.session.runId) !== undefined
            ? ctx.session.runId
            : undefined;
      const writer =
        (runId !== undefined ? store.get(runId) : undefined) ?? store.getSingleActiveWriter();

      // If no writer is registered for this run, this middleware is a no-op
      // (e.g., the agent was triggered via a non-HTTP channel).
      if (writer === undefined) {
        yield* next(request);
        return;
      }

      // Use the AG-UI runId for message IDs (or fallback to session runId)
      const effectiveRunId = runId ?? ctx.session.runId;

      await writeEvent(writer, { type: EventType.STEP_STARTED, stepName: "agent" });

      // let requires justification: tracks open text/reasoning message IDs for
      // the START event emit-once pattern
      let textMessageId: string | undefined;
      let reasoningMessageId: string | undefined;
      // let requires justification: guards against double-emit of STEP_FINISHED when
      // the stream ends with a "done" chunk (normal path) vs. without one (guard path)
      let stepFinished = false;

      store.markTextStreamed(effectiveRunId);

      for await (const chunk of next(request)) {
        // Early exit: writer is gone (client disconnected mid-stream).
        // Yielding the remaining chunks would still produce them for the engine,
        // but we stop emitting to SSE to avoid wasting model API budget.
        const currentWriter = store.get(effectiveRunId);
        if (currentWriter === undefined) {
          // Drain the stream without writing SSE events.
          yield chunk;
          continue;
        }

        switch (chunk.kind) {
          case "text_delta": {
            if (textMessageId === undefined) {
              textMessageId = `${effectiveRunId}-text`;
              await writeEvent(currentWriter, {
                type: EventType.TEXT_MESSAGE_START,
                messageId: textMessageId,
                role: "assistant",
              });
            }
            await writeEvent(currentWriter, {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: textMessageId,
              delta: chunk.delta,
            });
            break;
          }

          case "thinking_delta": {
            if (reasoningMessageId === undefined) {
              reasoningMessageId = `${effectiveRunId}-reasoning`;
              await writeEvent(currentWriter, {
                type: EventType.REASONING_MESSAGE_START,
                messageId: reasoningMessageId,
              });
            }
            await writeEvent(currentWriter, {
              type: EventType.REASONING_MESSAGE_CONTENT,
              messageId: reasoningMessageId,
              delta: chunk.delta,
            });
            break;
          }

          case "tool_call_start": {
            // Close open text message if transitioning to a tool call.
            if (textMessageId !== undefined) {
              await writeEvent(currentWriter, {
                type: EventType.TEXT_MESSAGE_END,
                messageId: textMessageId,
              });
              textMessageId = undefined;
            }
            await writeEvent(currentWriter, {
              type: EventType.TOOL_CALL_START,
              toolCallId: chunk.callId,
              toolCallName: chunk.toolName,
            });
            break;
          }

          case "tool_call_delta": {
            await writeEvent(currentWriter, {
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: chunk.callId,
              delta: chunk.delta,
            });
            break;
          }

          case "tool_call_end": {
            await writeEvent(currentWriter, {
              type: EventType.TOOL_CALL_END,
              toolCallId: chunk.callId,
            });
            break;
          }

          case "done": {
            // Close any open streaming messages.
            if (textMessageId !== undefined) {
              await writeEvent(currentWriter, {
                type: EventType.TEXT_MESSAGE_END,
                messageId: textMessageId,
              });
              textMessageId = undefined;
            }
            if (reasoningMessageId !== undefined) {
              await writeEvent(currentWriter, {
                type: EventType.REASONING_MESSAGE_END,
                messageId: reasoningMessageId,
              });
              reasoningMessageId = undefined;
            }
            // Emit STEP_FINISHED here — before yield suspends execution.
            // The post-loop guard runs after the consumer drains the generator,
            // by which point the store entry may already be deregistered.
            await writeEvent(currentWriter, {
              type: EventType.STEP_FINISHED,
              stepName: "agent",
            });
            stepFinished = true;
            break;
          }

          case "usage": {
            // Usage metadata — no AG-UI event, pass through silently.
            break;
          }
        }

        yield chunk;
      }

      // Guard: close any still-open text/reasoning messages if the stream ended
      // without a "done" chunk (e.g., truncated or error path).
      // STEP_FINISHED was already emitted inside "done" on the normal path.
      const finalWriter = store.get(effectiveRunId);
      if (finalWriter !== undefined) {
        if (textMessageId !== undefined) {
          await writeEvent(finalWriter, {
            type: EventType.TEXT_MESSAGE_END,
            messageId: textMessageId,
          });
        }
        if (reasoningMessageId !== undefined) {
          await writeEvent(finalWriter, {
            type: EventType.REASONING_MESSAGE_END,
            messageId: reasoningMessageId,
          });
        }
        if (!stepFinished) {
          await writeEvent(finalWriter, { type: EventType.STEP_FINISHED, stepName: "agent" });
        }
      }
    },

    wrapToolCall: async (
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> => {
      const aguiRunId = ctx.messages[0]?.metadata?.runId;
      const writer =
        (typeof aguiRunId === "string" ? store.get(aguiRunId) : undefined) ??
        store.get(ctx.session.runId) ??
        store.getSingleActiveWriter();

      const response = await next(request);

      if (writer !== undefined) {
        await writeEvent(writer, {
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: request.toolId,
          result: JSON.stringify(response.output),
        });
      }

      return response;
    },
  };
}
