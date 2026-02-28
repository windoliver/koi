/**
 * Heuristic fact extraction from conversation messages.
 *
 * Extracts structured facts (decisions, artifacts, resolutions, configuration)
 * from messages before they are lost to lossy LLM summarization.
 */

import type { InboundMessage } from "@koi/core/message";

/** A pattern that matches messages and extracts structured facts. */
export interface HeuristicPattern {
  readonly match: RegExp | ((msg: InboundMessage) => boolean);
  readonly category: string;
  /** Custom fact text extractor. Falls back to first text block if omitted. */
  readonly extractFact?: (msg: InboundMessage) => string | undefined;
}

/** Configuration for fact extraction. */
export interface FactExtractionConfig {
  readonly strategy: "heuristic";
  readonly patterns?: readonly HeuristicPattern[];
  readonly minFactLength?: number;
  /** Pass to memory.store() — when true, boost salience of near-duplicates. */
  readonly reinforce?: boolean;
}

/** A structured fact extracted from a message. */
export interface ExtractedFact {
  readonly text: string;
  readonly category: string;
  readonly entities: readonly string[];
}

const DEFAULT_MIN_FACT_LENGTH = 10;

/** Extract first text block content from a message. */
function firstText(msg: InboundMessage): string | undefined {
  for (const block of msg.content) {
    if (block.kind === "text") return block.text;
  }
  return undefined;
}

/** Extract related entities from message metadata. */
function extractEntities(msg: InboundMessage): readonly string[] {
  const meta = msg.metadata as Readonly<Record<string, unknown>> | undefined;
  if (meta === undefined) return [];
  const toolName = meta.toolName;
  if (typeof toolName === "string") return [toolName];
  const callId = meta.callId;
  if (typeof callId === "string") return [callId];
  return [];
}

// ---------------------------------------------------------------------------
// Default heuristic patterns
// ---------------------------------------------------------------------------

/** Tool result from file-writing operations → artifact fact. */
const ARTIFACT_TOOL_PATTERN: HeuristicPattern = {
  match: (msg) => {
    if (msg.senderId !== "tool") return false;
    const meta = msg.metadata as Readonly<Record<string, unknown>> | undefined;
    const toolName = typeof meta?.toolName === "string" ? meta.toolName : "";
    return /write_file|create_file|edit_file/.test(toolName);
  },
  category: "artifact",
  extractFact: (msg) => {
    const text = firstText(msg);
    if (text === undefined) return undefined;
    const meta = msg.metadata as Readonly<Record<string, unknown>> | undefined;
    const toolName = typeof meta?.toolName === "string" ? meta.toolName : "file operation";
    // Truncate long tool results to a reasonable fact length
    const truncated = text.length > 200 ? `${text.slice(0, 197)}...` : text;
    return `[${toolName}] ${truncated}`;
  },
};

/** Messages containing decision language → decision fact. */
const DECISION_PATTERN: HeuristicPattern = {
  match: /\b(decided|chose|selected|going with|opted for|will use|agreed on)\b/i,
  category: "decision",
};

/** Error resolution messages → resolution fact. */
const RESOLUTION_PATTERN: HeuristicPattern = {
  match: /\b(fixed|resolved|solved|working now|root cause was|the fix is|issue was)\b/i,
  category: "resolution",
};

/** Configuration/setting changes → configuration fact. */
const CONFIGURATION_PATTERN: HeuristicPattern = {
  match: /\b(set|configured|changed|updated)\s+(the\s+)?[\w.-]+\s+to\b/i,
  category: "configuration",
};

/** File path mentions in tool results → artifact fact. */
const FILE_PATH_PATTERN: HeuristicPattern = {
  match: (msg) => {
    if (msg.senderId !== "tool") return false;
    const text = firstText(msg);
    if (text === undefined) return false;
    // Match common file path patterns
    return /(?:\/[\w.-]+){2,}|[\w.-]+\/[\w.-]+\.\w+/.test(text);
  },
  category: "artifact",
  extractFact: (msg) => {
    const text = firstText(msg);
    if (text === undefined) return undefined;
    // Extract file paths
    const paths = text.match(/(?:\/[\w.-]+){2,}|[\w.-]+\/[\w.-]+\.\w+/g);
    if (paths === null || paths.length === 0) return undefined;
    return `File paths: ${paths.slice(0, 5).join(", ")}`;
  },
};

/** Default patterns shipped with the package. */
export const DEFAULT_HEURISTIC_PATTERNS: readonly HeuristicPattern[] = Object.freeze([
  ARTIFACT_TOOL_PATTERN,
  DECISION_PATTERN,
  RESOLUTION_PATTERN,
  CONFIGURATION_PATTERN,
  FILE_PATH_PATTERN,
]);

// ---------------------------------------------------------------------------
// Extraction logic
// ---------------------------------------------------------------------------

/** Resolve config with defaults. */
export function resolveFactExtractionConfig(
  config?: Partial<FactExtractionConfig>,
): FactExtractionConfig {
  return {
    strategy: config?.strategy ?? "heuristic",
    patterns: config?.patterns ?? DEFAULT_HEURISTIC_PATTERNS,
    minFactLength: config?.minFactLength ?? DEFAULT_MIN_FACT_LENGTH,
    reinforce: config?.reinforce ?? true,
  };
}

/** Test whether a message matches a pattern. */
function matchesPattern(msg: InboundMessage, pattern: HeuristicPattern): boolean {
  if (typeof pattern.match === "function") {
    return pattern.match(msg);
  }
  const text = firstText(msg);
  return text !== undefined && pattern.match.test(text);
}

/** Extract fact text from a message using a pattern. */
function extractFactText(msg: InboundMessage, pattern: HeuristicPattern): string | undefined {
  if (pattern.extractFact !== undefined) {
    return pattern.extractFact(msg);
  }
  return firstText(msg);
}

/**
 * Extract structured facts from a batch of messages.
 * Each message is tested against all patterns; first match wins.
 */
export function extractFacts(
  messages: readonly InboundMessage[],
  config: FactExtractionConfig,
): readonly ExtractedFact[] {
  const patterns = config.patterns ?? DEFAULT_HEURISTIC_PATTERNS;
  const minLength = config.minFactLength ?? DEFAULT_MIN_FACT_LENGTH;
  const results: ExtractedFact[] = [];

  for (const msg of messages) {
    for (const pattern of patterns) {
      if (!matchesPattern(msg, pattern)) continue;

      const text = extractFactText(msg, pattern);
      if (text === undefined || text.length < minLength) continue;

      results.push({
        text,
        category: pattern.category,
        entities: extractEntities(msg),
      });
      break; // First match wins per message
    }
  }

  return results;
}
