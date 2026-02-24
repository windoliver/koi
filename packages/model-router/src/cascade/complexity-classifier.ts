/**
 * Pre-request complexity classifier for cascade routing.
 *
 * Scores request complexity using 14 heuristic dimensions in <1ms
 * (pure text analysis, zero LLM calls). The cascade router uses
 * the result to skip cheap tiers for obviously complex requests.
 */

import type { JsonObject, ModelRequest } from "@koi/core";
import type { CascadeClassifier, ClassificationResult, ComplexityTier } from "./cascade-types.js";

// ---------------------------------------------------------------------------
// Dimension keys
// ---------------------------------------------------------------------------

export type DimensionKey =
  | "reasoning"
  | "code"
  | "multiStep"
  | "technical"
  | "outputFormat"
  | "domain"
  | "tokenCount"
  | "questionComplexity"
  | "imperativeVerbs"
  | "constraints"
  | "creative"
  | "simpleIndicators"
  | "relay"
  | "agentic";

/** Typed array of all dimension keys — avoids `Object.keys()` + `as` assertion. */
const DIMENSION_KEYS: readonly DimensionKey[] = [
  "reasoning",
  "code",
  "multiStep",
  "technical",
  "outputFormat",
  "domain",
  "tokenCount",
  "questionComplexity",
  "imperativeVerbs",
  "constraints",
  "creative",
  "simpleIndicators",
  "relay",
  "agentic",
] as const;

// ---------------------------------------------------------------------------
// Default keyword lists
// ---------------------------------------------------------------------------

const DEFAULT_KEYWORDS: Readonly<Record<DimensionKey, readonly string[]>> = {
  reasoning: [
    "analyze",
    "prove",
    "proof",
    "compare",
    "evaluate",
    "explain why",
    "reason about",
    "trade-off",
    "tradeoff",
    "trade off",
    "pros and cons",
    "justify",
    "critique",
    "assess",
    "deduce",
    "verify",
    "theorem",
    "derive",
  ],
  code: [
    "function",
    "class",
    "import",
    "interface",
    "const ",
    "let ",
    "return",
    "async",
    "await",
    "=>",
    "def ",
    "fn ",
    "struct",
  ],
  multiStep: [
    "first",
    "then",
    "finally",
    "step 1",
    "step 2",
    "step 3",
    "next",
    "after that",
    "afterwards",
    "subsequently",
    "1.",
    "2.",
    "3.",
  ],
  technical: [
    "kubernetes",
    "algorithm",
    "distributed",
    "microservices",
    "architecture",
    "database",
    "concurrent",
    "latency",
    "throughput",
    "scalability",
    "replication",
    "consensus",
    "optimization",
    "compilation",
    "runtime",
    "caching",
    "indexing",
    "schema",
    "pipeline",
    "protocol",
    "middleware",
    "api",
    "deployment",
    "container",
  ],
  outputFormat: [
    "json",
    "yaml",
    "table",
    "csv",
    "structured",
    "markdown",
    "xml",
    "html",
    "formatted",
  ],
  domain: [
    "genomics",
    "fpga",
    "quantum",
    "neural network",
    "cryptography",
    "blockchain",
    "bioinformatics",
    "differential equation",
    "linear algebra",
    "topology",
  ],
  tokenCount: [], // scored by char count, not keywords
  questionComplexity: [], // scored by ? count, not keywords
  imperativeVerbs: [
    "build",
    "implement",
    "deploy",
    "refactor",
    "create",
    "design",
    "develop",
    "construct",
    "integrate",
    "migrate",
    "write",
    "configure",
    "optimize",
  ],
  constraints: [
    "must",
    "requires",
    "restricted",
    "cannot",
    "shall not",
    "only if",
    "mandatory",
    "constraint",
    "limitation",
  ],
  creative: [
    "story",
    "poem",
    "brainstorm",
    "creative",
    "imagine",
    "fiction",
    "narrative",
    "artistic",
  ],
  simpleIndicators: [
    "hello",
    " hi ",
    " hey ",
    "what is",
    "define ",
    "thanks",
    "thank you",
    " yes",
    " no ",
    " ok ",
    " okay ",
    " sure ",
    "good morning",
    "good evening",
  ],
  relay: [
    "forward this",
    "pass along",
    "relay this",
    "escalate to",
    "hand off",
    "check status",
    "check my",
    "send this to",
    "notify ",
    "ping ",
    "remind me",
    "set a reminder",
    "check inbox",
    "mark as read",
    "mark as done",
  ],
  agentic: [
    "triage all",
    "batch process",
    "audit everything",
    "scan all",
    "process each",
    "for every",
    "iterate over",
    "crawl",
    "aggregate all",
  ],
} as const;

