/**
 * URL policy — blocks SSRF targets (private IPs, metadata endpoints, localhost).
 *
 * Two layers of defense:
 * 1. `isBlockedUrl()` — fast string-based pattern matching on the URL (first pass).
 * 2. `resolveAndValidateUrl()` — pre-flight DNS resolution + IP validation to mitigate
 *    DNS rebinding attacks where a domain initially resolves to a public IP (passing
 *    the string check) then rebinds to a private IP during the actual fetch.
 */

// ---------------------------------------------------------------------------
// Blocked URL patterns (SSRF mitigation — first pass, string-based)
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

// ---------------------------------------------------------------------------
// Blocked IP patterns (SSRF mitigation — second pass, resolved IP-based)
// ---------------------------------------------------------------------------

/**
 * IPv4 private/reserved CIDR ranges that must be blocked.
 * Each entry: [networkBigInt, maskBigInt].
 */
const BLOCKED_IPV4_CIDRS: readonly (readonly [bigint, bigint])[] = [
  /* 127.0.0.0/8   — loopback      */ [0x7F000000n, 0xFF000000n],
  /* 10.0.0.0/8    — RFC 1918      */ [0x0A000000n, 0xFF000000n],
  /* 172.16.0.0/12 — RFC 1918      */ [0xAC100000n, 0xFFF00000n],
  /* 192.168.0.0/16 — RFC 1918     */ [0xC0A80000n, 0xFFFF0000n],
  /* 169.254.0.0/16 — link-local   */ [0xA9FE0000n, 0xFFFF0000n],
  /* 0.0.0.0/8     — unspecified   */ [0x00000000n, 0xFF000000n],
];

/**
 * IPv6 private/reserved prefixes that must be blocked (lowercase).
 * fc00::/7 covers both fc00::/8 and fd00::/8.
 */
const BLOCKED_IPV6_PREFIXES: readonly string[] = [
  "fe80", // link-local (fe80::/10)
  "fc",   // unique local fc00::/8 (part of fc00::/7)
  "fd",   // unique local fd00::/8 (part of fc00::/7)
];

/**
 * Parse a dotted-decimal IPv4 string to a 32-bit bigint, or `undefined` if invalid.
 */
function parseIpv4ToBigInt(ip: string): bigint | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let result = 0n;
  for (const part of parts) {
    const num = Number(part);
    if (!Number.isInteger(num) || num < 0 || num > 255) return undefined;
    result = (result << 8n) | BigInt(num);
  }
  return result;
}

/**
 * Check if a resolved IP address is in a private/reserved range.
 *
 * Handles both IPv4 (dotted decimal) and IPv6 (colon-hex) addresses.
 * Returns `true` if the IP should be **blocked**.
 */
export function isBlockedIp(ip: string): boolean {
  // IPv4 check
  if (ip.includes(".") && !ip.includes(":")) {
    const ipBigInt = parseIpv4ToBigInt(ip);
    if (ipBigInt === undefined) return true; // Unparseable IP — block defensively
    return BLOCKED_IPV4_CIDRS.some(
      ([network, mask]) => (ipBigInt & mask) === network,
    );
  }

  // IPv6 check
  const normalized = ip.toLowerCase();

  // Exact match for loopback
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;

  // Unspecified address
  if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") return true;

  // Prefix-based checks (fe80, fc, fd)
  for (const prefix of BLOCKED_IPV6_PREFIXES) {
    if (normalized.startsWith(prefix)) return true;
  }

  // IPv4-mapped IPv6 (::ffff:x.x.x.x) — extract and check the IPv4 part
  const v4MappedMatch = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(normalized);
  if (v4MappedMatch?.[1] !== undefined) {
    return isBlockedIp(v4MappedMatch[1]);
  }

  // If we reach here, it looks like a valid public IPv6 address
  // (contains colons but is not in any blocked range)
  if (normalized.includes(":")) return false;

  // Unrecognizable format — block defensively
  return true;
}

// ---------------------------------------------------------------------------
// DNS resolver type (injectable for testing)
// ---------------------------------------------------------------------------

/**
 * Function that resolves a hostname to IP address strings. Injectable so
 * tests can provide a mock without hitting real DNS.
 */
export type DnsResolverFn = (hostname: string) => Promise<readonly string[]>;

/**
 * Default DNS resolver using Bun's built-in DNS lookup API.
 * Resolves IPv4 addresses (family: 4).
 */
export const defaultDnsResolver: DnsResolverFn = async (
  hostname: string,
): Promise<readonly string[]> => {
  const results = await Bun.dns.lookup(hostname, { family: 4 });
  return results.map((r) => r.address);
};

// ---------------------------------------------------------------------------
// DNS resolution + validation (second pass)
// ---------------------------------------------------------------------------

/** Successful resolution result. */
interface ResolvedUrl {
  readonly blocked: false;
  readonly hostname: string;
  readonly ip: string;
}

/** Blocked resolution result. */
interface BlockedUrl {
  readonly blocked: true;
  readonly reason: string;
}

export type DnsValidationResult = ResolvedUrl | BlockedUrl;

/**
 * Resolve a URL's hostname via DNS and validate the resolved IP against
 * private/reserved ranges. This is the second layer of SSRF defense that
 * mitigates DNS rebinding attacks.
 *
 * Side-effect: performs DNS resolution via the provided resolver (default: `Bun.dns.resolve`).
 */
export async function resolveAndValidateUrl(
  url: string,
  resolver: DnsResolverFn = defaultDnsResolver,
): Promise<DnsValidationResult> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { blocked: true, reason: `Invalid URL: ${url}` };
  }

  // Skip DNS for raw IP addresses — validate directly
  if (isIpLiteral(hostname)) {
    // Strip brackets from IPv6 literals (URL parser keeps them)
    const bareIp = hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
    if (isBlockedIp(bareIp)) {
      return { blocked: true, reason: `Resolved IP ${bareIp} is in a private/reserved range` };
    }
    return { blocked: false, hostname, ip: bareIp };
  }

  try {
    const addresses: readonly string[] = await resolver(hostname);
    if (addresses.length === 0) {
      return { blocked: true, reason: `DNS resolution returned no addresses for ${hostname}` };
    }

    // Check ALL resolved IPs — block if any is private
    for (const ip of addresses) {
      if (isBlockedIp(ip)) {
        return {
          blocked: true,
          reason: `Resolved IP ${ip} for ${hostname} is in a private/reserved range`,
        };
      }
    }

    // Return the first address (the one most likely to be used)
    const firstIp = addresses[0];
    if (firstIp === undefined) {
      return { blocked: true, reason: `DNS resolution returned no addresses for ${hostname}` };
    }
    return { blocked: false, hostname, ip: firstIp };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { blocked: true, reason: `DNS resolution failed for ${hostname}: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a hostname is a raw IP literal (IPv4 dotted-decimal or IPv6 bracket notation).
 */
function isIpLiteral(hostname: string): boolean {
  // IPv4: all digits and dots
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  // IPv6: bracketed or contains colons
  if (hostname.startsWith("[") || hostname.includes(":")) return true;
  return false;
}
