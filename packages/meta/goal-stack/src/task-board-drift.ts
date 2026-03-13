/**
 * Task-aware drift detection — checks whether recent messages
 * mention keywords from pending/assigned tasks on the board.
 */

import type { TaskBoardSnapshot } from "@koi/core";
import type { TurnContext } from "@koi/core/middleware";

const MIN_KEYWORD_LENGTH = 4;

export function createTaskAwareDrifting(
  getSnapshot: () => TaskBoardSnapshot,
): (ctx: TurnContext) => boolean {
  return (ctx: TurnContext): boolean => {
    const snapshot = getSnapshot();
    const activeTasks = snapshot.items.filter(
      (item) => item.status === "pending" || item.status === "assigned",
    );
    if (activeTasks.length === 0) return false;

    const keywords = extractKeywords(activeTasks.map((t) => t.description));
    if (keywords.size === 0) return false;

    const recentMessages = ctx.messages.slice(-3);
    if (recentMessages.length === 0) return true;

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
  };
}

function extractKeywords(descriptions: readonly string[]): ReadonlySet<string> {
  const keywords = new Set<string>();
  for (const desc of descriptions) {
    const words = desc.toLowerCase().split(/\s+/);
    for (const word of words) {
      const cleaned = word.replace(/[^a-z0-9]/g, "");
      if (cleaned.length >= MIN_KEYWORD_LENGTH) {
        keywords.add(cleaned);
      }
    }
  }
  return keywords;
}
