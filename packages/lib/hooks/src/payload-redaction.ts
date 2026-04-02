/**
 * Payload redaction for agent hook prompts.
 *
 * Two modes:
 * 1. Structure extraction (default): replace leaf values with type placeholders
 * 2. Secret redaction (forwardRawPayload): mask secrets while preserving values
 */

import type { HookRedactionConfig, JsonObject } from "@koi/core";
import type { CensorStrategy, Redactor } from "@koi/redaction";
import { createRedactor, DEFAULT_SENSITIVE_FIELDS } from "@koi/redaction";

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

/**
 * Maximum serialized size (bytes) for raw payloads forwarded to hook prompts.
 * Payloads exceeding this are replaced with a structural summary to prevent
 * context overflow and latency spikes in the hook agent.
 */
const MAX_RAW_PAYLOAD_SIZE = 32_768;

/**
 * Cached redactors keyed by cache key to avoid recompilation.
 * Key includes censor strategy + sorted sensitiveFields to ensure
 * different hook configs get distinct redactor instances.
 */
const redactorCache = new Map<string, Redactor>();

function buildRedactorCacheKey(
  strategy: CensorStrategy,
  sensitiveFields: readonly string[] | undefined,
): string {
  if (sensitiveFields === undefined || sensitiveFields.length === 0) return strategy;
  // Use JSON.stringify for collision-safe encoding — prevents keys like
  // ["a,b","c"] and ["a","b,c"] from producing the same cache key.
  return JSON.stringify([strategy, [...sensitiveFields].sort()]);
}

function getRedactor(
  strategy: CensorStrategy,
  sensitiveFields: readonly string[] | undefined,
): Redactor {
  const key = buildRedactorCacheKey(strategy, sensitiveFields);
  const cached = redactorCache.get(key);
  if (cached !== undefined) return cached;
  const redactor = createRedactor({
    censor: strategy,
    ...(sensitiveFields !== undefined && sensitiveFields.length > 0
      ? { fieldNames: [...DEFAULT_SENSITIVE_FIELDS, ...sensitiveFields] }
      : {}),
  });
  redactorCache.set(key, redactor);
  return redactor;
}

// ---------------------------------------------------------------------------
// Payload processing status — tracks what actually happened to the payload
// ---------------------------------------------------------------------------

/** Describes the actual processing applied to a payload. */
export type PayloadStatus =
  | "redacted"
  | "unredacted"
  | "structure_only"
  | "truncated_redacted"
  | "truncated_unredacted";

/** Result of payload processing — includes both data and status for accurate prompt notes. */
export interface RedactedPayload {
  readonly data: JsonObject | undefined;
  readonly status: PayloadStatus;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely serialize data, returning undefined on failure (circular refs, BigInt).
 */
function safeStringify(data: JsonObject): string | undefined {
  try {
    return JSON.stringify(data);
  } catch {
    return undefined;
  }
}

/**
 * Truncate a serialized string and wrap in metadata envelope.
 */
function truncateSerialized(serialized: string): JsonObject {
  return {
    _truncated: true,
    _originalSize: serialized.length,
    _maxSize: MAX_RAW_PAYLOAD_SIZE,
    _notice: "Payload exceeded size limit and was truncated. Inspect available content carefully.",
    _content: serialized.slice(0, MAX_RAW_PAYLOAD_SIZE),
  } as unknown as JsonObject;
}

/**
 * Apply secret redaction to event data using `@koi/redaction`.
 *
 * Returns the processed data AND a status describing what was actually done,
 * so the caller can render an accurate prompt note.
 *
 * Processing order:
 * 1. Redact secrets (unless config.enabled === false)
 * 2. Serialize the result
 * 3. Truncate if oversized (truncation always operates on already-redacted data)
 *
 * Non-serializable data (circular refs, BigInt) falls back to structure-only.
 */
export function redactEventData(
  data: JsonObject | undefined,
  config: HookRedactionConfig | undefined,
): RedactedPayload {
  if (data === undefined) return { data: undefined, status: "redacted" };

  // Step 1: Redact secrets (unless explicitly disabled)
  const redactionEnabled = config?.enabled !== false;

  // Non-serializable check on raw data — if we can't even stringify the input,
  // fall back to structure-only (safe, never contains raw values)
  const rawSerialized = safeStringify(data);
  if (rawSerialized === undefined) {
    return { data: extractStructure(data), status: "structure_only" };
  }

  if (!redactionEnabled) {
    // No redaction — but still enforce size limit
    if (rawSerialized.length > MAX_RAW_PAYLOAD_SIZE) {
      return { data: truncateSerialized(rawSerialized), status: "truncated_unredacted" };
    }
    return { data, status: "unredacted" };
  }

  // Apply redaction
  const strategy = config?.censor ?? "redact";
  const redactor = getRedactor(strategy, config?.sensitiveFields);
  const result = redactor.redactObject(data);

  // Step 2: Serialize the REDACTED result
  const redactedSerialized = safeStringify(result.value);
  if (redactedSerialized === undefined) {
    // Redacted result can't be serialized — fall back to structure
    return { data: extractStructure(data), status: "structure_only" };
  }

  // Step 3: Truncate if oversized (operating on already-redacted data)
  if (redactedSerialized.length > MAX_RAW_PAYLOAD_SIZE) {
    return { data: truncateSerialized(redactedSerialized), status: "truncated_redacted" };
  }

  return { data: result.value, status: "redacted" };
}
