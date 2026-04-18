# @koi/url-safety — SSRF and metadata blocklist

**Layer:** L0-utility. Depends only on Node built-ins (`node:net`, `node:dns`). Zero `@koi/*` imports.

> **Rollout status.** This PR adds the library only. No outbound HTTP path in the monorepo has been migrated onto `@koi/url-safety` yet — `@koi/tools-web/web_fetch` still uses its own `url-policy.ts`, and nothing else calls `createSafeFetcher`. Treat this package as a shared building block that consumers must opt into; installing it does not retroactively harden existing callers. The migration of `@koi/tools-web` is a follow-up PR.

---

## Purpose

`@koi/url-safety` is intended to become the central fail-closed gate for every outbound HTTP call in Koi. It blocks private IPv4 and IPv6 ranges (RFC1918, loopback, link-local, CGNAT, multicast, reserved/documentation), cloud metadata endpoints reachable by hostname (`metadata.google.internal`, `instance-data.ec2.internal`, etc.) and by IP literal or DNS resolution (`169.254.169.254`, `fd00:ec2::254` via `fc00::/7`), and DNS-rebinding attacks by resolving the hostname and checking every returned A/AAAA record before permitting a request. `createSafeFetcher` narrows the attack surface further by re-running the same check on every redirect hop rather than trusting the final destination to be safe.

---

## Public API

| Export | Kind | Purpose |
|--------|------|---------|
| `isSafeUrl(url, options?)` | `async function` | Full URL validation pipeline: parse → protocol → allowlist → blocked-hosts → IP literal or DNS resolve + check every address. Returns `SafeUrlResult` discriminated union. Fail-closed: any error (parse failure, DNS failure, empty result) returns `ok: false`. |
| `createSafeFetcher(base?, options?)` | factory | Returns a `fetch`-compatible function. Validates the origin URL, then follows redirects manually (`redirect: "manual"`), re-validating each `Location` hop via `isSafeUrl` before following it. Throws on block or when `maxRedirects` is exceeded. |
| `isBlockedIp(ip)` | `sync function` | Low-level IP classifier. Accepts IPv4 dotted-decimal, bare IPv6, or bracket-enclosed IPv6. Fail-closed: malformed input returns `true`. Re-exported so governance layers can classify a resolved IP without re-running URL parsing. |
| `BLOCKED_HOSTS` | frozen `readonly string[]` | Hostnames blocked by name: `localhost`, `0.0.0.0`, `metadata.google.internal`, `metadata`, `instance-data`, `instance-data.ec2.internal`. Extend by PR only — never mutate at runtime. |
| `BLOCKED_CIDR_RANGES` | frozen `readonly string[]` | Human-readable list of every CIDR the classifier covers. The canonical source of truth for which ranges are blocked; exposed so policy layers and audit tooling can inspect coverage without parsing source. |

### Types

```typescript
type SafeUrlResult =
  | { readonly ok: true; readonly hostname: string; readonly resolvedIps: readonly string[] }
  | { readonly ok: false; readonly reason: string };

type DnsResolver = (hostname: string) => Promise<readonly string[]>;
```

### Options

| Field | Default | Purpose |
|-------|---------|---------|
| `allowPrivate` | `false` | Skip private IP and blocked-host checks. For tests and local dev only. Protocol allowlist still applies. |
| `allowlistHosts` | — | Per-hostname bypass of `BLOCKED_HOSTS` and `isBlockedIp`. Takes precedence; DNS resolution is skipped for allowlisted hosts. A successful allowlist hit returns `resolvedIps: []` (empty array) — callers consuming `resolvedIps` on an OK result should account for this. |
| `allowedProtocols` | `["http:", "https:"]` | Protocol allowlist. Set to `["https:"]` for HTTPS-only clients. |
| `dnsResolver` | `dns.lookup` with `{ all: true }` | Injectable resolver for tests. Must return every A/AAAA record — returning a single record defeats DNS rebinding protection. |
| `maxRedirects` (fetcher only) | `5` | Maximum redirect hops before throwing `url-safety: exceeded N redirects`. |

---

## Blocklist rationale

### IPv4 blocked ranges