// ---------------------------------------------------------------------------
// Default weights
// ---------------------------------------------------------------------------
// Scaled ~2x from plan ratios so that 2-3 active dimensions reach MEDIUM
// territory. The raw sum is clamped to [0, 1] after computation.

const DEFAULT_WEIGHTS: Readonly<Record<DimensionKey, number>> = {
  reasoning: 0.36,
  code: 0.28,
  multiStep: 0.24,
  technical: 0.2,
  outputFormat: 0.2,
  domain: 0.16,
  tokenCount: 0.16,
  agentic: 0.1,
  questionComplexity: 0.1,
  constraints: 0.08,
  imperativeVerbs: 0.06,
  creative: 0.06,
  simpleIndicators: -0.2,
  relay: -0.18,
} as const;

// ---------------------------------------------------------------------------
// Default tier thresholds
// ---------------------------------------------------------------------------

const DEFAULT_MEDIUM_THRESHOLD = 0.25;
const DEFAULT_HEAVY_THRESHOLD = 0.6;
const DEFAULT_CHARS_PER_TOKEN = 4;
const DEFAULT_HEAVY_TOKEN_THRESHOLD = 50_000;
const DEFAULT_HEAVY_REASONING_KEYWORD_COUNT = 2;

// Keyword saturation threshold: 2 matches = full score
const DEFAULT_KEYWORD_SATURATION = 2;

// Sigmoid confidence: steepness controls how quickly confidence rises away from boundaries
const DEFAULT_SIGMOID_STEEPNESS = 15;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ComplexityClassifierOptions {
  readonly tierThresholds?: {
    readonly medium?: number;
    readonly heavy?: number;
  };
  readonly weights?: Partial<Readonly<Record<DimensionKey, number>>>;
  readonly keywords?: Partial<Readonly<Record<DimensionKey, readonly string[]>>>;
  readonly charsPerToken?: number;
  readonly heavyTokenThreshold?: number;
  readonly heavyReasoningKeywordCount?: number;
  /** Steepness of the sigmoid curve for confidence mapping. Higher = sharper transition. Default: 15. */
  readonly sigmoidSteepness?: number;
  /** Confidence below this threshold triggers MEDIUM fallback. Default: 0.70. Set to 0 to disable. */
  readonly confidenceThreshold?: number;
}

// ---------------------------------------------------------------------------
// Text extraction — user messages only
// ---------------------------------------------------------------------------

function extractUserText(request: ModelRequest): string {
  return request.messages
    .filter((msg) => msg.senderId !== "system" && msg.senderId !== "assistant")
    .flatMap((msg) => msg.content.filter((b) => b.kind === "text").map((b) => b.text))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Dimension scorers
// ---------------------------------------------------------------------------

function countKeywordMatches(textLower: string, keywords: readonly string[]): number {
  let count = 0;
  for (const kw of keywords) {
    if (textLower.includes(kw)) {
      count++;
    }
  }
  return count;
}

/** Saturating keyword scorer: returns 0–1.0, saturating at `threshold` matches. */
function keywordScore(textLower: string, keywords: readonly string[], threshold: number): number {
  const matches = countKeywordMatches(textLower, keywords);
  return Math.min(matches / threshold, 1.0);
}

function scoreCode(textLower: string, keywords: readonly string[]): number {
  // Strong signal: backtick code fences
  const hasFence = textLower.includes("```");
  const fenceScore = hasFence ? 0.8 : 0;
  const kwScore = keywordScore(textLower, keywords, 4);
  return Math.min(Math.max(fenceScore, kwScore), 1.0);
}

function scoreTokenCount(charCount: number, saturationChars: number): number {
  if (charCount <= 0) return 0;
  return Math.min(charCount / saturationChars, 1.0);
}

function scoreQuestionComplexity(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (ch === "?") count++;
  }
  if (count === 0) return 0;
  if (count === 1) return 0.2;
  if (count === 2) return 0.5;
  return 1.0;
}

