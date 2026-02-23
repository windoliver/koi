/**
 * TurnAckMiddleware — two-stage acknowledgement for long-running agent turns.
 *
 * Stage 1: "processing" status sent after a debounce delay (skipped for fast turns).
 * Stage 2: "idle" status sent when the turn completes.
 *
 * sendStatus calls are fire-and-forget — they never block the turn.
 */

import type { KoiMiddleware, ToolHandler, ToolRequest, ToolResponse, TurnContext } from "@koi/core";
import type { TurnAckConfig } from "./config.js";

export function createTurnAckMiddleware(config?: TurnAckConfig): KoiMiddleware {
  const debounceMs = config?.debounceMs ?? 100;
  const toolStatus = config?.toolStatus ?? true;
  const onError =
    config?.onError ?? ((e: unknown) => console.warn("TurnAck: sendStatus failed", e));

  // Per-turn state: AbortController for debounce cleanup
  // let justified: mutable state reset per turn for debounce timer lifecycle
  let turnAbort: AbortController | undefined;

  return {
    name: "turn-ack",
    priority: 50,

    async onBeforeTurn(ctx: TurnContext): Promise<void> {
      if (ctx.sendStatus === undefined) return;

      // Clean up any previous turn's abort controller
      turnAbort?.abort();
      turnAbort = new AbortController();
      const { signal } = turnAbort;
      const sendStatus = ctx.sendStatus;
      const turnIndex = ctx.turnIndex;

      // Debounce: wait debounceMs before sending "processing" status
      // If the turn completes before the timer fires, the abort cancels it
      setTimeout(() => {
        if (signal.aborted) return;
        sendStatus({ kind: "processing", turnIndex }).catch((e: unknown) => onError(e));
      }, debounceMs);
    },

    async onAfterTurn(ctx: TurnContext): Promise<void> {
      // Abort any pending debounce timer
      turnAbort?.abort();
      turnAbort = undefined;

      if (ctx.sendStatus === undefined) return;

      // Fire-and-forget idle status
      ctx.sendStatus({ kind: "idle", turnIndex: ctx.turnIndex }).catch((e: unknown) => onError(e));
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      if (toolStatus && ctx.sendStatus !== undefined) {
        // Fire-and-forget: notify channel that a tool is executing
        ctx
          .sendStatus({
            kind: "processing",
            turnIndex: ctx.turnIndex,
            detail: `calling ${request.toolId}`,
          })
          .catch((e: unknown) => onError(e));
      }
      return next(request);
    },
  };
}
