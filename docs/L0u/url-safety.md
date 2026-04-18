# @koi/url-safety — SSRF and metadata blocklist

**Layer:** L0-utility. Depends only on Node built-ins (`node:net`, `node:dns`). Zero `@koi/*` imports.

---

## Purpose

`@koi/url-safety` is the central fail-closed gate every outbound HTTP call in Koi passes through. It blocks private IPv4 and IPv6 ranges (RFC1918, loopback, link-local, CGNAT, multicast, reserved/documentation), cloud metadata endpoints reachable by hostname (`metadata.google.internal`, `instance-data.ec2.internal`, etc.) and by IP literal or DNS resolution (`169.254.169.254`, `fd00:ec2::254` via `fc00::/7`), and DNS-rebinding attacks by resolving the hostname and checking every returned A/AAAA record before permitting a request. `createSafeFetcher` narrows the attack surface further by re-running the same check on every redirect hop rather than trusting the final destination to be safe.

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

### IPv6 blocked ranges

| CIDR | Why |
|------|-----|
| `::/128` | Unspecified address |
| `::1/128` | Loopback |
| `::ffff:0:0/96` | IPv4-mapped — the embedded IPv4 is extracted and re-checked against the IPv4 table |
| `64:ff9b::/96` | NAT64 well-known prefix (RFC6052) |
| `100::/64` | Discard prefix (RFC6666) |
| `2001::/32` | Teredo — embeds arbitrary IPv4; any private embedding is blocked |
| `2001:db8::/32` | Documentation (RFC3849) |
| `2002::/16` | 6to4 — embeds IPv4 in groups 2–3; private embeddings are blocked |
| `fc00::/7` | Unique-local (RFC4193); covers `fd00:ec2::254` (AWS IPv6 IMDS) |
| `fe80::/10` | Link-local |
| `ff00::/8` | Multicast |

The full machine-readable list is exported as `BLOCKED_CIDR_RANGES` in `blocked.ts`. The classifier itself is implemented with bigint bitmask arithmetic (IPv4) and first-hextet prefix matching plus embedded-address extraction (IPv6) in `ip-classify.ts`.

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

## DNS rebinding — TOCTOU limitation

`isSafeUrl` resolves the hostname with `dns.lookup({ all: true })` and checks every returned A/AAAA record against `isBlockedIp`, blocking if any address is private. However, the actual TCP connection is made by the underlying `fetch` call which re-resolves the hostname independently. This creates a sub-second TOCTOU window: an attacker who controls DNS TTLs could serve a public IP during the check and a private IP during the connect.

`createSafeFetcher` narrows this window per redirect hop — each `Location` header is re-validated before the next request — but it does not eliminate the window for the origin hop or for any individual hop. In practice the gap is sub-second and mitigated by OS and resolver caching. For high-stakes deployments, route outbound requests through a reverse proxy with a locked, non-attacker-controlled resolver rather than relying solely on this package.

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
