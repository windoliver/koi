/**
 * URL policy — blocks SSRF targets (private IPs, metadata endpoints, localhost).
 *
 * Limitation: checks are string-based pattern matching on the URL. This does NOT
 * protect against DNS rebinding attacks where a domain initially resolves to a
 * public IP (passing the check) then rebinds to a private IP during the actual
 * fetch. A full mitigation would require pre-flight DNS resolution and IP
 * validation, which is not implemented here.
 */

// ---------------------------------------------------------------------------
// Blocked URL patterns (SSRF mitigation)
// ---------------------------------------------------------------------------

const BLOCKED_PATTERNS: readonly RegExp[] = [
  // Localhost variants
  /^https?:\/\/localhost(?:[:/]|$)/i,
  /^https?:\/\/127\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:[:/]|$)/,
  // Private RFC 1918 ranges
  /^https?:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:[:/]|$)/,
  /^https?:\/\/172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(?:[:/]|$)/,
  /^https?:\/\/192\.168\.\d{1,3}\.\d{1,3}(?:[:/]|$)/,
  // Link-local (AWS/GCP/Azure metadata)
  /^https?:\/\/169\.254\.\d{1,3}\.\d{1,3}(?:[:/]|$)/,
  // IPv6 loopback
  /^https?:\/\/\[?::1\]?(?:[:/]|$)/i,
  // IPv6 link-local (fe80::/10)
  /^https?:\/\/\[fe[89ab][0-9a-f]:/i,
  // IPv6 unique local addresses (fc00::/7 — fc00::/8 + fd00::/8)
  /^https?:\/\/\[f[cd][0-9a-f]{2}:/i,
  // IPv6 unspecified address
  /^https?:\/\/\[?::\]?(?:[:/]|$)/i,
  // Unspecified address
  /^https?:\/\/0\.0\.0\.0(?:[:/]|$)/,
  // Numeric IPv4 (decimal integer form, e.g. http://2130706433/ = 127.0.0.1)
  /^https?:\/\/\d{8,10}(?:[:/]|$)/,
  // Octal IPv4 (e.g. http://0177.0.0.1/ = 127.0.0.1)
  /^https?:\/\/0\d+\./,
  // Hex IPv4 (e.g. http://0x7f.0.0.1/ = 127.0.0.1)
  /^https?:\/\/0x[0-9a-f]+/i,
  // Kubernetes internal services
  /^https?:\/\/[^/]*\.internal(?:[:/]|$)/i,
  /^https?:\/\/[^/]*\.local(?:[:/]|$)/i,
];

/**
 * Check if a URL targets a private/internal address that should be blocked.
 *
 * Returns `true` if the URL should be **blocked** (i.e., it is an SSRF target).
 */
export function isBlockedUrl(url: string): boolean {
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(url));
}
