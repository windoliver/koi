/**
 * Pure functions for todo state management — no side effects.
 */

import type { TodoItem, TodoState } from "./types.js";

export function createTodoState(objectives: readonly string[]): TodoState {
  return {
    items: objectives.map((text, i): TodoItem => ({ id: `obj-${i}`, text, status: "pending" })),
  };
}

export function renderTodoBlock(state: TodoState, header: string): string {
  const lines = state.items.map((item) =>
    item.status === "completed" ? `- [x] ${item.text}` : `- [ ] ${item.text}`,
  );
  return `${header}\n\n${lines.join("\n")}`;
}

const COMPLETION_PATTERNS = [
  /\b(completed?|done|finished?|accomplished?)\b/i,
  /\[x\]/i,
  /[✓✅]/u,
] as const;

/**
 * Heuristic scan of response text for completion signals near objective keywords.
 * Returns the same state reference if nothing changed (fast path).
 */
export function detectCompletions(responseText: string, state: TodoState): TodoState {
  const hasCompletion = COMPLETION_PATTERNS.some((p) => p.test(responseText));
  if (!hasCompletion) return state; // fast path: no completion signals

  const lowerText = responseText.toLowerCase();
  let changed = false;
  const updatedItems = state.items.map((item): TodoItem => {
    if (item.status === "completed") return item;
    // Check if response mentions this objective's keywords
    const keywords = item.text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);
    const mentioned = keywords.some((kw) => lowerText.includes(kw));
    if (mentioned) {
      changed = true;
      return { ...item, status: "completed" as const };
    }
    return item;
  });

  if (!changed) return state;
  return { items: updatedItems };
}
