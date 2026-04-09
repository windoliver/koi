/**
 * Header validation for HTTP hooks.
 *
 * Rejects headers containing control characters (CRLF/NUL) rather than
 * silently stripping them — fail-closed prevents silent mutation of
 * auth tokens or signing keys after env-var expansion.
 *
 * Also blocks reserved headers that could interfere with SSRF pinning
 * or HTTP framing.
 */

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\r\n\0]/;

/** Headers reserved for the SSRF layer or HTTP framing — must not be set by hook configs. */
export const RESERVED_HEADER_NAMES: ReadonlySet<string> = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
]);

/**
 * Returns true if the header value is safe (no CRLF or NUL bytes).
 */
export function validateHeaderValue(value: string): boolean {
  return !CONTROL_CHAR_PATTERN.test(value);
}

/**
 * Validate all values in a header record.
 * Returns undefined on success, or an error message naming the first offending key.
 */
export function validateHeaders(headers: Readonly<Record<string, string>>): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (!validateHeaderValue(key)) {
      return `header name "${key}" contains control characters (CR/LF/NUL)`;
    }
    if (!validateHeaderValue(value)) {
      return `header "${key}" value contains control characters (CR/LF/NUL)`;
    }
  }
  return undefined;
}

/**
 * Check whether any header name is reserved (case-insensitive).
 * Returns undefined on success, or an error message naming the offending header.
 */
export function checkReservedHeaders(
  headers: Readonly<Record<string, string>>,
): string | undefined {
  for (const key of Object.keys(headers)) {
    if (RESERVED_HEADER_NAMES.has(key.toLowerCase())) {
      return `header "${key}" is reserved and cannot be set by hook configs`;
    }
  }
  return undefined;
}
