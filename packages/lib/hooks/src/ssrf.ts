/**
 * DNS-level SSRF protection for HTTP hooks.
 *
 * Validates resolved IPs against blocked ranges to prevent DNS rebinding
 * attacks. Adapted from @koi/tools-web url-policy.ts with one key
 * difference: narrow loopback (127.0.0.1, ::1) is ALLOWED for dev hooks.
 *
 * Defense layers:
 * 1. URL string validation (hook-validation.ts — HTTPS/loopback policy)
 * 2. DNS resolution + IP validation (this module)
 * 3. IP pinning for HTTP (rewrites URL to resolved IP + Host header)
 * 4. Redirect blocking (executor.ts — `redirect: "error"`)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Injectable DNS resolver — returns all resolved IPs for a hostname. */
export type DnsResolverFn = (hostname: string) => Promise<readonly string[]>;

interface ResolvedUrl {
  readonly blocked: false;
  readonly hostname: string;
  readonly ip: string;
}

interface BlockedUrl {
  readonly blocked: true;
  readonly reason: string;
}

/** Result of DNS resolution + IP validation. */
export type DnsValidationResult = ResolvedUrl | BlockedUrl;

/** IP-pinned fetch target with original Host header. */
export interface PinnedUrl {
  readonly url: string;
  readonly hostHeader: string;
}

// ---------------------------------------------------------------------------
// Blocked IP ranges (CIDR as bigint network/mask pairs)
// ---------------------------------------------------------------------------

/**
 * Blocked IPv4 CIDR ranges. Loopback (127.0.0.0/8) is intentionally
 * absent — narrow loopback (127.0.0.1, ::1 only) is handled separately
 * so dev hooks can reach local policy servers.
 */
const BLOCKED_IPV4_CIDRS: readonly (readonly [bigint, bigint])[] = [
  [0x00000000n, 0xff000000n], // 0.0.0.0/8       "this" network
  [0x0a000000n, 0xff000000n], // 10.0.0.0/8       private
  [0x64400000n, 0xffc00000n], // 100.64.0.0/10    CGNAT (RFC 6598)
  [0xa9fe0000n, 0xffff0000n], // 169.254.0.0/16   link-local / cloud metadata
  [0xac100000n, 0xfff00000n], // 172.16.0.0/12    private
  [0xc0a80000n, 0xffff0000n], // 192.168.0.0/16   private
  [0xc0000200n, 0xffffff00n], // 192.0.2.0/24     TEST-NET-1
  [0xc6336400n, 0xffffff00n], // 198.51.100.0/24  TEST-NET-2
  [0xcb007100n, 0xffffff00n], // 203.0.113.0/24   TEST-NET-3
  [0xc6120000n, 0xfffe0000n], // 198.18.0.0/15    benchmarking
  [0xffffffffn, 0xffffffffn], // 255.255.255.255  broadcast
];

const BLOCKED_IPV6_PREFIXES: readonly string[] = ["fc", "fd"];

// ---------------------------------------------------------------------------
// IPv4 parsing
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// IP validation
// ---------------------------------------------------------------------------

/**
 * Check whether an IP is in a blocked range.
 *
 * Narrow loopback is allowed: exactly `127.0.0.1` and `::1`.
 * All other loopback IPs (127.0.0.2, etc.) are blocked to prevent
 * manifest-driven probing of services bound on other loopback addresses.
 */
