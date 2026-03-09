/**
 * Factory function for the guided-retry middleware.
 *
 * Creates a stateful middleware that injects constraint hints into model calls
 * after a backtrack/fork event. The constraint is consumed after maxInjections calls.
 */

import type {
  BacktrackConstraint,
  CapabilityFragment,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  SessionContext,
  TurnContext,
} from "@koi/core";
import { formatConstraintMessage } from "./format.js";
import type { GuidedRetryConfig, GuidedRetryHandle } from "./types.js";

/** Per-session mutable state for the guided-retry middleware. */
interface GuidedRetrySessionState {
  constraint: BacktrackConstraint | undefined;
  remainingInjections: number;
}

const MIDDLEWARE_NAME = "guided-retry";
const MIDDLEWARE_PRIORITY = 425;
const DEFAULT_MAX_INJECTIONS = 1;

/**
 * Creates a guided-retry middleware that injects constraint hints
 * into model calls after a backtrack event.
 */
export function createGuidedRetryMiddleware(config: GuidedRetryConfig): GuidedRetryHandle {
  // Per-session state map — keyed by sessionId to prevent cross-session leaks.
  const sessions = new Map<string, GuidedRetrySessionState>();

  function getSession(sessionId: string): GuidedRetrySessionState | undefined {
    return sessions.get(sessionId);
  }

  const middleware: KoiMiddleware = {
    name: MIDDLEWARE_NAME,
    priority: MIDDLEWARE_PRIORITY,

    async onSessionStart(ctx: SessionContext): Promise<void> {
      const initialConstraint = config.initialConstraint;
      sessions.set(ctx.sessionId as string, {
        constraint: initialConstraint,
        remainingInjections:
          initialConstraint !== undefined
            ? (initialConstraint.maxInjections ?? DEFAULT_MAX_INJECTIONS)
            : 0,
      });
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      sessions.delete(ctx.sessionId as string);
    },

    describeCapabilities: (ctx: TurnContext): CapabilityFragment => {
      const state = getSession(ctx.session.sessionId as string);
      if (state?.constraint !== undefined) {
        return {
          label: "guided-retry",
          description: `Constraint active (${String(state.remainingInjections)} injections remaining): injects hint into model calls`,
        };
      }
      return {
        label: "guided-retry",
        description: "Guided retry idle — no active constraint",
      };
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: (request: ModelRequest) => Promise<ModelResponse>,
    ): Promise<ModelResponse> {
      const state = getSession(ctx.session.sessionId as string);
      if (state?.constraint === undefined) {
        return next(request);
      }

      const systemMessage = formatConstraintMessage(state.constraint);
      const modifiedRequest: ModelRequest = {
        ...request,
        messages: [systemMessage, ...request.messages],
      };

      const response = await next(modifiedRequest);

      state.remainingInjections--;
      if (state.remainingInjections <= 0) {
        state.constraint = undefined;
        state.remainingInjections = 0;
      }

      return response;
    },
  };

  return {
    middleware,

    setConstraint(c: BacktrackConstraint, sessionId?: string): void {
      if (sessionId !== undefined) {
        const state = getSession(sessionId);
        if (state !== undefined) {
          state.constraint = c;
          state.remainingInjections = c.maxInjections ?? DEFAULT_MAX_INJECTIONS;
        }
        return;
      }
      // Fallback: apply to all active sessions (backwards compat)
      for (const state of sessions.values()) {
        state.constraint = c;
        state.remainingInjections = c.maxInjections ?? DEFAULT_MAX_INJECTIONS;
      }
    },

    clearConstraint(sessionId?: string): void {
      if (sessionId !== undefined) {
        const state = getSession(sessionId);
        if (state !== undefined) {
          state.constraint = undefined;
          state.remainingInjections = 0;
        }
        return;
      }
      for (const state of sessions.values()) {
        state.constraint = undefined;
        state.remainingInjections = 0;
      }
    },

    hasConstraint(sessionId?: string): boolean {
      if (sessionId !== undefined) {
        const state = getSession(sessionId);
        return state?.constraint !== undefined;
      }
      // Fallback: true if any session has a constraint
      for (const state of sessions.values()) {
        if (state.constraint !== undefined) return true;
      }
      return false;
    },
  };
}
