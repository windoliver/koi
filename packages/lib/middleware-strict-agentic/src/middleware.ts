/**
 * Factory for @koi/middleware-strict-agentic.
 *
 * Wires together the config, classifier, state store, and feedback modules
 * into a KoiMiddleware with four active hooks:
 *   wrapModelCall, onBeforeStop, onAfterTurn, onSessionEnd.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelContentBlock,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  SessionContext,
  StopGateResult,
  TurnContext,
} from "@koi/core";
import { classifyTurn } from "./classifier.js";
import type { StrictAgenticConfig } from "./config.js";
import { resolveStrictAgenticConfig } from "./config.js";
import { DEFAULT_FEEDBACK } from "./feedback.js";
import { createStateStore } from "./state.js";

const MIDDLEWARE_NAME = "strict-agentic";
/** Priority 410: runs outside semantic-retry (420). Phase "intercept" matches the stop-gate role. */
const MIDDLEWARE_PRIORITY = 410;

export interface StrictAgenticHandle {
  readonly middleware: KoiMiddleware;
  readonly getBlockCount: (sessionId: string) => number;
}

function countToolCalls(rich: readonly ModelContentBlock[] | undefined): number {
  if (!rich) return 0;
  let n = 0;
  for (const block of rich) {
    if (block.kind === "tool_call") n += 1;
  }
  return n;
}

export function createStrictAgenticMiddleware(
  config: Partial<StrictAgenticConfig> = {},
): StrictAgenticHandle {
  const resolved = resolveStrictAgenticConfig(config);
  const store = createStateStore();

  const middleware: KoiMiddleware = {
    name: MIDDLEWARE_NAME,
    priority: MIDDLEWARE_PRIORITY,
    phase: "intercept",

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const resp = await next(request);
      if (!resolved.enabled) return resp;
      store.recordTurn(ctx.turnId, {
        toolCallCount: countToolCalls(resp.richContent),
        outputText: resp.content,
      });
      return resp;
    },

    async onBeforeStop(ctx: TurnContext): Promise<StopGateResult> {
      if (!resolved.enabled) return { kind: "continue" };
      const turn = store.readTurn(ctx.turnId);
      if (!turn) return { kind: "continue" };

      const result = classifyTurn(turn, resolved);

      if (result.kind !== "filler") {
        store.resetBlocks(ctx.session.sessionId);
        return { kind: "continue" };
      }

      const blocks = store.incrementBlocks(ctx.session.sessionId);
      if (blocks > resolved.maxFillerRetries) {
        return { kind: "continue" };
      }

      return {
        kind: "block",
        reason: resolved.feedbackMessage ?? DEFAULT_FEEDBACK,
        blockedBy: MIDDLEWARE_NAME,
      };
    },

    async onAfterTurn(ctx: TurnContext): Promise<void> {
      store.clearTurn(ctx.turnId);
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      store.clearSession(ctx.sessionId);
    },

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      return {
        label: MIDDLEWARE_NAME,
        description:
          "Blocks completion on filler/plan-only turns — must call a tool, ask a question, or declare done.",
      };
    },
  };

  return {
    middleware,
    getBlockCount(sessionId: string): number {
      return store.getBlockCount(sessionId);
    },
  };
}
