/**
 * Budget middleware — caps total model calls per turn.
 *
 * Sits at priority 999 (innermost) so every model call passes through it,
 * including retries from output-verifier and feedback-loop.
 *
 * Resets the counter when ctx.turnIndex changes (new turn boundary).
 */

import type { KoiMiddleware, ModelRequest, ModelResponse, TurnContext } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";

/**
 * Creates a budget middleware that caps total model calls per turn.
 *
 * The returned middleware maintains mutable per-turn call counters.
 * Each agent session must use its own instance — do not share across
 * concurrent sessions. Budget counter auto-resets on turn boundaries.
 */
export function createBudgetMiddleware(maxCalls: number): KoiMiddleware {
  if (!Number.isFinite(maxCalls) || maxCalls < 1) {
    throw KoiRuntimeError.from(
      "VALIDATION",
      `maxCalls must be a positive integer, got: ${maxCalls}`,
      {
        retryable: false,
        context: { maxCalls },
      },
    );
  }

  // Mutable state: call count and last seen turn index
  // let is justified: budget counter must reset across turns
  let callCount = 0;
  let lastTurnIndex = -1;

  return {
    name: "koi:quality-gate:budget",
    priority: 999,
    describeCapabilities: (_ctx: TurnContext) => undefined,
    wrapModelCall: async (
      ctx: TurnContext,
      request: ModelRequest,
      next: (request: ModelRequest) => Promise<ModelResponse>,
    ): Promise<ModelResponse> => {
      // Reset counter on new turn
      if (ctx.turnIndex !== lastTurnIndex) {
        callCount = 0;
        lastTurnIndex = ctx.turnIndex;
      }

      callCount += 1;

      if (callCount > maxCalls) {
        throw KoiRuntimeError.from(
          "RATE_LIMIT",
          `Quality-gate budget exhausted: ${maxCalls} model calls per turn exceeded`,
          {
            retryable: false,
            context: { maxCalls, actualCalls: callCount, turnIndex: ctx.turnIndex },
          },
        );
      }

      return next(request);
    },
  };
}
