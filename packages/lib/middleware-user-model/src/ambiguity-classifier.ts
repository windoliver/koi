/**
 * Heuristic pre-action ambiguity classifier.
 *
 * Flags imperative requests that lack concrete targets. The default returns
 * { ambiguous: false } because most messages are clear enough; it surfaces
 * a clarifying question only when the message is short, imperative, and
 * lacks any qualifying detail.
 */

const VAGUE_VERBS: readonly string[] = ["fix", "do", "handle", "deal", "make", "change"];
const QUALIFIERS_PATTERN = /\b(the|this|that|these|those|in|to|for|with|on|of)\b/i;

export interface AmbiguityResult {
  readonly ambiguous: boolean;
  readonly question?: string | undefined;
}

export function classifyAmbiguity(text: string): AmbiguityResult {
  const lowered = text.toLowerCase().trim();
  if (lowered.length === 0) return { ambiguous: false };
  const words = lowered.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return { ambiguous: false };
  const first = words[0] ?? "";
  if (!VAGUE_VERBS.includes(first)) return { ambiguous: false };
  if (words.length > 4) return { ambiguous: false };
  if (QUALIFIERS_PATTERN.test(text)) return { ambiguous: false };
  return {
    ambiguous: true,
    question: "The instruction is ambiguous. Ask the user to clarify before proceeding.",
  };
}