| CIDR | Why |
|------|-----|
| `0.0.0.0/8` | "This network" source addresses (RFC1122 §3.2.1.3) — not routable |
| `10.0.0.0/8` | Private RFC1918 |
| `100.64.0.0/10` | CGNAT / shared address space (RFC6598); also used for metadata by some clouds (Alibaba) |
| `127.0.0.0/8` | Loopback |
| `169.254.0.0/16` | Link-local; includes AWS (`169.254.169.254`), GCP, and Azure IMDS |
| `172.16.0.0/12` | Private RFC1918 |
| `192.0.2.0/24` | TEST-NET-1 (RFC5737) — documentation, not routable |
| `192.168.0.0/16` | Private RFC1918 |
| `198.18.0.0/15` | Benchmarking (RFC2544) |
| `198.51.100.0/24` | TEST-NET-2 (RFC5737) |
| `203.0.113.0/24` | TEST-NET-3 (RFC5737) |
| `224.0.0.0/4` | Multicast |
| `240.0.0.0/4` | Reserved for future use; covers broadcast (`255.255.255.255`) |
| `255.255.255.255/32` | Limited broadcast (RFC919) — listed separately in `BLOCKED_CIDR_RANGES` even though `240.0.0.0/4` covers it mathematically |

### IPv6 blocked ranges (full block)

Every address inside these prefixes is rejected.

| CIDR | Why |
|------|-----|
| `::/128` | Unspecified address |
| `::1/128` | Loopback |
| `100::/64` | Discard prefix (RFC6666) |
| `2001::/32` | Teredo tunnel |
| `2001:db8::/32` | Documentation (RFC3849) |
| `fc00::/7` | Unique-local (RFC4193); covers `fd00:ec2::254` (AWS IPv6 IMDS) |
| `fe80::/10` | Link-local |
| `fec0::/10` | Site-local (deprecated RFC3879, still legacy-routed in some networks) |
| `ff00::/8` | Multicast |

### IPv6 prefixes with embedded-v4 re-check

