/**
 * Factory function for the guided-retry middleware.
 *
 * Creates a stateful middleware that injects constraint hints into model calls
 * after a backtrack/fork event. The constraint is consumed after maxInjections calls.
 */

import type {
  BacktrackConstraint,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  TurnContext,
} from "@koi/core";
import { formatConstraintMessage } from "./format.js";
import type { GuidedRetryConfig, GuidedRetryHandle } from "./types.js";

const MIDDLEWARE_NAME = "guided-retry";
const MIDDLEWARE_PRIORITY = 425;
const DEFAULT_MAX_INJECTIONS = 1;

/**
 * Creates a guided-retry middleware that injects constraint hints
 * into model calls after a backtrack event.
 */
export function createGuidedRetryMiddleware(config: GuidedRetryConfig): GuidedRetryHandle {
  // let: mutable state — this middleware is stateful by design.
  // The constraint is set externally (e.g., by a backtrack handler)
  // and consumed after maxInjections model calls.
  let constraint: BacktrackConstraint | undefined = config.initialConstraint;
  let remainingInjections: number =
    config.initialConstraint?.maxInjections ?? DEFAULT_MAX_INJECTIONS;

  // If no initial constraint, start with 0 remaining injections
  if (constraint === undefined) {
    remainingInjections = 0;
  }

  const middleware: KoiMiddleware = {
    name: MIDDLEWARE_NAME,
    priority: MIDDLEWARE_PRIORITY,

    async wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: (request: ModelRequest) => Promise<ModelResponse>,
    ): Promise<ModelResponse> {
      if (constraint === undefined) {
        return next(request);
      }

      const systemMessage = formatConstraintMessage(constraint);
      const modifiedRequest: ModelRequest = {
        ...request,
        messages: [systemMessage, ...request.messages],
      };

      const response = await next(modifiedRequest);

      remainingInjections--;
      if (remainingInjections <= 0) {
        constraint = undefined;
        remainingInjections = 0;
      }

      return response;
    },
  };

  return {
    middleware,

    setConstraint(c: BacktrackConstraint): void {
      constraint = c;
      remainingInjections = c.maxInjections ?? DEFAULT_MAX_INJECTIONS;
    },

    clearConstraint(): void {
      constraint = undefined;
      remainingInjections = 0;
    },

    hasConstraint(): boolean {
      return constraint !== undefined;
    },
  };
}
