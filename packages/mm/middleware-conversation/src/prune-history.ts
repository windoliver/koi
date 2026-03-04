/**
 * Prune conversation history via truncation or custom compaction.
 */
import type { ThreadMessage } from "@koi/core";

export interface PruneConfig {
  readonly maxMessages: number;
  readonly compact?: ((messages: readonly ThreadMessage[]) => readonly ThreadMessage[]) | undefined;
}

/**
 * Prune messages to fit within maxMessages.
 * If a compact callback is provided, it is called to perform custom compaction.
 * Otherwise, the oldest messages are dropped, keeping the newest N.
 */
export function pruneHistory(
  messages: readonly ThreadMessage[],
  config: PruneConfig,
): readonly ThreadMessage[] {
  if (messages.length <= config.maxMessages) {
    return messages;
  }

  if (config.compact !== undefined) {
    return config.compact(messages);
  }

  return messages.slice(messages.length - config.maxMessages);
}