export function isBlockedHookIp(ip: string): boolean {
  // Strip IPv6 zone ID (e.g., "fe80::1%eth0" → "fe80::1") before validation.
  // Zone IDs can cause regex bypasses for IPv4-mapped addresses.
  const zoneIdx = ip.indexOf("%");
  const cleanIp = zoneIdx >= 0 ? ip.slice(0, zoneIdx) : ip;

  // IPv4
  if (cleanIp.includes(".") && !cleanIp.includes(":")) {
    // Allow exactly 127.0.0.1
    if (cleanIp === "127.0.0.1") return false;
    // Block rest of 127.0.0.0/8
    if (cleanIp.startsWith("127.")) return true;
    const ipBigInt = parseIpv4ToBigInt(cleanIp);
    if (ipBigInt === undefined) return true; // Unparseable → block
    return BLOCKED_IPV4_CIDRS.some(([network, mask]) => (ipBigInt & mask) === network);
  }

  // IPv6
  const normalized = cleanIp.toLowerCase();

  // Allow exactly ::1
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return false;

  // Block unspecified
  if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") return true;

  // Block link-local fe80::/10
  if (/^fe[89ab]/.test(normalized)) return true;

  // Block unique local fc00::/7
  for (const prefix of BLOCKED_IPV6_PREFIXES) {
    if (normalized.startsWith(prefix)) return true;
  }

  // Block NAT64 well-known prefix (64:ff9b::/96, RFC 6052) — DNS64 can
  // synthesize AAAA records that embed private IPv4 addresses.
  if (normalized.startsWith("64:ff9b:")) return true;

  // IPv4-mapped IPv6 — dotted decimal form (::ffff:a.b.c.d)
  const v4MappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(normalized);
  if (v4MappedDotted?.[1] !== undefined) return isBlockedHookIp(v4MappedDotted[1]);

  // IPv4-mapped IPv6 — hex form (::ffff:XXXX:YYYY or expanded with leading zeros)
  const v4MappedHex =
    /^(?:::ffff|0{1,4}:0{1,4}:0{1,4}:0{1,4}:0{1,4}:ffff):([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(
      normalized,
    );
  if (v4MappedHex?.[1] !== undefined && v4MappedHex?.[2] !== undefined) {
    const high = parseInt(v4MappedHex[1], 16);
    const low = parseInt(v4MappedHex[2], 16);
    const ipv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
    return isBlockedHookIp(ipv4);
  }

  // IPv4-compatible IPv6 — dotted form (::a.b.c.d, deprecated but still accepted)
  const v4CompatDotted = /^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(normalized);
  if (v4CompatDotted?.[1] !== undefined) return isBlockedHookIp(v4CompatDotted[1]);

  // IPv4-compatible IPv6 — hex form (::XXXX:YYYY, deprecated)
  const v4CompatHex = /^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (v4CompatHex?.[1] !== undefined && v4CompatHex?.[2] !== undefined) {
    const high = parseInt(v4CompatHex[1], 16);
    const low = parseInt(v4CompatHex[2], 16);
    const ipv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
    return isBlockedHookIp(ipv4);
  }

  // 6to4 (2002::/16, RFC 3056) — IPv4 embedded in bits 16-47.
  // Extract and validate the embedded IPv4 address.
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})/.exec(normalized);
  if (sixToFour?.[1] !== undefined && sixToFour?.[2] !== undefined) {
    const high = parseInt(sixToFour[1], 16);
    const low = parseInt(sixToFour[2], 16);
    const ipv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
    return isBlockedHookIp(ipv4);
  }

  // Unknown IPv6 with colons — allow (public)
  if (normalized.includes(":")) return false;

  // No colons, no dots — unparseable → block
  return true;
}

// ---------------------------------------------------------------------------
// IP literal detection
// ---------------------------------------------------------------------------

function isIpLiteral(hostname: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  if (hostname.startsWith("[") || hostname.includes(":")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// DNS resolution + validation
// ---------------------------------------------------------------------------

/**
 * Resolve a hook URL's hostname and validate all resolved IPs.
 * Returns the first valid IP or a blocked result with reason.
 *
 * IP literals are validated directly without DNS resolution.
 */
export async function resolveAndValidateHookUrl(
  url: string,
  resolver: DnsResolverFn,
): Promise<DnsValidationResult> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { blocked: true, reason: `Invalid URL: ${url}` };
  }

  // IP literal — validate directly, no DNS
  if (isIpLiteral(hostname)) {
    const bareIp =
      hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    if (isBlockedHookIp(bareIp)) {
      return { blocked: true, reason: `IP ${bareIp} is in a private/reserved range` };
    }
    return { blocked: false, hostname, ip: bareIp };
  }

  // DNS resolution
  try {
    const addresses = await resolver(hostname);
    if (addresses.length === 0) {
      return { blocked: true, reason: `DNS resolution returned no addresses for ${hostname}` };
    }
    // Validate ALL resolved IPs — block if any is private
    for (const ip of addresses) {
      if (isBlockedHookIp(ip)) {
        return {
          blocked: true,
          reason: `${hostname} resolves to ${ip} (private/reserved range)`,
        };
      }
    }
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
// IP pinning (HTTP only)
// ---------------------------------------------------------------------------

/**
 * Rewrite an HTTP URL to connect to a specific resolved IP.
 * Returns undefined for HTTPS — Bun's TLS SNI behavior with IP URLs
 * is unverified, so HTTPS hooks accept a small TOCTOU window mitigated
 * by redirect blocking and the HTTPS-only default policy.
 */
export function pinResolvedIp(originalUrl: string, resolvedIp: string): PinnedUrl | undefined {
  let parsed: URL;
  try {
    parsed = new URL(originalUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:") return undefined;
  const hostHeader = parsed.host;
  parsed.hostname = resolvedIp.includes(":") ? `[${resolvedIp}]` : resolvedIp;
  return { url: parsed.href, hostHeader };
}

// ---------------------------------------------------------------------------
// Default DNS resolver (Bun)
// ---------------------------------------------------------------------------

/**
 * Default DNS resolver using Bun.dns.lookup.
 * Returns all resolved addresses (IPv4 + IPv6).
 */
export async function defaultHookDnsResolver(hostname: string): Promise<readonly string[]> {
  const results = await Bun.dns.lookup(hostname, { family: 0 });
  return results.map((r) => r.address);
}
