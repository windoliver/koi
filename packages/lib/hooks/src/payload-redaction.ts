/**
 * Payload redaction for agent hook prompts.
 *
 * Two modes:
 * 1. Structure extraction (default): replace leaf values with type placeholders
 * 2. Secret redaction (forwardRawPayload): mask secrets while preserving values
 */

import type { HookRedactionConfig, JsonObject } from "@koi/core";
import type { CensorStrategy, Redactor } from "@koi/redaction";
import { createRedactor } from "@koi/redaction";

// ---------------------------------------------------------------------------
// Structure extraction — default mode (keys + types, no values)
// ---------------------------------------------------------------------------

/** Maximum recursion depth for structure extraction. */
const MAX_STRUCTURE_DEPTH = 8;

/** Maximum array elements to summarize before truncating. */
const MAX_ARRAY_SUMMARY = 3;

/**
 * Recursively extract the structure of a JSON value, replacing leaf values
 * with type placeholders. Gives the hook agent enough context to make policy
 * decisions without exposing sensitive values.
 */
function extractValueStructure(value: unknown, depth: number): unknown {
  if (depth > MAX_STRUCTURE_DEPTH) return "<truncated>";
  if (value === null) return null;
  if (value === undefined) return undefined;

  switch (typeof value) {
    case "string":
      return `<string:${value.length}>`;
    case "number":
      return "<number>";
    case "boolean":
      return "<boolean>";
    case "object": {
      if (Array.isArray(value)) {
        const preview = value
          .slice(0, MAX_ARRAY_SUMMARY)
          .map((item) => extractValueStructure(item, depth + 1));
        if (value.length > MAX_ARRAY_SUMMARY) {
          return [...preview, `<...${value.length - MAX_ARRAY_SUMMARY} more>`];
        }
        return preview;
      }
      const entries = Object.entries(value as Record<string, unknown>);
      return Object.fromEntries(entries.map(([k, v]) => [k, extractValueStructure(v, depth + 1)]));
    }
    default:
      return "<unknown>";
  }
}

/**
 * Extract a structural summary of event data — keys and type placeholders only.
 * Returns undefined for undefined input.
 */
export function extractStructure(data: JsonObject | undefined): JsonObject | undefined {
  if (data === undefined) return undefined;
  return extractValueStructure(data, 0) as JsonObject;
}

// ---------------------------------------------------------------------------
// Secret redaction — forwardRawPayload mode
// ---------------------------------------------------------------------------

/** Cached redactors keyed by censor strategy to avoid recompilation. */
const redactorCache = new Map<CensorStrategy, Redactor>();

function getRedactor(strategy: CensorStrategy): Redactor {
  const cached = redactorCache.get(strategy);
  if (cached !== undefined) return cached;
  const redactor = createRedactor({ censor: strategy });
  redactorCache.set(strategy, redactor);
  return redactor;
}

/**
 * Apply secret redaction to event data using `@koi/redaction`.
 * Returns a copy with detected secrets masked according to the censor strategy.
 *
 * When `config.enabled` is explicitly false, returns the data unchanged.
 */
export function redactEventData(
  data: JsonObject | undefined,
  config: HookRedactionConfig | undefined,
): JsonObject | undefined {
  if (data === undefined) return undefined;

  // Opt-out: explicit disable bypasses all redaction
  if (config?.enabled === false) return data;

  const strategy = config?.censor ?? "redact";
  const redactor = getRedactor(strategy);
  const result = redactor.redactObject(data);

  return result.value;
}
