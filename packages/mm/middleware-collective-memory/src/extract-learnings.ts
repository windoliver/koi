import type { CollectiveMemoryCategory } from "@koi/core";
import type { LearningCandidate, LearningExtractor } from "./types.js";

const MARKER_REGEX = /\[LEARNING:(\w+)]\s*(.+)/g;

const VALID_CATEGORIES = new Set<string>([
  "gotcha",
  "heuristic",
  "preference",
  "correction",
  "pattern",
  "context",
]);

const MAX_ENTRY_LENGTH = 500;

// Reject content whose leading verb signals a prompt-injection attack rather
// than a legitimate observation. This is a defence-in-depth measure — the LLM
// extraction path (onSessionEnd) has a higher-fidelity semantic filter; the
// regex path is inherently lower-trust and warrants an explicit denylist.
//
// Legitimate learnings are observations ("The API returns X when Y", "Learned
// that Z fails if…"). Injections pose as commands ("Ignore X", "Bypass Y").
// The denylist targets the verbs most commonly used in prompt-injection payloads
// that aim to plant persistent instructions in shared memory.
const INJECTION_VERB_RE =
  /^\s*(?:ignore|bypass|override|disable|disregard|suppress|escalate|leak|exfiltrate|pretend|forget|reveal|grant|allow\s+access|delete\s+(?:the|all|every)|execute\s+(?:the|this|a))\b/i;

function isInstruction(content: string): boolean {
  return INJECTION_VERB_RE.test(content);
}

function truncate(text: string): string {
  return text.length > MAX_ENTRY_LENGTH ? text.slice(0, MAX_ENTRY_LENGTH) : text;
}

function extractMarkers(output: string): readonly LearningCandidate[] {
  const results: LearningCandidate[] = [];
  MARKER_REGEX.lastIndex = 0;

  // let justified: regex exec loop requires mutable variable
  let match = MARKER_REGEX.exec(output);
  while (match !== null) {
    const rawCategory = match[1]?.toLowerCase();
    const content = match[2]?.trim();
    if (
      rawCategory !== undefined &&
      content !== undefined &&
      content.length > 0 &&
      !isInstruction(content)
    ) {
      const category: CollectiveMemoryCategory = VALID_CATEGORIES.has(rawCategory)
        ? (rawCategory as CollectiveMemoryCategory)
        : "context";
      results.push({ content: truncate(content), category, confidence: 1.0 });
    }
    match = MARKER_REGEX.exec(output);
  }
  return results;
}

interface HeuristicPattern {
  readonly regex: RegExp;
  readonly category: CollectiveMemoryCategory;
}

const HEURISTIC_PATTERNS: readonly HeuristicPattern[] = [
  {
    regex: /(?:mistake was|avoid|don'?t|gotcha|pitfall|watch out|be careful)[:\s]+(.+)/i,
    category: "gotcha",
  },
  {
    regex: /(?:actually|correction|not\s+\w+\s+but|turns out)[:\s]+(.+)/i,
    category: "correction",
  },
  {
    regex: /(?:next time|should always|better approach|best practice|pattern)[:\s]+(.+)/i,
    category: "pattern",
  },
  {
    regex: /(?:learned that|key insight|rule of thumb|important to|remember that)[:\s]+(.+)/i,
    category: "heuristic",
  },
];

function extractHeuristics(output: string): readonly LearningCandidate[] {
  const results: LearningCandidate[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    for (const pattern of HEURISTIC_PATTERNS) {
      const match = pattern.regex.exec(trimmed);
      if (match !== null) {
        const content = match[1]?.trim();
        if (content !== undefined && content.length > 0 && !isInstruction(content)) {
          results.push({ content: truncate(content), category: pattern.category, confidence: 0.7 });
        }
        break;
      }
    }
  }

  return results;
}

function deduplicateCandidates(
  candidates: readonly LearningCandidate[],
): readonly LearningCandidate[] {
  const seen = new Map<string, LearningCandidate>();
  for (const candidate of candidates) {
    const key = candidate.content.toLowerCase();
    const existing = seen.get(key);
    if (existing === undefined || candidate.confidence > existing.confidence) {
      seen.set(key, candidate);
    }
  }
  return [...seen.values()];
}

export function createDefaultExtractor(): LearningExtractor {
  return {
    extract(output: string): readonly LearningCandidate[] {
      const combined = [...extractMarkers(output), ...extractHeuristics(output)];
      const deduped = deduplicateCandidates(combined);
      return [...deduped].sort((a, b) => b.confidence - a.confidence);
    },
  };
}
