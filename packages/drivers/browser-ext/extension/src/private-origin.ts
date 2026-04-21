import type { ExtensionStorage } from "./storage.js";

const PRIVATE_SUFFIXES = [".local", ".internal", ".corp", ".home.arpa"] as const;

function isIpv4Private(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255))
    return false;
  const [a, b] = parts;
  if (a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  return false;
}

/** Decodes `::ffff:AABB:CCDD` (Node/browser normalized hex form of IPv4-mapped IPv6). */
function ipv4FromMappedHex(lower: string): string | null {
  const m = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/.exec(lower);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  const hi = Number.parseInt(m[1], 16);
  const lo = Number.parseInt(m[2], 16);
  if (Number.isNaN(hi) || Number.isNaN(lo) || hi > 0xffff || lo > 0xffff) return null;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isIpv6Private(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "::1") return true;
  // IPv4-mapped IPv6 dotted-quad form: ::ffff:127.0.0.1
  const mappedDotted = /^::ffff:([\d.]+)$/.exec(normalized);
  if (mappedDotted?.[1]) return isIpv4Private(mappedDotted[1]);
  // IPv4-mapped IPv6 hex form: ::ffff:7f00:0001
  const mappedHex = ipv4FromMappedHex(normalized);
  if (mappedHex) return isIpv4Private(mappedHex);
  // IPv4-compatible IPv6 (deprecated but still parseable): ::127.0.0.1
  const compat = /^::([\d.]+)$/.exec(normalized);
  if (compat?.[1] && compat[1].includes(".")) return isIpv4Private(compat[1]);
  if (normalized.startsWith("fc")) return true;
  if (normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe8")) return true;
  if (normalized.startsWith("fe9")) return true;
  if (normalized.startsWith("fea")) return true;
  if (normalized.startsWith("feb")) return true;
  return false;
}

export function normalizeOrigin(input: string): string {
  return new URL(input).origin;
}

export function isPrivateOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  const rawHost = parsed.hostname.toLowerCase();
  // Strip brackets from IPv6 literals (URL.hostname preserves them).
  const hostname =
    rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (PRIVATE_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return true;
  if (hostname.includes(":")) return isIpv6Private(hostname);
  return isIpv4Private(hostname);
}

/**
 * Opaque / privileged schemes that must never be grantable — they collapse
 * to `origin === "null"` (file://, data://, sandboxed iframes) or reach
 * trust boundaries beyond SSRF (chrome://, chrome-extension://, javascript:).
 * Persisting an `always` grant for any of these would bucket unrelated
 * documents under a single reusable permission.
 */
const NON_GRANTABLE_SCHEMES: ReadonlySet<string> = new Set([
  "file:",
  "data:",
  "blob:",
  "about:",
  "chrome:",
  "chrome-extension:",
  "javascript:",
  "view-source:",
]);

export function isNonGrantableOrigin(origin: string): boolean {
  if (origin === "null") return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    // A string that doesn't parse as a URL is not a usable origin either.
    return true;
  }
  return NON_GRANTABLE_SCHEMES.has(parsed.protocol);
}

export async function isOriginAllowedByPolicy(
  storage: ExtensionStorage,
  origin: string,
): Promise<boolean> {
  // Opaque / privileged origins are NEVER grantable — a persisted grant on
  // "null" would apply to every opaque document in this browser session,
  // and file:/chrome:/etc. cross trust boundaries beyond this feature.
  if (isNonGrantableOrigin(origin)) return false;
  if (!isPrivateOrigin(origin)) return true;
  const allowlist = await storage.getPrivateOriginAllowlist();
  return allowlist.includes(origin);
}