These prefixes wrap an IPv4 address. The classifier decodes the embedded v4 and re-runs the IPv4 blocklist against it — an address pointing at a **public** v4 is allowed (that's just legitimate translation traffic), a **private** v4 is rejected.

| CIDR | Why |
|------|-----|
| `::ffff:0:0/96` | IPv4-mapped (RFC4291) |
| `::/96` | IPv4-compatible (deprecated RFC4291) — URL parser canonicalises `[::127.0.0.1]` to `[::7f00:1]` |
| `64:ff9b::/96` | NAT64 well-known prefix (RFC6052) |
| `64:ff9b:1::/48` | NAT64 local-use prefix (RFC8215) |
| `2002::/16` | 6to4 — embeds IPv4 in groups 2–3 |

The two classes are exported separately so a policy consumer can inspect them distinctly: `BLOCKED_CIDR_RANGES` for full-block ranges, `EMBEDDED_V4_IPV6_PREFIXES` for embedded-v4 re-check prefixes. The classifier itself is implemented with bigint bitmask arithmetic (IPv4) and first-hextet prefix matching plus embedded-address extraction (IPv6) in `ip-classify.ts`.

---

## isSafeUrl pipeline

`isSafeUrl` runs these checks in order, short-circuiting on the first failure:

1. **Parse** — `new URL(url)`. Any parse error → `ok: false`.
2. **Protocol** — the URL's protocol must be in `allowedProtocols`. Default: `http:`, `https:`.
3. **Hostname lowercased** — normalises before all subsequent checks.
4. **Allowlist** — if `allowlistHosts` contains the bare hostname, return `ok: true` immediately (no DNS).
5. **Blocked-hosts** — if `BLOCKED_HOSTS` contains the hostname, return `ok: false` (skipped when `allowPrivate`).
6. **IP literal** — if the hostname is an IPv4 dotted-decimal or IPv6 literal, call `isBlockedIp` and return accordingly (skipped when `allowPrivate`).
7. **DNS resolve** — call `dnsResolver(hostname)`. Empty result or resolver error → `ok: false`. Every returned IP is checked via `isBlockedIp`; the first blocked IP short-circuits to `ok: false`.

---

## DNS rebinding — what's pinned and what isn't

`isSafeUrl` resolves the hostname with `dns.lookup({ all: true })` and blocks if any A/AAAA record is private. `createSafeFetcher` then closes the rebind window for **HTTP** by rewriting the outbound URL to the validated IP and setting a `Host:` header — the TCP socket connects to the exact address the validator approved, no second resolution possible. When a hostname resolves to multiple IPs, all of them were individually validated, and the wrapper tries them in order on connect failure so normal multi-address failover still works.

**HTTPS cannot be pinned the same way** — rewriting the host-part of an `https://` URL to an IP breaks TLS SNI and certificate hostname verification, which are a much stronger protection than DNS pinning. For HTTPS the wrapper therefore leaves the URL hostname intact and accepts a sub-second TOCTOU window between `isSafeUrl` and the socket connect. Attacker-controlled low-TTL DNS could in theory resolve to a different address on the actual connect than on the check; in practice this is mitigated by OS/resolver caching and the fact that HTTPS also requires a valid certificate for the connected IP. `createSafeFetcher` narrows this window further by re-running `isSafeUrl` at the TOP of every redirect-loop iteration — including hop 0 after any stream body has been buffered — so a slow upload cannot widen the gap by seconds. For air-tight HTTPS pinning, route outbound calls through a reverse proxy with a locked resolver.

**Custom transports are refused by default.** If the caller supplies an undici `dispatcher` or legacy `agent`, that transport controls the actual socket path and can ignore the validated IP set — the wrapper's SSRF guarantee evaporates. `createSafeFetcher` therefore throws on any request that combines the two unless the caller explicitly opts in with `trustCustomTransport: true`. That opt-in is only safe when the transport itself enforces an equivalent egress policy (e.g., a locked-resolver proxy with its own allowlist); set it with that understanding, not as a quick fix.

For high-stakes deployments that need bit-for-bit guarantees on HTTPS targets, route outbound requests through a reverse proxy with a locked, non-attacker-controlled resolver rather than relying solely on this package.

Redirects: each hop is re-validated via `isSafeUrl` before it is followed, so the protection applies to the entire redirect chain, not just the first URL. On cross-origin redirects the wrapper applies an **allowlist** for headers — anything other than a small set of content-negotiation headers (`accept`, `accept-encoding`, `accept-language`, `user-agent`, `content-type`, `content-language`, `cache-control`, `pragma`) is redacted. A denylist (`authorization`, `cookie`, …) is too narrow for a server-side fetcher because custom auth headers (`x-api-key`, `x-amz-security-token`, vendor-specific bearer headers) are common and impossible to enumerate safely.

**Cross-origin redirects that would still carry a body are refused.** The test is "would the post-downgrade request send a body to a different origin?", not just the status code. That covers 307/308 for any method (body always preserved), plus 301/302 for non-POST methods like PUT/PATCH (downgrade only drops body for POST). Bodies often carry the same secrets the header allowlist redacts (API keys in JSON, signed payloads), and there's no safe generic way to sanitise them. The wrapper throws; if the caller genuinely needs the replay they can re-issue the request manually against the validated redirect target.

### `Response.url` semantics under HTTP pinning

When the wrapper pins an `http://` request to the validated IP, the underlying `fetch(pinnedUrl, …)` returns a `Response` whose `Response.url` reflects the IP form (e.g., `http://93.184.216.34/…`) rather than the original hostname. `Response.redirected` similarly describes the transport-layer view, not the wrapper's manual redirect handling. Callers that log the final URL, perform origin checks on it, or derive follow-up URLs from it must track the original URL themselves — the wrapper does not synthesize a rewritten `Response` because doing so would drop streaming body semantics and other `fetch`-native metadata.

### Request bodies

Stream-backed bodies (`ReadableStream`, `Request.body`) are consumed into a `Uint8Array` once at the start of `createSafeFetcher`, so 307/308 redirects that preserve method + body can safely replay. This also avoids Node 22's `RequestInit` `duplex: "half"` requirement. Callers that need genuine streaming uploads should use the underlying `fetch` directly — this wrapper optimises for correctness over streaming throughput.

---

## Consumers

- **`@koi/tools-web`** — `web_fetch` built-in tool. Currently maintains its own `url-policy.ts`; planned to migrate to `@koi/url-safety` for unified coverage.
- **Future `@koi/tools-browser` / vision loaders** — any L2 tool that fetches a URL on behalf of the model.
- **Governance and audit packages** — `BLOCKED_HOSTS` and `BLOCKED_CIDR_RANGES` are public so policy layers can inspect or extend coverage without forking internal logic.

---

## Extending the blocklist

Do not fork the constants. Add an entry to `BLOCKED_HOSTS` or `BLOCKED_CIDR_RANGES` in `packages/lib/url-safety/src/blocked.ts` with a one-line comment citing the RFC, vendor documentation, or cloud metadata reference. If the new entry is a CIDR that requires new classification logic (not just an additional prefix check), also extend `ip-classify.ts`. Every change requires a regression test in `ip-classify.test.ts` or `safe-url.test.ts` that would have caught any existing bypass.

---

## Non-goals

- Not a general URL normaliser — we lowercase the hostname and strip brackets from IPv6 literals, but we do not canonicalise paths, decode percent-encoding, or validate query strings.
- Not an HTTP hardening layer — no HSTS enforcement, no TLS certificate pinning. Those concerns belong in the TLS stack or a separate middleware.
- Not a rate limiter or WAF — this is a static blocklist and DNS-resolve check, not a traffic analyser or intrusion detection system.
