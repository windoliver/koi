/**
 * URL policy — blocks SSRF targets (private IPs, metadata endpoints, localhost).
 *
 * Two layers of defense:
 * 1. `isBlockedUrl()` — fast string-based pattern matching (first pass).
 * 2. `resolveAndValidateUrl()` — pre-flight DNS resolution + IP validation.
 */

const BLOCKED_PATTERNS: readonly RegExp[] = [
  /^https?:\/\/localhost(?:[:/]|$)/i,
  /^https?:\/\/127\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:[:/]|$)/,
  /^https?:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:[:/]|$)/,
  /^https?:\/\/172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(?:[:/]|$)/,
  /^https?:\/\/192\.168\.\d{1,3}\.\d{1,3}(?:[:/]|$)/,
  /^https?:\/\/100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(?:[:/]|$)/,
  /^https?:\/\/169\.254\.\d{1,3}\.\d{1,3}(?:[:/]|$)/,
  /^https?:\/\/192\.0\.2\.\d{1,3}(?:[:/]|$)/,
  /^https?:\/\/198\.51\.100\.\d{1,3}(?:[:/]|$)/,
  /^https?:\/\/203\.0\.113\.\d{1,3}(?:[:/]|$)/,
  /^https?:\/\/198\.(?:18|19)\.\d{1,3}\.\d{1,3}(?:[:/]|$)/,
  /^https?:\/\/255\.255\.255\.255(?:[:/]|$)/,
  /^https?:\/\/\[?::1\]?(?:[:/]|$)/i,
  /^https?:\/\/\[fe[89ab][0-9a-f]:/i,
  /^https?:\/\/\[f[cd][0-9a-f]{2}:/i,
  /^https?:\/\/\[?::\]?(?:[:/]|$)/i,
  /^https?:\/\/0\.0\.0\.0(?:[:/]|$)/,
  /^https?:\/\/\d{8,10}(?:[:/]|$)/,
  /^https?:\/\/0\d+\./,
  /^https?:\/\/0x[0-9a-f]+/i,
  /^https?:\/\/[^/]*\.internal(?:[:/]|$)/i,
  /^https?:\/\/[^/]*\.local(?:[:/]|$)/i,
];

export function isBlockedUrl(url: string): boolean {
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(url));
}

const BLOCKED_IPV4_CIDRS: readonly (readonly [bigint, bigint])[] = [
  [0x7f000000n, 0xff000000n],
  [0x0a000000n, 0xff000000n],
  [0xac100000n, 0xfff00000n],
  [0xc0a80000n, 0xffff0000n],
  [0x64400000n, 0xffc00000n],
  [0xa9fe0000n, 0xffff0000n],
  [0xc0000200n, 0xffffff00n],
  [0xc6336400n, 0xffffff00n],
  [0xcb007100n, 0xffffff00n],
  [0xc6120000n, 0xfffe0000n],
  [0x00000000n, 0xff000000n],
  [0xffffffffn, 0xffffffffn],
];

const BLOCKED_IPV6_PREFIXES: readonly string[] = ["fc", "fd"];

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

export function isBlockedIp(ip: string): boolean {
  if (ip.includes(".") && !ip.includes(":")) {
    const ipBigInt = parseIpv4ToBigInt(ip);
    if (ipBigInt === undefined) return true;
    return BLOCKED_IPV4_CIDRS.some(([network, mask]) => (ipBigInt & mask) === network);
  }
  const normalized = ip.toLowerCase();
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  for (const prefix of BLOCKED_IPV6_PREFIXES) {
    if (normalized.startsWith(prefix)) return true;
  }
  const v4MappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(normalized);
  if (v4MappedDotted?.[1] !== undefined) return isBlockedIp(v4MappedDotted[1]);
  const v4MappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (v4MappedHex?.[1] !== undefined && v4MappedHex?.[2] !== undefined) {
    const high = parseInt(v4MappedHex[1], 16);
    const low = parseInt(v4MappedHex[2], 16);
    const ipv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
    return isBlockedIp(ipv4);
  }
  if (normalized.includes(":")) return false;
  return true;
}

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
export type DnsValidationResult = ResolvedUrl | BlockedUrl;

export async function resolveAndValidateUrl(
  url: string,
  resolver: DnsResolverFn,
): Promise<DnsValidationResult> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { blocked: true, reason: `Invalid URL: ${url}` };
  }
  if (isIpLiteral(hostname)) {
    const bareIp =
      hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    if (isBlockedIp(bareIp)) {
      return { blocked: true, reason: `Resolved IP ${bareIp} is in a private/reserved range` };
    }
    return { blocked: false, hostname, ip: bareIp };
  }
  try {
    const addresses = await resolver(hostname);
    if (addresses.length === 0) {
      return { blocked: true, reason: `DNS resolution returned no addresses for ${hostname}` };
    }
    for (const ip of addresses) {
      if (isBlockedIp(ip)) {
        return {
          blocked: true,
          reason: `Resolved IP ${ip} for ${hostname} is in a private/reserved range`,
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

export interface PinnedUrl {
  readonly url: string;
  readonly hostHeader: string;
}

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

function isIpLiteral(hostname: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  if (hostname.startsWith("[") || hostname.includes(":")) return true;
  return false;
}
