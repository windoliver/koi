/**
 * createGoalReminderMiddleware — Adaptive periodic context refresh.
 *
 * Injects goal/constraint reminders every N turns with adaptive intervals.
 * Unlike goal-anchor (every call), this uses drift detection to adjust
 * injection frequency: doubles interval when on-track, resets on drift.
 */

import type { InboundMessage } from "@koi/core/message";
import type {
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  TurnContext,
} from "@koi/core/middleware";
import type { GoalReminderConfig } from "./config.js";
import { computeNextInterval, defaultIsDrifting } from "./interval.js";
import { resolveAllSources } from "./sources.js";
import type { ReminderSessionState } from "./types.js";

const INITIAL_STATE_FACTORY = (baseInterval: number): ReminderSessionState => ({
  turnCount: 0,
  currentInterval: baseInterval,
  lastReminderTurn: 0,
  shouldInject: false,
});

export function createGoalReminderMiddleware(config: GoalReminderConfig): KoiMiddleware {
  const header = config.header ?? "Reminder";
  const baseInterval = config.baseInterval;
  const maxInterval = config.maxInterval;
  const sessions = new Map<string, ReminderSessionState>();

  // Extract goal strings for default drift detection
  const goalStrings: readonly string[] = config.sources.flatMap((s) =>
    s.kind === "manifest" ? s.objectives : [],
  );

  const customIsDrifting = config.isDrifting;

  return {
    name: "goal-reminder",
    priority: 330,

    describeCapabilities: (ctx: TurnContext) => {
      const state = sessions.get(ctx.session.sessionId as string);
      if (!state) return undefined;
      return {
        label: "reminders",
        description: `Periodic reminders every ${String(state.currentInterval)} turns (next in ${String(Math.max(0, state.currentInterval - (state.turnCount - state.lastReminderTurn)))} turns)`,
      };
    },

    async onSessionStart(ctx: SessionContext): Promise<void> {
      sessions.set(ctx.sessionId as string, INITIAL_STATE_FACTORY(baseInterval));
    },

    async onBeforeTurn(ctx: TurnContext): Promise<void> {
      const sessionId = ctx.session.sessionId as string;
      const state = sessions.get(sessionId);
      if (!state) return;

      // Determine if this is a trigger turn first
      const isTriggerTurn = state.turnCount + 1 - state.lastReminderTurn >= state.currentInterval;

      // Only run drift detection on trigger turns
      let drifting = false;
      if (isTriggerTurn) {
        if (customIsDrifting) {
          try {
            drifting = await customIsDrifting(ctx);
          } catch (_e: unknown) {
            // Fail-safe: treat as drifting when detector throws
            drifting = true;
          }
        } else {
          drifting = defaultIsDrifting(ctx.messages, goalStrings);
        }
      }

      const nextState = computeNextInterval(state, drifting, baseInterval, maxInterval);
      sessions.set(sessionId, nextState);
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const state = sessions.get(ctx.session.sessionId as string);
      if (!state?.shouldInject) return next(request);

      const reminderText = await resolveAllSources(config.sources, ctx);
      const enriched = enrichRequest(request, buildReminderMessage(header, reminderText));
      return next(enriched);
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const state = sessions.get(ctx.session.sessionId as string);
      if (!state?.shouldInject) {
        yield* next(request);
        return;
      }

      const reminderText = await resolveAllSources(config.sources, ctx);
      const enriched = enrichRequest(request, buildReminderMessage(header, reminderText));
      yield* next(enriched);
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      sessions.delete(ctx.sessionId as string);
    },
  };
}

// ---------------------------------------------------------------------------
// Private helpers (duplicated from goal-anchor per design decision CQ4-A)
// ---------------------------------------------------------------------------

function buildReminderMessage(header: string, text: string): InboundMessage {
  return {
    senderId: "system:goal-reminder",
    timestamp: Date.now(),
    content: [{ kind: "text", text: `## ${header}\n\n${text}` }],
  };
}

function enrichRequest(request: ModelRequest, msg: InboundMessage): ModelRequest {
  return { ...request, messages: [msg, ...request.messages] };
}
