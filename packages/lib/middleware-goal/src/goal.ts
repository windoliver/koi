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
  ModelChunk,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
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
  readonly currentInterval: number;
  readonly lastReminderTurn: number;
  /** Whether to inject goals on the next model call this turn. Set by onBeforeTurn. */
  shouldInject: boolean;
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

/**
 * Detect which objectives were completed based on response text.
 *
 * Requires a completion signal AND a majority of the objective's keywords
 * (>= 50%, minimum 2 if the objective has 2+ keywords) to match. This
 * prevents false positives from single generic words like "write" or
 * "integration" appearing in unrelated completion text.
 */
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
    if (keywords.size === 0) return item;

    const matchCount = [...keywords].filter((kw) => lower.includes(kw)).length;
    // Require majority match: at least half the keywords, minimum 2 if available
    const threshold = keywords.size === 1 ? 1 : Math.max(2, Math.ceil(keywords.size / 2));
    if (matchCount >= threshold) {
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

  /**
   * Detect completions in text and update session state + fire callbacks.
   * Monotonic: completed objectives never revert to pending, even if a
   * later model call in the same turn lacks the completion signal.
   */
  function updateCompletions(sid: SessionId, text: string): void {
    // Always read the latest state from the map to avoid stale snapshots
    const current = sessions.get(sid);
    if (!current) return;

    const detected = detectCompletions(text, current.items);

    // Merge monotonically: true stays true
    const merged = current.items.map((item, i) => {
      const det = detected[i];
      if (item.completed) return item;
      if (det?.completed) return det;
      return item;
    });

    if (config.onComplete) {
      for (let i = 0; i < merged.length; i++) {
        const prev = current.items[i];
        const curr = merged[i];
        if (prev && curr && !prev.completed && curr.completed) {
          config.onComplete(curr.text);
        }
      }
    }

    sessions.set(sid, { ...current, items: merged });
  }

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
        currentInterval: baseInterval,
        lastReminderTurn: -1,
        shouldInject: true,
      });
    },

    async onBeforeTurn(ctx) {
      const state = sessions.get(ctx.session.sessionId);
      if (!state) return;

      const turnsSinceReminder = ctx.turnIndex - state.lastReminderTurn;
      state.shouldInject = turnsSinceReminder >= state.currentInterval || ctx.turnIndex === 0;
    },

    async onAfterTurn(ctx) {
      const state = sessions.get(ctx.session.sessionId);
      if (!state) return;

      if (state.shouldInject) {
        const drifting = isDrifting(ctx.messages, allKeywords);
        const nextInterval = computeNextInterval(
          state.currentInterval,
          drifting,
          baseInterval,
          maxInterval,
        );
        sessions.set(ctx.session.sessionId, {
          ...state,
          currentInterval: nextInterval,
          lastReminderTurn: ctx.turnIndex,
          shouldInject: false,
        });
      }
    },

    async wrapModelCall(ctx, request, next) {
      const state = sessions.get(ctx.session.sessionId);
      if (!state) return next(request);

      const enrichedRequest = state.shouldInject
        ? {
            ...request,
            messages: [buildGoalMessage(renderGoalBlock(state.items, header)), ...request.messages],
          }
        : request;

      const response: ModelResponse = await next(enrichedRequest);

      // Detect completions in response
      updateCompletions(ctx.session.sessionId, response.content);

      return response;
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const state = sessions.get(ctx.session.sessionId);
      if (!state) {
        yield* next(request);
        return;
      }

      const enrichedRequest = state.shouldInject
        ? {
            ...request,
            messages: [buildGoalMessage(renderGoalBlock(state.items, header)), ...request.messages],
          }
        : request;

      // Buffer streamed text for completion detection — only on success
      let bufferedText = "";
      let succeeded = false;
      try {
        for await (const chunk of next(enrichedRequest)) {
          if (chunk.kind === "text_delta") {
            bufferedText += chunk.delta;
          } else if (chunk.kind === "done" && bufferedText.length === 0) {
            // Fallback: some adapters only emit done.response.content with no text_delta
            bufferedText = chunk.response.content;
          }
          yield chunk;
        }
        succeeded = true;
      } finally {
        // Only detect completions if stream completed successfully
        if (succeeded) {
          updateCompletions(ctx.session.sessionId, bufferedText);
        }
      }
    },

    async wrapToolCall(_ctx, request, next) {
      return next(request);
    },

    async onSessionEnd(ctx) {
      sessions.delete(ctx.sessionId);
    },
  };
}
