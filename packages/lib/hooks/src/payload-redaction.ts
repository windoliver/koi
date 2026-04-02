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

/**
 * Safely compute the serialized size of data, returning -1 on failure
 * (circular refs, BigInt, etc.).
 */
function safeSerializedSize(data: JsonObject): number {
  try {
    return JSON.stringify(data).length;
  } catch {
    return -1;
  }
}

/**
 * Truncate a serialized JSON string to fit within the size limit,
 * preserving as much inspectable content as possible.
 */
function truncatePayload(data: JsonObject): JsonObject {
  const serialized = JSON.stringify(data);
  const truncated = serialized.slice(0, MAX_RAW_PAYLOAD_SIZE);
  return {
    _truncated: true,
    _originalSize: serialized.length,
    _maxSize: MAX_RAW_PAYLOAD_SIZE,
    _notice: "Payload exceeded size limit and was truncated. Inspect available content carefully.",
    _content: truncated,
  } as unknown as JsonObject;
}

/**
 * Apply secret redaction to event data using `@koi/redaction`.
 * Returns a copy with detected secrets masked according to the censor strategy.
 *
 * When `config.enabled` is explicitly false, returns the data unchanged
 * (but oversized payloads are still truncated with an explicit notice).
 *
 * When the payload cannot be serialized (circular refs, BigInt), or exceeds
 * MAX_RAW_PAYLOAD_SIZE, the payload is truncated with metadata rather than
 * silently degraded to structure-only — preserving inspectable content for
 * content-based hook policies.
 */
export function redactEventData(
  data: JsonObject | undefined,
  config: HookRedactionConfig | undefined,
): JsonObject | undefined {
  if (data === undefined) return undefined;

  // Size guard applies regardless of redaction setting.
  // Non-serializable data (circular, BigInt) gets truncated with notice.
  const size = safeSerializedSize(data);
  if (size === -1) {
    // Cannot serialize — truncate the structural summary as fallback
    return {
      _truncated: true,
      _notice: "Payload could not be serialized (circular reference or unsupported type).",
      _structure: extractStructure(data),
    } as unknown as JsonObject;
  }
  if (size > MAX_RAW_PAYLOAD_SIZE) {
    return truncatePayload(data);
  }

  // Opt-out: explicit disable bypasses secret redaction (size already checked)
  if (config?.enabled === false) return data;

  const strategy = config?.censor ?? "redact";
  const redactor = getRedactor(strategy, config?.sensitiveFields);
  const result = redactor.redactObject(data);

  return result.value;
}
