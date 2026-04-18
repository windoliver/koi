/**
 * isSafeUrl — SSRF-safe URL validator.
 *
 * Pipeline (fail-closed at every step):
 *   1. parse URL (new URL()) — rejects malformed input
 *   2. protocol ∈ allowedProtocols (default http: / https:)
 *   3. hostname lower-cased
 *   4. hostname ∈ allowlistHosts → OK (explicit opt-in)
 *   5. hostname ∈ BLOCKED_HOSTS → blocked (unless allowPrivate)
 *   6. if IP literal → isBlockedIp check (unless allowPrivate)
 *   7. else DNS resolve (injectable resolver) → every returned IP
 *      must pass isBlockedIp, else blocked. Empty result or error = blocked.
 *
 * DNS rebinding note: we resolve and check, but the actual fetch happens
 * separately — so a short TOCTOU window exists if the resolver TTL is low.
 * Callers that need true IP-pinning should use createSafeFetcher which wraps
 * fetch + revalidates each redirect hop.
 */
import { promises as dns } from "node:dns";
import { BLOCKED_HOSTS } from "./blocked.js";
import { isBlockedIp } from "./ip-classify.js";

export type DnsResolver = (hostname: string) => Promise<readonly string[]>;

export interface UrlSafetyOptions {
  readonly allowPrivate?: boolean;
  readonly allowlistHosts?: readonly string[];
  readonly allowedProtocols?: readonly string[];
  readonly dnsResolver?: DnsResolver;
}

export type SafeUrlResult =
  | { readonly ok: true; readonly hostname: string; readonly resolvedIps: readonly string[] }
  | { readonly ok: false; readonly reason: string };

const DEFAULT_PROTOCOLS: readonly string[] = ["http:", "https:"];

const defaultDnsResolver: DnsResolver = async (hostname) => {
  const records = await dns.lookup(hostname, { all: true });
  return records.map((r) => r.address);
};

function isIpLiteral(hostname: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  return hostname.startsWith("[") || hostname.includes(":");
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

export async function isSafeUrl(url: string, options?: UrlSafetyOptions): Promise<SafeUrlResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `Invalid URL: ${url}` };
  }

  const protocols = options?.allowedProtocols ?? DEFAULT_PROTOCOLS;
  if (!protocols.includes(parsed.protocol)) {
    return {
      ok: false,
      reason: `Blocked protocol "${parsed.protocol}" for ${url}; allowed: ${protocols.join(", ")}`,
    };
  }

  const hostnameLower = parsed.hostname.toLowerCase();
  const bareHost = stripBrackets(hostnameLower);

  if (options?.allowlistHosts?.includes(bareHost)) {
    return { ok: true, hostname: bareHost, resolvedIps: [] };
  }

  if (!options?.allowPrivate && BLOCKED_HOSTS.includes(bareHost)) {
    return { ok: false, reason: `Blocked host ${bareHost}` };
  }

  if (isIpLiteral(bareHost)) {
    if (!options?.allowPrivate && isBlockedIp(bareHost)) {
      return { ok: false, reason: `Blocked IP literal ${bareHost}` };
    }
    return { ok: true, hostname: bareHost, resolvedIps: [bareHost] };
  }

  if (options?.allowPrivate) {
    return { ok: true, hostname: bareHost, resolvedIps: [] };
  }

  const resolver = options?.dnsResolver ?? defaultDnsResolver;
  let addresses: readonly string[];
  try {
    addresses = await resolver(bareHost);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `DNS resolution failed for ${bareHost}: ${message}` };
  }

  if (addresses.length === 0) {
    return { ok: false, reason: `DNS returned no addresses for ${bareHost}` };
  }

  for (const ip of addresses) {
    if (isBlockedIp(ip)) {
      return { ok: false, reason: `Host ${bareHost} resolves to blocked IP ${ip}` };
    }
  }

  return { ok: true, hostname: bareHost, resolvedIps: addresses };
}
