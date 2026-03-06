/**
 * Pure functions for adaptive interval computation and drift detection.
 */

import type { InboundMessage } from "@koi/core/message";
import type { ReminderSessionState } from "./types.js";

const MIN_KEYWORD_LENGTH = 4;

/**
 * Compute the next interval state after a turn.
 *
 * On a trigger turn (turnCount - lastReminderTurn >= currentInterval):
 * - If drifting: reset interval to baseInterval
 * - If on-track: double interval (capped at maxInterval)
 * - Update lastReminderTurn
 *
 * Returns a new state object (never mutates).
 */
export function computeNextInterval(
  state: ReminderSessionState,
  isDrifting: boolean,
  baseInterval: number,
  maxInterval: number,
): ReminderSessionState {
  const turnCount = state.turnCount + 1;
  const isTriggerTurn = turnCount - state.lastReminderTurn >= state.currentInterval;

  if (!isTriggerTurn) {
    return { ...state, turnCount, shouldInject: false };
  }

  const nextInterval = isDrifting ? baseInterval : Math.min(state.currentInterval * 2, maxInterval);

  return {
    turnCount,
    currentInterval: nextInterval,
    lastReminderTurn: turnCount,
    shouldInject: true,
  };
}

/**
 * Default keyword-based drift detector.
 *
 * Extracts keywords (words >= 4 chars) from goals, checks if the last 3
 * messages mention any keyword. No overlap = drifting.
 *
 * Fail-safe behavior:
 * - Empty goals → never drifting (nothing to drift from)
 * - Empty messages → drifting (no evidence of on-task work)
 */
export function defaultIsDrifting(
  messages: readonly InboundMessage[],
  goals: readonly string[],
): boolean {
  if (goals.length === 0) return false;
  if (messages.length === 0) return true;

  const keywords = extractKeywords(goals);
  if (keywords.size === 0) return false;

  const recentMessages = messages.slice(-3);
  const recentText = recentMessages
    .flatMap((m) =>
      m.content
        .filter(
          (block): block is { readonly kind: "text"; readonly text: string } =>
            block.kind === "text",
        )
        .map((block) => block.text),
    )
    .join(" ")
    .toLowerCase();

  for (const keyword of keywords) {
    if (recentText.includes(keyword)) return false;
  }

  return true;
}

function extractKeywords(goals: readonly string[]): ReadonlySet<string> {
  const keywords = new Set<string>();
  for (const goal of goals) {
    const words = goal.toLowerCase().split(/\s+/);
    for (const word of words) {
      const cleaned = word.replace(/[^a-z0-9]/g, "");
      if (cleaned.length >= MIN_KEYWORD_LENGTH) {
        keywords.add(cleaned);
      }
    }
  }
  return keywords;
}
