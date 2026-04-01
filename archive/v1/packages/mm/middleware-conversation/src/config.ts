/**
 * Configuration for the conversation middleware.
 */
import type { SessionContext, ThreadMessage, ThreadStore } from "@koi/core";

export interface ConversationConfig {
  /** Thread store for loading/persisting conversation history. */
  readonly store: ThreadStore;
  /** Maximum token budget for injected history. Default: 4096. */
  readonly maxHistoryTokens?: number | undefined;
  /** Maximum messages to load from the store. Default: 200. */
  readonly maxMessages?: number | undefined;
  /** Token estimator for text. Default: chars / 4. */
  readonly estimateTokens?: ((text: string) => number) | undefined;
  /** Custom thread ID resolver. Falls back to ctx.metadata.threadId ?? ctx.channelId. */
  readonly resolveThreadId?: ((ctx: SessionContext) => string | undefined) | undefined;
  /** Optional compaction callback applied when messages exceed maxMessages. */
  readonly compact?: ((messages: readonly ThreadMessage[]) => readonly ThreadMessage[]) | undefined;
}

export interface ConversationDefaults {
  readonly maxHistoryTokens: number;
  readonly maxMessages: number;
}

export const CONVERSATION_DEFAULTS: ConversationDefaults = Object.freeze({
  maxHistoryTokens: 4_096,
  maxMessages: 200,
});