// ---------------------------------------------------------------------------
// Sigmoid confidence
// ---------------------------------------------------------------------------

/** Maps distance from nearest tier boundary to confidence via sigmoid. */
function computeConfidence(
  score: number,
  mediumThreshold: number,
  heavyThreshold: number,
  steepness: number,
): number {
  const distToMedium = Math.abs(score - mediumThreshold);
  const distToHeavy = Math.abs(score - heavyThreshold);
  const minDist = Math.min(distToMedium, distToHeavy);
  return 1 / (1 + Math.exp(-steepness * minDist));
}

// ---------------------------------------------------------------------------
// Tier mapping
// ---------------------------------------------------------------------------

function mapTier(score: number, mediumThreshold: number, heavyThreshold: number): ComplexityTier {
  if (score >= heavyThreshold) return "HEAVY";
  if (score >= mediumThreshold) return "MEDIUM";
  return "LIGHT";
}

function mapTierIndex(tier: ComplexityTier, tierCount: number): number {
  if (tierCount <= 1) return 0;
  if (tierCount === 2) return tier === "LIGHT" ? 0 : 1;
  // 3+ tiers
  if (tier === "LIGHT") return 0;
  if (tier === "MEDIUM") return Math.floor(tierCount / 2);
  return tierCount - 1;
}

