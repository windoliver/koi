/**
 * Factory that creates a dynamic ReminderSource which uses an LLM to extract
 * the current goal from conversation history, with built-in per-session caching.
 *
 * The LLM is not called on every injection — only every `extractEvery` injections.
 * Between extractions, the cached goal is reused.
 */

import type { InboundMessage } from "@koi/core/message";
import type { TurnContext } from "@koi/core/middleware";
import type { ReminderSource } from "./types.js";

export interface GoalExtractorConfig {
  /**
   * User-supplied function that summarizes the current goal from messages.
   * Typically wraps a cheap LLM call (e.g., Haiku).
   */
  readonly summarize: (messages: readonly InboundMessage[]) => string | Promise<string>;

  /**
   * Re-extract goal every N injections. Default: 1 (every injection).
   * With baseInterval=5 and extractEvery=3, the LLM runs every 15 turns.
   */
  readonly extractEvery?: number;
}

export interface GoalExtractor {
  /** The dynamic source to include in goal-reminder's sources array. */
  readonly source: ReminderSource;
  /** Clear cached goal for a session. Call from onSessionEnd to prevent leaks. */
  readonly clearSession: (sessionId: string) => void;
}

interface CacheEntry {
  readonly goal: string;
  readonly injectionCount: number;
}

/**
 * Create a dynamic ReminderSource that extracts goals from conversation via LLM.
 *
 * Returns a source + cleanup handle. The user brings their own model call.
 */
export function createGoalExtractorSource(config: GoalExtractorConfig): GoalExtractor {
  const extractEvery = config.extractEvery ?? 1;
  const cache = new Map<string, CacheEntry>();

  const source: ReminderSource = {
    kind: "dynamic",
    fetch: async (ctx: TurnContext): Promise<string> => {
      const sessionId = ctx.session.sessionId as string;
      const entry = cache.get(sessionId);

      // Use cache if we haven't hit the re-extraction interval
      if (entry !== undefined && entry.injectionCount % extractEvery !== 0) {
        cache.set(sessionId, {
          goal: entry.goal,
          injectionCount: entry.injectionCount + 1,
        });
        return entry.goal;
      }

      // Extract fresh goal via user-supplied LLM call
      try {
        const goal = await config.summarize(ctx.messages);
        cache.set(sessionId, {
          goal,
          injectionCount: (entry?.injectionCount ?? 0) + 1,
        });
        return goal;
      } catch (_e: unknown) {
        // Fail-safe: return cached goal if available, otherwise placeholder
        if (entry !== undefined) {
          cache.set(sessionId, {
            goal: entry.goal,
            injectionCount: entry.injectionCount + 1,
          });
          return entry.goal;
        }
        return "[goal extraction unavailable]";
      }
    },
  };

  return {
    source,
    clearSession: (sessionId: string): void => {
      cache.delete(sessionId);
    },
  };
}
