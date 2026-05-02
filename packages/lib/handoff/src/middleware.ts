/**
 * HandoffMiddleware — injects handoff context into the first model call
 * for the receiving agent and attaches metadata on every turn.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  TurnContext,
} from "@koi/core";
import { generateHandoffSummary } from "./summary.js";
import type { HandoffMiddlewareConfig } from "./types.js";

export function createHandoffMiddleware(config: HandoffMiddlewareConfig): KoiMiddleware {
  // let justified: tracks the envelope ID currently injected so a fresh
  // handoff for the same agent re-arms injection.
  let injectedEnvelopeId: string | undefined;

  return {
    name: "koi:handoff",
    priority: 400,

    onBeforeTurn: async (ctx: TurnContext): Promise<void> => {
      const result = await config.store.findPendingForAgent(config.agentId);
      if (!result.ok) return;
      const envelope = result.value;
      if (envelope === undefined) return;

      const meta = ctx.metadata as Record<string, unknown>;
      meta.handoffId = envelope.id;
      meta.handoffPhase = envelope.phase.next;
    },

    wrapModelCall: async (
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> => {
      const result = await config.store.findPendingForAgent(config.agentId);
      if (!result.ok) return next(request);
      const envelope = result.value;
      if (envelope === undefined) return next(request);

      if (injectedEnvelopeId === envelope.id) return next(request);

      injectedEnvelopeId = envelope.id;
      await config.store.transition(envelope.id, envelope.status, "injected");
      config.onEvent?.({ kind: "handoff:injected", handoffId: envelope.id });

      const summary = generateHandoffSummary(envelope);
      return next(prependSystemMessage(request, summary));
    },

    wrapModelStream: async function* (
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
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
      if (injectedEnvelopeId === envelope.id) {
        yield* next(request);
        return;
      }

      injectedEnvelopeId = envelope.id;
      await config.store.transition(envelope.id, envelope.status, "injected");
      config.onEvent?.({ kind: "handoff:injected", handoffId: envelope.id });

      const summary = generateHandoffSummary(envelope);
      yield* next(prependSystemMessage(request, summary));
    },

    describeCapabilities: (_ctx: TurnContext): CapabilityFragment | undefined => {
      // describeCapabilities is sync — only report when the store can answer
      // synchronously (in-memory). Persistent backends return Promises and
      // skip the capability fragment for this turn.
      const result = config.store.findPendingForAgent(config.agentId);
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
