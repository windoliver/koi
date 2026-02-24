/**
 * URL security validation for browser navigation tools.
 *
 * Provides runtime SSRF protection for browser_navigate and browser_tab_new:
 *   - Protocol allowlist (default: https: and http: only)
 *   - Private IP blocking: RFC 1918, loopback, link-local, cloud metadata
 *   - IPv6 private range blocking: loopback (::1), link-local (fe80::/10),
 *     unique-local (fc00::/7), IPv4-mapped (::ffff:0:0/96), 6to4 (2002::/16)
 *   - Encoded IP bypass detection: decimal, hex, octal representations
 *   - Domain allowlist with exact and wildcard (*.example.com) matching
 *
 * NOTE: This is static URL analysis only. DNS rebinding attacks — where a
 * domain initially resolves to a safe IP but later re-resolves to a private
 * IP after the browser makes its request — are NOT mitigated by this check.
 * Full DNS rebinding protection requires network-level controls or
 * post-resolution IP validation in the browser driver (e.g., via Playwright's
 * page.route() interception with dns.lookup() verification).
 */

import type { JsonObject } from "@koi/core";

// ---------------------------------------------------------------------------
// Public configuration types
// ---------------------------------------------------------------------------

export interface NavigationSecurityConfig {
  /**
   * Allowed URL protocols. Default: ["https:", "http:"]
   * To restrict to HTTPS only: ["https:"]
   * Protocol strings must include the trailing colon (e.g. "https:").
   */
  readonly allowedProtocols?: readonly string[];

  /**
   * Domain allowlist. Supports exact matches ("example.com") and wildcard
   * subdomain matching ("*.example.com"). If undefined or empty, all
   * non-blocked domains are permitted.
   */
  readonly allowedDomains?: readonly string[];

  /**
   * Block private, loopback, link-local, and cloud metadata addresses.
   * Default: true. Set to false only in trusted local environments.
   */
  readonly blockPrivateAddresses?: boolean;
}

/**
 * Pre-compiled security configuration for efficient per-call validation.
 * Create once via compileNavigationSecurity() at provider construction time.
 */
export interface CompiledNavigationSecurity {
  readonly allowedProtocols: ReadonlySet<string>;
  /** Exact domain matches (lowercase). undefined = no domain restriction. */
  readonly exactDomains: ReadonlySet<string> | undefined;
  /** Compiled wildcard patterns for *.example.com style matching. */
  readonly wildcardPatterns: readonly RegExp[];
  readonly blockPrivateAddresses: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PROTOCOLS: ReadonlySet<string> = new Set(["https:", "http:"]);

/** Cloud metadata services — highest-priority SSRF targets. */
const CLOUD_METADATA_HOSTS: ReadonlySet<string> = new Set([
  "169.254.169.254", // AWS / GCP / Azure / DigitalOcean IPv4 IMDS
  "fd00:ec2::254", // AWS IPv6 IMDS (Nitro instances)
  "metadata.google.internal", // GCP metadata
  "169.254.169.123", // AWS time sync service
  "100.100.100.200", // Alibaba Cloud ECS metadata
]);

/** Loopback hostnames (complementing the 127.x IP range check). */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "0.0.0.0"]);

// ---------------------------------------------------------------------------
// IPv4 classification helpers
// ---------------------------------------------------------------------------

function isLoopbackIpv4(host: string): boolean {
  return /^127\./.test(host);
}

function isLinkLocalIpv4(host: string): boolean {
  // 169.254.0.0/16 — APIPA / link-local
  return /^169\.254\./.test(host);
}

function isPrivateRfc1918(host: string): boolean {
  if (/^10\./.test(host)) return true;
  const m = /^172\.(\d+)\./.exec(host);
  if (m !== null) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return true;
  }
  return /^192\.168\./.test(host);
}

// ---------------------------------------------------------------------------
// Encoded IP bypass detection (decimal, hex, octal representations)
// ---------------------------------------------------------------------------

function decimalToIp(host: string): string | undefined {
  if (!/^\d+$/.test(host)) return undefined;
  const n = Number(host);
  if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return undefined;
  return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
}

