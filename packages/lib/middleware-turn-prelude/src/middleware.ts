/**
 * Turn-prelude middleware — injects pending watch-pattern match notifications
 * as a user-role message before each model call.
 *
 * Peek/ack semantics:
 *   - peek(request): snapshot pending matches, cached by request object identity.
 *   - ack(request): clears those matches from the store on success.
 *   - On thrown error: ack is NOT called; matches remain pending for the retry.
 */

import type {
  CapabilityFragment,
  InboundMessage,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  PendingMatchStore,
  TaskItemId,
  TaskStatus,
  TurnContext,
} from "@koi/core";

import { buildPreludeMessage } from "./prelude-message.js";

// Turn-prelude runs BEFORE semantic-retry (priority 420) so that the enriched
// request is the one retry sees and re-uses on its own retry attempts.
// Lower number = outer onion layer = runs first.
const MIDDLEWARE_PRIORITY = 200;

export interface TurnPreludeConfig {
  /** Returns the active PendingMatchStore. Called on every model call so that
   *  session rotation (cycleSession) is transparent — the new store is picked
   *  up automatically without reinitializing the middleware. */
  readonly getStore: () => PendingMatchStore;
  /** Returns the task status for a given ID. Used to annotate the prelude. */
  readonly getTaskStatus: (id: TaskItemId) => TaskStatus | undefined;
}

/**
 * Enrich the request with a prelude message if there are pending matches.
 * Returns the original request unchanged when the store is empty.
 * Never mutates the input request.
 */
function enrichWithPrelude(request: ModelRequest, config: TurnPreludeConfig): ModelRequest {
  const store = config.getStore();
  const snapshot = store.peek(request);
  if (snapshot.length === 0) return request;

  const prelude = buildPreludeMessage(snapshot, config.getTaskStatus);
  if (prelude === undefined) return request;

  const inbound: InboundMessage = {
    senderId: prelude.senderId,
    timestamp: Date.now(),
    content: [{ kind: "text", text: prelude.content }],
  };

  return { ...request, messages: [inbound, ...request.messages] };
}

export function createTurnPreludeMiddleware(config: TurnPreludeConfig): KoiMiddleware {
  return {
    name: "turn-prelude",
    phase: "resolve",
    priority: MIDDLEWARE_PRIORITY,

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      const pending = config.getStore().pending();
      if (pending === 0) return undefined;
      return {
        label: "turn-prelude",
        description: `${String(pending)} pending background-task notification(s) queued for next turn`,
      };
    },

    async wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const enriched = enrichWithPrelude(request, config);
      // On throw: ack is not called — matches remain pending for retry.
      const result = await next(enriched);
      config.getStore().ack(request);
      return result;
    },

    async *wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const enriched = enrichWithPrelude(request, config);
      // Task 2.4 adds terminal-chunk ack logic. For now, forward chunks
      // without ack so the middleware at least compiles and routes correctly.
      yield* next(enriched);
    },
  };
}
