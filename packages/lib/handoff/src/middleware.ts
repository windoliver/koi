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

      // Reserve the envelope BEFORE the model call so concurrent turns/
      // processes don't pick the same pending envelope and inject it twice.
      // Reservation is allowed ONLY from `pending` — envelopes already in
      // `injected` are skipped here so a second process can't observe the
      // same envelope after the first injector flipped it. The remaining
      // recovery path is `accept_handoff`, which still works for both
      // pending and injected envelopes. Fail-closed: any non-success result
      // skips injection.
      if (envelope.status !== "pending") {
        return next(request);
      }
      const reserved = await config.store.transition(envelope.id, "pending", "injected");
      if (!reserved.ok) {
        return next(request);
      }

      injectedEnvelopeId = envelope.id;
      const summary = generateHandoffSummary(envelope);
      try {
        const response = await next(prependSystemMessage(request, summary));
        config.onEvent?.({ kind: "handoff:injected", handoffId: envelope.id });
        return response;
      } catch (e: unknown) {
        // Model call failed — release the reservation so the next turn
        // re-injects. We swallow revert errors: the original failure is the
        // signal the caller cares about.
        injectedEnvelopeId = undefined;
        try {
          await config.store.transition(envelope.id, "injected", "pending");
        } catch {
          // best-effort revert
        }
        throw e;
      }
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

      // Same one-way pending → injected reservation as wrapModelCall.
      if (envelope.status !== "pending") {
        yield* next(request);
        return;
      }
      const reserved = await config.store.transition(envelope.id, "pending", "injected");
      if (!reserved.ok) {
        yield* next(request);
        return;
      }

      injectedEnvelopeId = envelope.id;
      const summary = generateHandoffSummary(envelope);
      // let justified: tracks whether the upstream model started producing
      // output. Once the first chunk is yielded the prompt is committed and
      // we MUST keep the envelope reserved — even if the consumer abandons
      // the iterator partway through, otherwise we'd re-inject the same
      // handoff next turn after the model already saw it.
      let delivered = false;
      let producerThrew = false;
      try {
        for await (const chunk of next(prependSystemMessage(request, summary))) {
          delivered = true;
          yield chunk;
        }
      } catch (e: unknown) {
        producerThrew = true;
        throw e;
      } finally {
        if (delivered) {
          // Stream produced data — treat as delivered regardless of how the
          // iterator finished.
          config.onEvent?.({ kind: "handoff:injected", handoffId: envelope.id });
        } else if (producerThrew) {
          // Producer never yielded and errored — release reservation.
          injectedEnvelopeId = undefined;
          try {
            await config.store.transition(envelope.id, "injected", "pending");
          } catch {
            // best-effort revert
          }
        } else {
          // Consumer cancelled before any chunk arrived. Same as no delivery.
          injectedEnvelopeId = undefined;
          try {
            await config.store.transition(envelope.id, "injected", "pending");
          } catch {
            // best-effort revert
          }
        }
      }
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
