/**
 * isSafeUrl — SSRF-safe URL validator.
 *
 * Pipeline (fail-closed at every step):
 *   1. parse URL (new URL()) — rejects malformed input
 *   2. protocol ∈ allowedProtocols (default http: / https:)
 *   3. hostname lower-cased, IPv6 brackets stripped
 *   4. BLOCKED_HOSTS match → blocked (skipped for allowlistHosts / allowPrivate)
 *   5. IP literal → isBlockedIp (skipped for allowlistHosts / allowPrivate)
 *   6. Hostname → DNS resolve (injectable). DNS failure / empty result is
 *      fatal for every hostname URL — without a resolved IP set,
 *      createSafeFetcher cannot pin and the later fetch-side resolution
 *      could land on any address.
 *   7. Per-IP isBlockedIp check (skipped for allowlistHosts / allowPrivate).
 *
 * allowlistHosts + allowPrivate scope: both skip only the per-IP / per-host
 * blocklist checks. Neither disables DNS resolution or the pinning that
 * createSafeFetcher builds on top of `resolvedIps`.
 *
 * DNS rebinding note: we resolve and check. The HTTP path is pinned by
 * createSafeFetcher; HTTPS retains a sub-second TOCTOU window (documented in
 * docs/L0u/url-safety.md) because TLS SNI/cert verification requires the
 * original hostname on the wire.
 */
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { BLOCKED_HOSTS } from "./blocked.js";
import { isBlockedIp } from "./ip-classify.js";

export type DnsResolver = (hostname: string) => Promise<readonly string[]>;

export interface UrlSafetyOptions {
  readonly allowPrivate?: boolean;
  readonly allowlistHosts?: readonly string[];
  readonly allowedProtocols?: readonly string[];
  readonly dnsResolver?: DnsResolver;
  /**
   * When `true`, a real resolver error (TIMEOUT/SERVFAIL/etc.) on EITHER
   * A or AAAA is fatal — the full authoritative set must be observed.
   * Closes the "attacker-hostname with public A + private AAAA where
   * AAAA times out during validation but succeeds at connect time" vector
   * at the cost of rejecting hostnames under flaky IPv6 DNS.
   *
   * Default: `false` (availability-friendly). A single successful family
   * is accepted; the other family's transient failure is treated as
   * "no records of this family". Only the fully-failed case (both
   * families error) fails closed.
   *
   * Set to `true` for high-assurance deployments where SSRF is a higher
   * priority than IPv6-DNS resilience.
   */
  readonly requireFullDnsCoverage?: boolean;
}

export type SafeUrlResult =
  | { readonly ok: true; readonly hostname: string; readonly resolvedIps: readonly string[] }
  | { readonly ok: false; readonly reason: string };

const DEFAULT_PROTOCOLS: readonly string[] = ["http:", "https:"];

// dns.lookup goes through the OS resolver, which may filter or cache — that
// undermines the "every A/AAAA" assumption the rebinding defence relies on.
// Query both record families directly via dns.resolve4 / dns.resolve6.
//
// Failure policy is factored out as a closure so requireFullDnsCoverage can
// switch between strict (any real error is fatal) and availability-friendly
// (a single successful family is enough) without changing the resolve flow.
const BENIGN_NO_RECORD_CODES: ReadonlySet<string> = new Set(["ENODATA", "ENOTFOUND"]);

interface FamilyResult {
  readonly addresses: readonly string[];
  readonly error: unknown;
}

async function resolveFamily(
  fn: (h: string) => Promise<string[]>,
  hostname: string,
): Promise<FamilyResult> {
  try {
    return { addresses: await fn(hostname), error: undefined };
  } catch (e: unknown) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && BENIGN_NO_RECORD_CODES.has(code)) {
      return { addresses: [], error: undefined };
    }
    return { addresses: [], error: e };
  }
}

function buildDefaultResolver(strict: boolean): DnsResolver {
  return async (hostname) => {
    if (isIP(hostname) !== 0) return [hostname];
    const [v4, v6] = await Promise.all([
      resolveFamily(dns.resolve4, hostname),
      resolveFamily(dns.resolve6, hostname),
    ]);
    // Strict mode: any real resolver error (not just no-records) is fatal.
    if (strict) {
      if (v4.error !== undefined) throw v4.error;
      if (v6.error !== undefined) throw v6.error;
    } else if (v4.error !== undefined && v6.error !== undefined) {
      // Lenient mode: fail only when BOTH families errored. A single-family
      // success is trusted; flaky IPv6 DNS doesn't block healthy IPv4 hosts.
      throw v4.error;
    }
    return [...new Set([...v4.addresses, ...v6.addresses])];
  };
}

const defaultDnsResolverLenient = buildDefaultResolver(false);
const defaultDnsResolverStrict = buildDefaultResolver(true);

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

  // allowlistHosts and allowPrivate both skip the per-IP blocklist check,
  // but they DO NOT skip DNS resolution — we still resolve so
  // createSafeFetcher can pin to validated IPs. DNS failure remains fatal
  // for hostname URLs regardless; pin-on-nothing would let the downstream
  // socket connect to whatever the OS resolver returns later.
  const isAllowlisted = options?.allowlistHosts?.includes(bareHost) === true;
  const skipIpCheck = isAllowlisted || options?.allowPrivate === true;

  if (!skipIpCheck && BLOCKED_HOSTS.includes(bareHost)) {
    return { ok: false, reason: `Blocked host ${bareHost}` };
  }

  if (isIpLiteral(bareHost)) {
    if (!skipIpCheck && isBlockedIp(bareHost)) {
      return { ok: false, reason: `Blocked IP literal ${bareHost}` };
    }
    return { ok: true, hostname: bareHost, resolvedIps: [bareHost] };
  }

  const resolver =
    options?.dnsResolver ??
    (options?.requireFullDnsCoverage ? defaultDnsResolverStrict : defaultDnsResolverLenient);
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

  if (!skipIpCheck) {
    for (const ip of addresses) {
      if (isBlockedIp(ip)) {
        return { ok: false, reason: `Host ${bareHost} resolves to blocked IP ${ip}` };
      }
    }
  }

  return { ok: true, hostname: bareHost, resolvedIps: addresses };
}