function hexToIp(host: string): string | undefined {
  if (!/^0x[0-9a-f]+$/i.test(host)) return undefined;
  const n = Number(host);
  if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return undefined;
  return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
}

function octalToIp(host: string): string | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const hasOctal = parts.some((p) => p.length > 1 && p.startsWith("0") && /^0[0-7]+$/.test(p));
  if (!hasOctal) return undefined;
  const octets = parts.map((p) =>
    p.length > 1 && p.startsWith("0") ? Number.parseInt(p, 8) : Number.parseInt(p, 10),
  );
  if (octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return undefined;
  return octets.join(".");
}

// ---------------------------------------------------------------------------
// IPv6 classification helpers
// ---------------------------------------------------------------------------

/** Strip brackets from URL-parsed IPv6: "[::1]" → "::1". */
function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** Parse the first 16-bit group of a compressed IPv6 address. */
function firstIpv6Group(raw: string): number | undefined {
  const first = raw.split(":")[0];
  if (first === undefined || first === "") return 0; // leading :: means first group is 0
  const n = Number.parseInt(first, 16);
  return Number.isNaN(n) ? undefined : n;
}

function isIpv6Loopback(raw: string): boolean {
  return raw === "::1" || raw === "0:0:0:0:0:0:0:1";
}

function isIpv6LinkLocal(raw: string): boolean {
  // fe80::/10 — top 10 bits are 1111111010
  const n = firstIpv6Group(raw);
  if (n === undefined) return false;
  return (n & 0xffc0) === 0xfe80;
}

function isIpv6UniqueLocal(raw: string): boolean {
  // fc00::/7 — top 7 bits are 1111110x (covers fc00:: through fdff::)
  const n = firstIpv6Group(raw);
  if (n === undefined) return false;
  return (n & 0xfe00) === 0xfc00;
}

function isIpv4MappedIpv6(raw: string): boolean {
  // ::ffff:0:0/96 — covers both dotted-quad and hex forms
  return raw.startsWith("::ffff:") || raw.startsWith("0:0:0:0:0:ffff:");
}

function isTeredo(raw: string): boolean {
  // 2001:0000::/32 — Teredo tunneling (IPv6-over-UDP through NATs, embeds arbitrary IPv4)
  // First group must be 0x2001, second must be 0x0000.
  // Normalized forms: "2001:0:" / "2001:0000:" / "2001::" (when second group is also 0)
  const parts = raw.split(":");
  if (parts[0]?.toLowerCase() !== "2001") return false;
  const second = parts[1]?.toLowerCase();
  return second === "0" || second === "0000" || second === "" || second === undefined;
}

/**
 * Extract the embedded IPv4 from a 6to4 address (2002::/16).
 * Groups 1+2 encode the IPv4: 2002:XXYY:AABB:: → XX.YY.AA.BB
 */
function extract6to4Ipv4(raw: string): string | undefined {
  if (!raw.startsWith("2002:")) return undefined;
  const parts = raw.split(":");
  const g1Str = parts[1];
  const g2Str = parts[2];
  if (!g1Str || !g2Str) return undefined;
  const g1 = Number.parseInt(g1Str.padStart(4, "0"), 16);
  const g2 = Number.parseInt(g2Str.padStart(4, "0"), 16);
  if (Number.isNaN(g1) || Number.isNaN(g2)) return undefined;
  return `${(g1 >>> 8) & 0xff}.${g1 & 0xff}.${(g2 >>> 8) & 0xff}.${g2 & 0xff}`;
}

// ---------------------------------------------------------------------------
// Host classification
// ---------------------------------------------------------------------------

interface BlockedReason {
  readonly category: string;
  readonly guidance: string;
}