function buildReason(tier: ComplexityTier, topDimensions: readonly string[]): string {
  if (topDimensions.length === 0) return `Classified as ${tier}: minimal signal detected`;
  return `Classified as ${tier}: top signals — ${topDimensions.join(", ")}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a synchronous complexity classifier for pre-request cascade routing.
 * All scoring is heuristic-based and completes in <1ms.
 */
export function createComplexityClassifier(
  options?: ComplexityClassifierOptions,
): CascadeClassifier {
  const mediumThreshold = options?.tierThresholds?.medium ?? DEFAULT_MEDIUM_THRESHOLD;
  const heavyThreshold = options?.tierThresholds?.heavy ?? DEFAULT_HEAVY_THRESHOLD;
  const charsPerToken = options?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const heavyTokenThreshold = options?.heavyTokenThreshold ?? DEFAULT_HEAVY_TOKEN_THRESHOLD;
  const heavyReasoningCount =
    options?.heavyReasoningKeywordCount ?? DEFAULT_HEAVY_REASONING_KEYWORD_COUNT;
  const sigmoidSteepness = options?.sigmoidSteepness ?? DEFAULT_SIGMOID_STEEPNESS;
  const confidenceThreshold = options?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const saturationChars = heavyTokenThreshold * charsPerToken;

  // Merge keyword overrides
  const keywords: Readonly<Record<DimensionKey, readonly string[]>> = {
    ...DEFAULT_KEYWORDS,
    ...options?.keywords,
  };

  // Merge weight overrides
  const weights: Readonly<Record<DimensionKey, number>> = {
    ...DEFAULT_WEIGHTS,
    ...options?.weights,
  };

  const sat = DEFAULT_KEYWORD_SATURATION;

  return (request: ModelRequest, tierCount: number): ClassificationResult => {
    const text = extractUserText(request);
    const trimmed = text.trim();

    // Fast path: empty input
    if (trimmed.length === 0) {
      return {
        score: 0,
        confidence: 1,
        tier: "LIGHT",
        recommendedTierIndex: 0,
        reason: "Classified as LIGHT: empty input",
        dimensions: {},
      };
    }

    const textLower = trimmed.toLowerCase();

    // Padded text for word-boundary matching of short simpleIndicator keywords
    // (e.g. " hi " won't false-match "history"). Other dimensions use unpadded text.
    const textPadded = ` ${textLower} `;

    // Score each dimension (0.0–1.0 per dimension)
    const dimensions: Record<string, number> = {
      reasoning: keywordScore(textLower, keywords.reasoning, sat),
      code: scoreCode(textLower, keywords.code),
      multiStep: keywordScore(textLower, keywords.multiStep, sat),
      technical: keywordScore(textLower, keywords.technical, sat),
      outputFormat: keywordScore(textLower, keywords.outputFormat, sat),
      domain: keywordScore(textLower, keywords.domain, sat),
      tokenCount: scoreTokenCount(trimmed.length, saturationChars),
      questionComplexity: scoreQuestionComplexity(trimmed),
      imperativeVerbs: keywordScore(textLower, keywords.imperativeVerbs, sat),
      constraints: keywordScore(textLower, keywords.constraints, sat),
      creative: keywordScore(textLower, keywords.creative, sat),
      simpleIndicators: keywordScore(textPadded, keywords.simpleIndicators, sat),
      relay: keywordScore(textPadded, keywords.relay, sat),
      agentic: keywordScore(textLower, keywords.agentic, sat),
    };

    // Weighted sum
    let rawScore = 0;
    for (const key of DIMENSION_KEYS) {
      const dimScore = dimensions[key];
      if (dimScore !== undefined) {
        rawScore += dimScore * weights[key];
      }
    }

    // Clamp to [0, 1]
    let score = Math.max(0, Math.min(rawScore, 1.0));

    // Override rules (only raise, never lower). Track whether any fired.
    let overrideFired = false;

    const reasoningMatches = countKeywordMatches(textLower, keywords.reasoning);
    if (reasoningMatches >= heavyReasoningCount) {
      score = Math.max(score, heavyThreshold);
      overrideFired = true;
    }

    const estimatedTokens = trimmed.length / charsPerToken;
    if (estimatedTokens > heavyTokenThreshold) {
      score = Math.max(score, heavyThreshold);
      overrideFired = true;
    }

    // Combined override: analytical + deeply technical → HEAVY
    const reasoningDim = dimensions.reasoning ?? 0;
    const technicalDim = dimensions.technical ?? 0;
    if (reasoningDim > 0 && technicalDim >= 0.8) {
      score = Math.max(score, heavyThreshold);
      overrideFired = true;
    }

    // Combined override: code refactoring with multi-step analysis → HEAVY
    const codeDim = dimensions.code ?? 0;
    const multiStepDim = dimensions.multiStep ?? 0;
    if (codeDim >= 0.5 && multiStepDim >= 0.5 && reasoningDim > 0) {
      score = Math.max(score, heavyThreshold);
      overrideFired = true;
    }

    // Final clamp
    score = Math.min(score, 1.0);

    // Sigmoid confidence: how far is the score from the nearest tier boundary?
    const confidence = computeConfidence(score, mediumThreshold, heavyThreshold, sigmoidSteepness);

    // Low-confidence fallback: when near a boundary and no override fired,
    // default to MEDIUM as the safe middle ground.
    let tier: ComplexityTier;
    if (!overrideFired && confidenceThreshold > 0 && confidence < confidenceThreshold) {
      tier = "MEDIUM";
    } else {
      tier = mapTier(score, mediumThreshold, heavyThreshold);
    }

    const recommendedTierIndex = mapTierIndex(tier, tierCount);

    // Build top dimensions for reason string
    const topDimensions = Object.entries(dimensions)
      .filter(([key, val]) => val > 0 && key !== "simpleIndicators" && key !== "relay")
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([key]) => key);

    const reason =
      !overrideFired && confidenceThreshold > 0 && confidence < confidenceThreshold
        ? `Low confidence (${(confidence * 100).toFixed(0)}%), defaulting to MEDIUM: top signals — ${topDimensions.join(", ") || "none"}`
        : buildReason(tier, topDimensions);

    return {
      score,
      confidence,
      tier,
      recommendedTierIndex,
      reason,
      dimensions: dimensions satisfies JsonObject,
    };
  };
}
