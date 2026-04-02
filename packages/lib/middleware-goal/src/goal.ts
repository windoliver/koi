/**
 * Goal middleware — keeps agents focused on objectives via adaptive reminders
 * and heuristic completion detection.
 *
 * Dual middleware: wrapModelCall (inject goals, detect completions) +
 * wrapToolCall (track tool activity for drift detection).
 */

import type {
  CapabilityFragment,
  InboundMessage,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  SessionId,
  TurnContext,
} from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";

import {
  DEFAULT_BASE_INTERVAL,
  DEFAULT_GOAL_HEADER,
  DEFAULT_MAX_INTERVAL,
  type GoalMiddlewareConfig,
  validateGoalConfig,
} from "./config.js";

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface GoalItem {
  readonly text: string;
  readonly completed: boolean;
}

interface GoalSessionState {
  readonly items: readonly GoalItem[];
  readonly turnCount: number;
  readonly currentInterval: number;
  readonly lastReminderTurn: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const MIN_KEYWORD_LENGTH = 4;

/** Extract keywords (>= 4 chars) from objective text for matching. */
export function extractKeywords(objectives: readonly string[]): ReadonlySet<string> {
  const keywords = new Set<string>();
  for (const obj of objectives) {
    for (const word of obj.split(/\s+/)) {
      const clean = word.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
      if (clean.length >= MIN_KEYWORD_LENGTH) {
        keywords.add(clean);
      }
    }
  }
  return keywords;
}

/** Render a markdown todo block from goal items. */
export function renderGoalBlock(items: readonly GoalItem[], header: string): string {
  const lines = [header, ""];
  for (const item of items) {
    const mark = item.completed ? "x" : " ";
    lines.push(`- [${mark}] ${item.text}`);
  }
  return lines.join("\n");
}

const COMPLETION_SIGNALS = /\b(?:completed|done|finished|accomplished)\b|\[x\]|✓|✅/i;

/** Detect which objectives were completed based on response text. */
export function detectCompletions(
  responseText: string,
  items: readonly GoalItem[],
): readonly GoalItem[] {
  if (!COMPLETION_SIGNALS.test(responseText)) {
    return items;
  }

  const lower = responseText.toLowerCase();
  return items.map((item) => {
    if (item.completed) return item;
    const keywords = extractKeywords([item.text]);
    const matched = [...keywords].some((kw) => lower.includes(kw));
    if (matched) {
      return { ...item, completed: true };
    }
    return item;
  });
}

/** Check if the agent is drifting from goals based on recent messages. */
export function isDrifting(
  messages: readonly InboundMessage[],
  keywords: ReadonlySet<string>,
): boolean {
  if (keywords.size === 0) return false;
  const recent = messages.slice(-3);
  const text = recent
    .map((m) =>
      m.content
        .filter((b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text")
        .map((b) => b.text)
        .join(" "),
    )
    .join(" ")
    .toLowerCase();

  return ![...keywords].some((kw) => text.includes(kw));
}

/** Compute next interval based on drift. */
export function computeNextInterval(
  currentInterval: number,
  drifting: boolean,
  baseInterval: number,
  maxInterval: number,
): number {
  if (drifting) return baseInterval;
  return Math.min(currentInterval * 2, maxInterval);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function buildGoalMessage(text: string): InboundMessage {
  return {
    senderId: "system:goal",
    timestamp: Date.now(),
    content: [{ kind: "text", text }],
  };
}

export function createGoalMiddleware(config: GoalMiddlewareConfig): KoiMiddleware {
  const result = validateGoalConfig(config);
  if (!result.ok) {
    throw KoiRuntimeError.from(result.error.code, result.error.message);
  }

  const header = config.header ?? DEFAULT_GOAL_HEADER;
  const baseInterval = config.baseInterval ?? DEFAULT_BASE_INTERVAL;
  const maxInterval = config.maxInterval ?? DEFAULT_MAX_INTERVAL;
  const allKeywords = extractKeywords(config.objectives);
  const sessions = new Map<SessionId, GoalSessionState>();

  return {
    name: "goal",
    priority: 340,

    describeCapabilities(ctx: TurnContext): CapabilityFragment | undefined {
      const state = sessions.get(ctx.session.sessionId);
      if (!state) return undefined;
      const completed = state.items.filter((i) => i.completed).length;
      return {
        label: "goals",
        description: `${String(completed)}/${String(state.items.length)} objectives completed`,
      };
    },

    async onSessionStart(ctx) {
      const items: readonly GoalItem[] = config.objectives.map((text) => ({
        text,
        completed: false,
      }));
      sessions.set(ctx.sessionId, {
        items,
        turnCount: 0,
        currentInterval: baseInterval,
        lastReminderTurn: 0,
      });
    },

    async wrapModelCall(ctx, request, next) {
      const state = sessions.get(ctx.session.sessionId);
      if (!state) return next(request);

      // Increment turn count
      const turnCount = state.turnCount + 1;

      // Determine whether to inject goals this turn
      const turnsSinceReminder = turnCount - state.lastReminderTurn;
      const shouldInject = turnsSinceReminder >= state.currentInterval || turnCount === 1;

      let enrichedRequest: ModelRequest = request;
      if (shouldInject) {
        const goalText = renderGoalBlock(state.items, header);
        const goalMsg = buildGoalMessage(goalText);
        enrichedRequest = { ...request, messages: [goalMsg, ...request.messages] };
      }

      const response: ModelResponse = await next(enrichedRequest);

      // Detect completions in response
      const updatedItems = detectCompletions(response.content, state.items);

      // Notify on newly completed items
      if (config.onComplete) {
        for (let i = 0; i < updatedItems.length; i++) {
          const prev = state.items[i];
          const curr = updatedItems[i];
          if (prev && curr && !prev.completed && curr.completed) {
            config.onComplete(curr.text);
          }
        }
      }

      // Update interval based on drift
      const drifting = shouldInject ? isDrifting(ctx.messages, allKeywords) : false;
      const nextInterval = shouldInject
        ? computeNextInterval(state.currentInterval, drifting, baseInterval, maxInterval)
        : state.currentInterval;

      sessions.set(ctx.session.sessionId, {
        items: updatedItems,
        turnCount,
        currentInterval: nextInterval,
        lastReminderTurn: shouldInject ? turnCount : state.lastReminderTurn,
      });

      return response;
    },

    async wrapToolCall(_ctx, request, next) {
      return next(request);
    },

    async onSessionEnd(ctx) {
      sessions.delete(ctx.sessionId);
    },
  };
}