function classifyIpv4(host: string): BlockedReason | undefined {
  if (CLOUD_METADATA_HOSTS.has(host)) {
    return {
      category: `cloud metadata endpoint (${host})`,
      guidance: "This address serves instance metadata that may contain credentials.",
    };
  }
  if (isLoopbackIpv4(host) || LOOPBACK_HOSTNAMES.has(host)) {
    return {
      category: `loopback address (${host})`,
      guidance: "This address refers to the local machine.",
    };
  }
  if (isLinkLocalIpv4(host)) {
    return {
      category: `link-local address (${host}, RFC 3927)`,
      guidance: "This is a special-purpose local network range.",
    };
  }
  if (isPrivateRfc1918(host)) {
    return {
      category: `private network address (${host}, RFC 1918)`,
      guidance: "This address is on a private internal network.",
    };
  }
  return undefined;
}

function classifyHost(host: string): BlockedReason | undefined {
  const lower = host.toLowerCase();

  // Direct cloud metadata hostname check (covers fd00:ec2::254, metadata.google.internal)
  if (CLOUD_METADATA_HOSTS.has(lower)) {
    return {
      category: `cloud metadata endpoint (${lower})`,
      guidance: "This address serves instance metadata that may contain credentials.",
    };
  }

  if (LOOPBACK_HOSTNAMES.has(lower)) {
    return {
      category: `loopback address (${lower})`,
      guidance: "This address refers to the local machine.",
    };
  }

  // IPv6 — URL parser returns hostnames with brackets; strip before classification
  const raw = stripIpv6Brackets(lower);

  if (raw.includes(":")) {
    // IPv6 address
    if (isIpv6Loopback(raw)) {
      return {
        category: "IPv6 loopback (::1)",
        guidance: "This address refers to the local machine.",
      };
    }
    if (isIpv6LinkLocal(raw)) {
      return {
        category: `IPv6 link-local address (fe80::/10): ${raw}`,
        guidance: "Used for local link communications only.",
      };
    }
    if (isIpv6UniqueLocal(raw)) {
      return {
        category: `IPv6 unique-local address (fc00::/7): ${raw}`,
        guidance:
          "This is a private IPv6 network range (includes cloud metadata like fd00:ec2::254).",
      };
    }
    if (isIpv4MappedIpv6(raw)) {
      return {
        category: `IPv4-mapped IPv6 address (::ffff:0:0/96): ${raw}`,
        guidance: "This embeds an IPv4 address and can bypass IPv4-only SSRF filters.",
      };
    }
    const embedded = extract6to4Ipv4(raw);
    if (embedded !== undefined) {
      const ipv4Result = classifyIpv4(embedded);
      if (ipv4Result !== undefined) {
        return {
          category: `6to4 IPv6 address embedding ${ipv4Result.category}`,
          guidance: ipv4Result.guidance,
        };
      }
    }
    if (isTeredo(raw)) {
      return {
        category: `Teredo tunneling address (2001:0000::/32): ${raw}`,
        guidance:
          "Teredo tunnels IPv6 over UDP and can embed arbitrary IPv4 addresses, bypassing network controls.",
      };
    }
    return undefined; // Global unicast IPv6 — allowed
  }

  // IPv4 dotted-quad or plain hostname
  const directResult = classifyIpv4(lower);
  if (directResult !== undefined) return directResult;

  // Encoded IP bypass detection (decimal, hex, octal representations)
  const decoded = decimalToIp(lower) ?? hexToIp(lower) ?? octalToIp(lower);
  if (decoded !== undefined) {
    const decodedResult = classifyIpv4(decoded);
    if (decodedResult !== undefined) {
      return {
        category: `encoded ${decodedResult.category} — "${lower}" decodes to ${decoded}`,
        guidance: decodedResult.guidance,
      };
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Config compilation
// ---------------------------------------------------------------------------

/** Compile a NavigationSecurityConfig into an efficient runtime form. */
export function compileNavigationSecurity(
  config?: NavigationSecurityConfig,
): CompiledNavigationSecurity {
  const allowedProtocols =
    config?.allowedProtocols !== undefined
      ? (new Set(config.allowedProtocols) as ReadonlySet<string>)
      : DEFAULT_PROTOCOLS;

  const domains = config?.allowedDomains;
  let exactDomains: Set<string> | undefined;
  const wildcardPatterns: RegExp[] = [];

  if (domains !== undefined && domains.length > 0) {
    exactDomains = new Set<string>();
    for (const domain of domains) {
      if (domain.startsWith("*.")) {
        // *.example.com → matches sub.example.com but NOT example.com itself
        const suffix = domain.slice(2).replace(/[.+?^${}()|[\]\\]/g, "\\$&");
        wildcardPatterns.push(new RegExp(`^[^.]+\\.${suffix}$`, "i"));
      } else {
        exactDomains.add(domain.toLowerCase());
      }
    }
  }

  return {
    allowedProtocols,
    exactDomains: exactDomains as ReadonlySet<string> | undefined,
    wildcardPatterns,
    blockPrivateAddresses: config?.blockPrivateAddresses ?? true,
  };
}

// ---------------------------------------------------------------------------
// Security validation
// ---------------------------------------------------------------------------

type SecurityErr = { readonly error: string; readonly code: "VALIDATION" | "PERMISSION" };

function runSecurityChecks(
  url: URL,
  security: CompiledNavigationSecurity,
): SecurityErr | undefined {
  // 1. Protocol allowlist
  if (!security.allowedProtocols.has(url.protocol)) {
    const allowed = [...security.allowedProtocols].join(", ");
    return {
      error:
        `Navigation to "${url.href}" was blocked: protocol "${url.protocol}" is not permitted. ` +
        `Allowed protocols are: ${allowed}. Use an https:// or http:// URL instead.`,
      code: "PERMISSION",
    };
  }

  // 2. Private address / SSRF protection
  if (security.blockPrivateAddresses) {
    const reason = classifyHost(url.hostname);
    if (reason !== undefined) {
      return {
        error:
          `Navigation to "${url.hostname}" was blocked: ${reason.category}. ` +
          `${reason.guidance} ` +
          `The browser tool is restricted to public URLs. If this is intentional, ask the ` +
          `user to add "${url.hostname}" to the browser security allowedDomains configuration.`,
        code: "PERMISSION",
      };
    }
  }

  // 3. Domain allowlist
  const { exactDomains, wildcardPatterns } = security;
  if (exactDomains !== undefined) {
    const hostname = url.hostname.toLowerCase();
    const allowed = exactDomains.has(hostname) || wildcardPatterns.some((re) => re.test(hostname));
    if (!allowed) {
      const examples = [...exactDomains].slice(0, 3).join(", ");
      const hasMore = exactDomains.size > 3;
      return {
        error:
          `Navigation to "${url.hostname}" was blocked: domain is not in the agent's allowlist. ` +
          `Permitted domains include: ${examples}${hasMore ? " (and more)" : ""}. ` +
          `Ask the user to add "${url.hostname}" to the browser allowedDomains configuration if needed.`,
        code: "PERMISSION",
      };
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Public parse-and-validate API (consumed by tool factories)
// ---------------------------------------------------------------------------

/**
 * Parse a required URL string from LLM args and apply security checks.
 * Returns the validated URL string unchanged (not re-serialized).
 */
export function parseSecureUrl(
  args: JsonObject,
  key: string,
  security?: CompiledNavigationSecurity,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly err: SecurityErr } {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, err: { error: `${key} must be a non-empty string`, code: "VALIDATION" } };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      ok: false,
      err: {
        error: `${key} must be a valid absolute URL including a scheme (e.g. https://example.com)`,
        code: "VALIDATION",
      },
    };
  }
  if (security !== undefined) {
    const err = runSecurityChecks(url, security);
    if (err !== undefined) return { ok: false, err };
  }
  return { ok: true, value };
}

/**
 * Parse an optional URL string from LLM args and apply security checks.
 * Returns undefined when the key is absent or the value is an empty string.
 */
export function parseSecureOptionalUrl(
  args: JsonObject,
  key: string,
  security?: CompiledNavigationSecurity,
):
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly err: SecurityErr } {
  const value = args[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") {
    return { ok: false, err: { error: `${key} must be a string`, code: "VALIDATION" } };
  }
  if (value.length === 0) return { ok: true, value: undefined };
  return parseSecureUrl(args, key, security);
}
