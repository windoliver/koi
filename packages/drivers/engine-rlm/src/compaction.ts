/**
 * History compaction for RLM REPL loop.
 *
 * When the conversation history approaches the context window limit,
 * compacts it by summarizing via a single model call.
 */

import type { InboundMessage, ModelHandler } from "@koi/core";
import type { TokenTracker } from "./token-tracker.js";
import { DEFAULT_COMPACTION_THRESHOLD } from "./types.js";

/**
 * Check whether compaction should be triggered based on token utilization.
 */
export function shouldCompact(tracker: TokenTracker, threshold?: number): boolean {
  const t = threshold ?? DEFAULT_COMPACTION_THRESHOLD;
  return tracker.utilization() >= t;
}

/**
 * Compact a conversation history by summarizing it via a model call.
 *
 * Returns a new message array with a single system summary message.
 * On failure, returns the original messages unchanged (fail-safe).
 *
 * @param messages - Current conversation history.
 * @param modelCall - Model handler for generating the summary.
 * @param model - Optional model identifier for the summary call.
 */
export async function compactHistory(
  messages: readonly InboundMessage[],
  modelCall: ModelHandler,
  model?: string,
): Promise<readonly InboundMessage[]> {
  if (messages.length === 0) return messages;

  try {
    const transcript = messages
      .map((m) => {
        const role =
          m.senderId === "assistant" ? "Assistant" : m.senderId === "tool" ? "Tool" : "User";
        const text = m.content.map((b) => (b.kind === "text" ? b.text : `[${b.kind}]`)).join("");
        return `${role}: ${text}`;
      })
      .join("\n");

    const response = await modelCall({
      messages: [
        {
          content: [
            {
              kind: "text" as const,
              text:
                "Summarize the following conversation concisely, preserving all key findings, " +
                "tool results, and decisions. This summary will replace the conversation history.\n\n" +
                transcript,
            },
          ],
          senderId: "user",
          timestamp: Date.now(),
        },
      ],
      ...(model !== undefined ? { model } : {}),
    });

    const summary: InboundMessage = {
      content: [{ kind: "text" as const, text: response.content }],
      senderId: "assistant",
      timestamp: Date.now(),
      metadata: { compacted: true },
      pinned: true,
    };

    return [summary];
  } catch {
    // Fail-safe: return original messages unchanged
    return messages;
  }
}
