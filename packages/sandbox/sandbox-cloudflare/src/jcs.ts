/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) — minimal implementation.
 *
 * Produces a byte-identical canonical UTF-8 string for two semantically-equal
 * JSON values. Used by `computeDedupeFingerprint` so retries with different
 * key orderings collide on the same dedupe record.
 *
 * Rules implemented:
 *   - Object keys sorted by code-point order.
 *   - Numbers serialised per ES6 `Number.prototype.toString` (excluding NaN/±∞,
 *     which RFC 8785 forbids — caller must validate).
 *   - Strings UTF-16 → UTF-8 with the JSON escape rules from RFC 8785 §3.2.2.5.
 *   - No whitespace. No trailing zeros. No `+0`/`-0` distinction.
 */

const HEX = "0123456789abcdef";

const escapeString = (s: string): string => {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x09) out += "\\t";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0d) out += "\\r";
    else if (c < 0x20) {
      out += `\\u00${HEX[(c >> 4) & 0xf]}${HEX[c & 0xf]}`;
    } else {
      out += s[i];
    }
  }
  out += '"';
  return out;
};

const canonicalNumber = (n: number): string => {
  if (!Number.isFinite(n)) {
    throw new TypeError(`JCS: non-finite number cannot be canonicalised (${n})`);
  }
  // ES6 Number.prototype.toString is the JCS-mandated form; -0 must be "0".
  if (Object.is(n, -0)) return "0";
  return String(n);
};

export const jcsCanonicalise = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return canonicalNumber(value);
  if (typeof value === "string") return escapeString(value);
  if (Array.isArray(value)) {
    let s = "[";
    for (let i = 0; i < value.length; i++) {
      if (i > 0) s += ",";
      s += jcsCanonicalise(value[i]);
    }
    s += "]";
    return s;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    let s = "{";
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) s += ",";
      const k = keys[i] as string;
      s += `${escapeString(k)}:${jcsCanonicalise(obj[k])}`;
    }
    s += "}";
    return s;
  }
  throw new TypeError(`JCS: unsupported value type (${typeof value})`);
};
