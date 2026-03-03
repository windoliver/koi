/**
 * HandoffMiddleware — injects handoff context into the first model call
 * and attaches metadata on every turn.
 */

import type {
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelStreamHandler,
  TurnContext,
} from "@koi/core";
import { generateHandoffSummary } from "./summary.js";
import type { HandoffMiddlewareConfig } from "./types.js";

/**
 * Creates middleware that:
 * 1. Injects handoffId + handoffPhase into turn metadata (every turn)
 * 2. Prepends a summary system message on the first model call (once)
 * 3. Transitions envelope status from pending -> injected
 */
export function createHandoffMiddleware(config: HandoffMiddlewareConfig): KoiMiddleware {
  // let justified: mutable closure flag for first-turn detection (Decision #7)
  let injected = false;

  return {
    name: "koi:handoff",
    priority: 400,

    onBeforeTurn: async (ctx: TurnContext): Promise<void> => {
      const result = await config.store.findPendingForAgent(config.agentId);
      if (!result.ok) return;
      const envelope = result.value;
      if (envelope === undefined) return;

      // Inject metadata for programmatic access
      const meta = ctx.metadata as Record<string, unknown>;
      meta.handoffId = envelope.id;
      meta.handoffPhase = envelope.phase.next;
    },

    wrapModelCall: async (_ctx: TurnContext, request: ModelRequest, next: ModelHandler) => {
      if (injected) return next(request);

      const result = await config.store.findPendingForAgent(config.agentId);
      if (!result.ok) return next(request);
      const envelope = result.value;
      if (envelope === undefined) return next(request);

      // First model call: inject summary
      injected = true;
      await config.store.transition(envelope.id, envelope.status, "injected");

      config.onEvent?.({ kind: "handoff:injected", handoffId: envelope.id });

      const summary = generateHandoffSummary(envelope);
      const augmented = prependSystemMessage(request, summary);
      return next(augmented);
    },

    wrapModelStream: async function* (
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      if (injected) {
        yield* next(request);
        return;
      }

      const result = await config.store.findPendingForAgent(config.agentId);
      if (!result.ok) {
        yield* next(request);
        return;
      }
      const envelope = result.value;
      if (envelope === undefined) {
        yield* next(request);
        return;
      }

      // First model call: inject summary (streaming path)
      injected = true;
      await config.store.transition(envelope.id, envelope.status, "injected");

      config.onEvent?.({ kind: "handoff:injected", handoffId: envelope.id });

      const summary = generateHandoffSummary(envelope);
      const augmented = prependSystemMessage(request, summary);
      yield* next(augmented);
    },

    describeCapabilities: (_ctx: TurnContext) => {
      // describeCapabilities is sync — use synchronous findPendingForAgent
      // In-memory store returns Result synchronously; persistent backends
      // should pre-cache pending state for this hook.
      const result = config.store.findPendingForAgent(config.agentId);
      // If it's a Promise, we can't await in sync context — return undefined
      if (result instanceof Promise) return undefined;
      if (!result.ok) return undefined;
      const envelope = result.value;
      if (envelope === undefined) return undefined;

      return {
        label: "handoff",
        description:
          `Handoff from ${envelope.from}: "${envelope.phase.next}". ` +
          `Use accept_handoff tool with id="${envelope.id}" to get full context.`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Prepend a system message to the model request's messages. */
function prependSystemMessage(request: ModelRequest, content: string): ModelRequest {
  const systemMessage = {
    senderId: "system",
    timestamp: Date.now(),
    content: [{ kind: "text" as const, text: content }],
  };

  return {
    ...request,
    messages: [systemMessage, ...request.messages],
  };
}
