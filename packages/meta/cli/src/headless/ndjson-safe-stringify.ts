const LINE_SEPARATORS = /[\u2028\u2029]/g;

/**
 * Serialize `value` as a single NDJSON-safe line.
 *
 * Two hazards we guard against:
 *
 * 1. JSON.stringify throws on circular refs, BigInt, and functions. Tool
 *    outputs come from arbitrary plugins/MCP servers, so a bad payload must
 *    not abort NDJSON emission — we fall back to a redacted placeholder
 *    and preserve the enclosing event shape.
 * 2. U+2028 / U+2029 are legal JSON but break many JS line-splitting parsers
 *    (they're Unicode line terminators). We escape them to \uXXXX.
 *
 * Returns a single line with no trailing newline. Callers append \n.
 */
export function ndjsonSafeStringify(value: unknown): string {
  let raw: string;
  try {
    raw = JSON.stringify(value, bigintAndCircularReplacer());
  } catch (e: unknown) {
    // Final fallback: serialize a redacted envelope so the line is still
    // valid NDJSON and the caller can surface an error to stderr elsewhere.
    raw = JSON.stringify({
      __unserialiable: true,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return raw.replace(LINE_SEPARATORS, (ch) => (ch === "\u2028" ? "\\u2028" : "\\u2029"));
}

/**
 * Replacer that handles BigInt (→ string) and circular references (→
 * "[Circular]") without throwing. Uses a per-call WeakSet so concurrent
 * stringify calls do not leak state between each other.
 */
function bigintAndCircularReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "function") return `[Function: ${value.name || "anonymous"}]`;
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  };
}
