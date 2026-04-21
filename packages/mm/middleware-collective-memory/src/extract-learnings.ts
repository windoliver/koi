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
// The denylist targets verbs most commonly used in prompt-injection payloads
// that aim to plant persistent instructions in shared memory. For stricter
// policies (allowlist of declarative observations only), use the
// validateLearning config hook on createCollectiveMemoryMiddleware().
const LEADING_INJECTION_VERB_RE =
  /^\s*(?:ignore|bypass|override|disable|disregard|suppress|escalate|leak|exfiltrate|pretend|forget|reveal|grant|allow\s+access|delete\s+(?:the|all|every)|execute\s+(?:the|this|a)|run\s+with\b|use\s+(?:the\s+)?(?:prod|production|staging|live|dev|shared)\s+\w+|access\s+(?:the\s+)?(?:prod|production|staging|live|dev|shared|secret|vault|credential)|print\s+(?:the\s+)?(?:prod|production|env|environment|secret|token|key|credential|config)|dump\s+(?:the\s+)?(?:prod|production|env|environment|secret|token|key|credential|config|file|all|every|~|\/)|copy\s+(?:the\s+)?(?:prod|production|env|environment|secret|token|key|credential|config|~|\/)|cat\s+(?:~|\/|\$)|sudo\s+|chmod\s+|chown\s+|source\s+(?:~|\/|\$)|always\s+(?:dump|print|copy|expose|share|send|email|post|cat|sudo|chmod|chown|leak|reveal))\b/i;

// Modal/imperative openings commonly used in prompt-injection payloads. These
// are checked separately to keep the main regex maintainable.
// Apostrophe class accepts straight (U+0027) or right-single-quote (U+2019).
const MODAL_INJECTION_OPENING_RE =
  /^\s*(?:don['’]?t\s+(?:ask|request|prompt|wait|check|verify|validate|confirm|require|seek|warn|notify)|avoid\s+(?:the\s+)?(?:sandbox|approval|permission|policy|prompt|gate|confirmation|review|validation|warning))\b/i;

// "should/must always|never <attack-verb>" command-shaped guidance.
// Restricted to the verbs that consistently signal injection: ignore, bypass,
// skip, disable, leak, reveal, dump, expose, sudo, chmod, chown.
// Excludes 'use', 'check', 'validate', etc. which appear in legitimate
// learnings ('always use --frozen-lockfile in CI').
const POLICY_VERB_RE =
  /^\s*(?:should|must)\s+(?:always|never)\s+(?:ignore|bypass|skip|disable|leak|reveal|dump|expose|sudo|chmod|chown)\b/i;

// Reject content that mentions a sensitive filesystem location regardless of
// sentence position — paths like ~/.ssh, /etc/passwd, /root/, .aws/credentials
// are only ever quoted in commands or exfiltration instructions, never in a
// legitimate operational learning that a future agent should "remember".
const SENSITIVE_PATH_RE =
  /(?:~|\$HOME|\/home\/[^/\s]+|\/root)\/\.(?:ssh|aws|gnupg|gpg|kube|docker|config\/gcloud|netrc)|\/etc\/(?:passwd|shadow|sudoers|gshadow|krb5\.keytab)|\.env(?:\.\w+)?\b|\b(?:id_rsa|id_ed25519|id_ecdsa|authorized_keys|known_hosts)\b|\b(?:credentials\.json|service-account\.json|kubeconfig)\b/i;

// Reject "Next time" / "Always" / "From now on" framings that wrap an imperative
// verb — these are the most common prompt-injection rhetorical patterns the
// regex extractor would otherwise accept.
const POLICY_FRAMING_RE =
  /^\s*(?:next\s+time|from\s+now\s+on|going\s+forward|in\s+future|important[:\s]|policy[:\s]|rule[:\s]|note[:\s])\s*[,:;-]?\s*(?:always|never|please|kindly|just|simply|first|then)?\s*(?:ignore|bypass|override|disable|skip|delete|execute|run|print|dump|copy|cat|sudo|reveal|leak|expose|share|send|email|post|grant|allow|escalate|use\s+the\s+(?:prod|production|staging|live)|access\s+the)/i;

export function isInstruction(content: string): boolean {
  if (LEADING_INJECTION_VERB_RE.test(content)) return true;
  if (MODAL_INJECTION_OPENING_RE.test(content)) return true;
  if (POLICY_VERB_RE.test(content)) return true;
  if (SENSITIVE_PATH_RE.test(content)) return true;
  if (POLICY_FRAMING_RE.test(content)) return true;
  return false;
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
        // The pattern verb (e.g. 'avoid', 'don't') has been stripped from
        // `content`, so isInstruction(content) misses the original imperative.
        // Test isInstruction on match[0] — the verb + captured tail — so an
        // attack like 'Avoid the sandbox' (verb in match[0], 'the sandbox' in
        // captured content) is correctly rejected.
        if (
          content !== undefined &&
          content.length > 0 &&
          !isInstruction(match[0]) &&
          !isInstruction(content)
        ) {
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
