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
import { BLOCKED_HOST_SUFFIXES, BLOCKED_HOSTS } from "./blocked.js";
import { isBlockedIp } from "./ip-classify.js";

export type DnsResolver = (hostname: string) => Promise<readonly string[]>;

export interface UrlSafetyOptions {
  readonly allowPrivate?: boolean;
  readonly allowlistHosts?: readonly string[];
  readonly allowedProtocols?: readonly string[];
  readonly dnsResolver?: DnsResolver;
  /**
   * Resolver selection for the built-in resolver. Default `true` uses
   * `dns.resolve4` / `dns.resolve6` to query authoritative DNS and
   * enumerate the full A/AAAA set — the strict rebinding-defence
   * invariant. HTTPS requests rely on this: because `createSafeFetcher`
   * cannot pin HTTPS to a specific IP, validating against the complete
   * authoritative set is the only way to avoid approving a partial
   * answer that later expands to include a blocked address.
   *
   * Set to `false` to delegate to `dns.lookup({ all: true })` — the same
   * path `fetch` uses at connect time (honours `/etc/hosts`, NSS, mDNS,
   * search domains). Useful for internal-name deployments where
   * authoritative lookup would over-reject, at the cost of weaker
   * rebinding defence.
   *
   * A caller-supplied `dnsResolver` overrides both paths.
   */
  readonly strictAuthoritativeDns?: boolean;

  /**
   * When `true` (the default), a real resolver error (TIMEOUT/SERVFAIL/etc.)
   * on EITHER A or AAAA family is fatal. This closes the rebinding vector
   * where a hostname's public A is approved while a blocked AAAA lookup
   * transiently failed — the later HTTPS connect (which the wrapper can't
   * pin) could still reach the unseen AAAA address.
   *
   * Set to `false` to accept single-family success and treat the other
   * family's transient failure as "no records of this family". Useful
   * for flaky-IPv6 environments, but re-opens the partial-coverage SSRF
   * window. Only applies when the authoritative resolver is in use.
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

const defaultAuthoritativeResolverLenient = buildDefaultResolver(false);
const defaultAuthoritativeResolverStrict = buildDefaultResolver(true);

// OS-parity resolver: delegates to dns.lookup (the same path fetch uses at
// connect time), so /etc/hosts, NSS, mDNS, and search domains all apply.
// Default for the built-in resolver so validation matches the transport.
const defaultLookupResolver: DnsResolver = async (hostname) => {
  if (isIP(hostname) !== 0) return [hostname];
  const records = await dns.lookup(hostname, { all: true });
  return [...new Set(records.map((r) => r.address))];
};

function pickResolver(options: UrlSafetyOptions | undefined): DnsResolver {
  if (options?.dnsResolver !== undefined) return options.dnsResolver;
  // Default: authoritative resolver with full A+AAAA coverage (strict).
  // Only explicit opt-outs relax either axis.
  if (options?.strictAuthoritativeDns === false) return defaultLookupResolver;
  return options?.requireFullDnsCoverage === false
    ? defaultAuthoritativeResolverLenient
    : defaultAuthoritativeResolverStrict;
}

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

  // allowlistHosts scope is per-host only — it bypasses the hostname
  // (BLOCKED_HOSTS) and IP-literal checks ONLY when bareHost itself is the
  // allowlisted entry. For hostname URLs, the per-IP blocklist STILL runs
  // against the resolved A/AAAA set — allowlisting foo.com doesn't grant
  // permission to reach 127.0.0.1 just because foo.com happens to resolve
  // there. Callers who genuinely need to reach a private service by hostname
  // must use `allowPrivate: true` (the wider, explicit opt-out).
  const isAllowlisted = options?.allowlistHosts?.includes(bareHost) === true;
  const allowPrivate = options?.allowPrivate === true;

  if (!isAllowlisted && !allowPrivate && BLOCKED_HOSTS.includes(bareHost)) {
    return { ok: false, reason: `Blocked host ${bareHost}` };
  }

  // Reserved-suffix block runs for hostnames (not IP literals — they'd
  // already match the IP-literal branch below). Caller allowlist bypasses
  // it; allowPrivate does not, because these suffixes name internal
  // infrastructure, not merely private IP ranges.
  if (!isAllowlisted && !isIpLiteral(bareHost)) {
    for (const suffix of BLOCKED_HOST_SUFFIXES) {
      if (bareHost === suffix.slice(1) || bareHost.endsWith(suffix)) {
        return { ok: false, reason: `Blocked reserved suffix ${suffix} for host ${bareHost}` };
      }
    }
  }

  if (isIpLiteral(bareHost)) {
    // IP literal: allowlisting the literal explicitly permits it; otherwise
    // enforce the per-IP block (unless allowPrivate disables it).
    if (!isAllowlisted && !allowPrivate && isBlockedIp(bareHost)) {
      return { ok: false, reason: `Blocked IP literal ${bareHost}` };
    }
    return { ok: true, hostname: bareHost, resolvedIps: [bareHost] };
  }

  // Resolver selection: caller-supplied wins. Otherwise default to OS-parity
  // (dns.lookup); opt into authoritative A/AAAA via strictAuthoritativeDns.
  const resolver = pickResolver(options);
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

  // Per-IP blocklist: only allowPrivate skips it. allowlistHosts does NOT
  // — a trusted hostname resolving to 127.0.0.1 / metadata IPs / etc. is
  // still rejected, because allowlist is about the HOSTNAME, not the
  // address it happens to resolve to.
  if (!allowPrivate) {
    for (const ip of addresses) {
      if (isBlockedIp(ip)) {
        return { ok: false, reason: `Host ${bareHost} resolves to blocked IP ${ip}` };
      }
    }
  }

  return { ok: true, hostname: bareHost, resolvedIps: addresses };
}
