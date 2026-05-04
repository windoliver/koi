/**
 * Heuristic post-action correction detector.
 *
 * Returns true ONLY for messages whose surface structure is clearly a
 * self-correction or restatement of an earlier instruction. Loose
 * substrings like "not ", "stop", "wrong", or "instead" caused routine
 * task instructions ("do not use mock data", "stop using the old
 * endpoint", "use REST instead") to be persisted as durable preferences,
 * leading to long-lived prompt poisoning across unrelated turns
 * (review round 12, finding 1). The current set therefore prefers
 * positional or unambiguous markers and explicitly avoids any short
 * common-English token.
 */

/**
 * Anchored markers — match only at the start of the message (after
 * trimming and case-folding). These are conventional self-correction
 * openers that rarely occur as ordinary task prose.
 */
const ANCHORED_MARKERS: readonly string[] = [
  "no,",
  "no.",
  "wait,",
  "wait.",
  "actually,",
  "actually ",
  "correction:",
];

/**
 * Phrase markers — must appear as a multi-word phrase anywhere in the
 * message. Multi-word form makes incidental matches in normal task
 * instructions extremely unlikely.
 */
const PHRASE_MARKERS: readonly string[] = [
  "i meant ",
  "i mean ",
  "let me rephrase",
  "let me clarify",
  "scratch that",
  "ignore that",
  "ignore my last",
  "disregard that",
  "what i actually want",
  "to be clear,",
  "to clarify,",
];

const MIN_CORRECTION_WORDS = 3;

export function isCorrection(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const lowered = trimmed.toLowerCase();
  const wordCount = lowered.split(/\s+/).filter((w) => w.length > 0).length;
  if (wordCount < MIN_CORRECTION_WORDS) return false;
  for (const marker of ANCHORED_MARKERS) {
    if (lowered.startsWith(marker)) return true;
  }
  for (const marker of PHRASE_MARKERS) {
    if (lowered.includes(marker)) return true;
  }
  return false;
}
