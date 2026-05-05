# Issue #1363 — Enterprise Channels (email, teams, whatsapp)

**Date**: 2026-05-05
**Issue**: https://github.com/windoliver/koi/issues/1363
**Branch**: `feat/issue-1363-channels`
**Phase**: v2 Phase 3-channels-4

## Summary

Port v1 enterprise channel adapters (Email, Microsoft Teams, WhatsApp) to v2 as
three independent L2 packages, each following the established `@koi/channel-slack`
pattern and the v2 `@koi/channel-base` runtime. WhatsApp uses the **official
Meta Cloud API** (HTTP/webhooks) rather than v1's unofficial Baileys.

## Goals

- Three new L2 packages that satisfy the `Channel` contract from `@koi/core`
- Wired into `@koi/runtime` with golden-query coverage (matches `channel-slack`)
- Pre-shipped Doc → Tests → Code per CLAUDE.md v2 workflow
- Layer-clean: each depends only on `@koi/core` + `@koi/channel-base` + selected L0u + 0–3 external SDKs

## Non-goals

- OAuth2 token refresh flows. Configs accept pre-issued tokens; rotation is upstream concern.
- Attachment AV/malware scanning.
- WhatsApp interactive buttons/lists (template + text + media only for v1 of this package).
- Teams SSO / on-behalf-of flows.
- Real-network E2E tests (handled in a separate harness).

## Architecture

Three sibling packages under `packages/lib/`:

```
packages/lib/channel-email
packages/lib/channel-teams
packages/lib/channel-whatsapp
```

Each is **L2**: imports only `@koi/core`, `@koi/channel-base`, and selected L0u packages
(`@koi/errors`, `@koi/validation` where applicable). Never imports `@koi/engine`
or peer L2 channels. Layer rules enforced by `bun run check:layers`.

### Per-package file layout (mirrors `channel-slack`)

```
src/
  index.ts                 — public exports (factory + descriptor + webhook handler type for Teams/WhatsApp)
  descriptor.ts            — ChannelDescriptor for manifest binding
  config.ts                — Zod schema + validate{Email,Teams,WhatsApp}Config
  {name}-channel.ts        — createXChannel factory; send/onMessage
  normalize.ts             — platform inbound → KoiMessage (ContentBlock[])
  format.ts                — KoiMessage → platform outbound payload
  platform-send.ts         — outbound transport (HTTP / SMTP)
  *.test.ts                — colocated unit tests
  __tests__/
    integration.test.ts    — end-to-end through factory with fakes
    api-surface.test.ts    — public API drift detection
package.json, tsconfig.json, tsup.config.ts
```

### Dependency Injection

Every external transport is injected. Channels expose factory functions taking
explicit dependencies — never `new`-ing SDK clients internally. This mirrors
`createSlackChannel` and is required for testability.

| Channel | Injected Dependencies |
|---------|------------------------|
| email | `{ imap: ImapClient, smtp: SmtpTransport, parser: MimeParser, threadStore: ThreadStore, outboxStore: OutboxStore, idempotencyStore: IdempotencyStore, idGenerator?: () => string, clock?: () => number }` |
| teams | `{ tokenVerifier: JwtVerifier, fetch: typeof fetch, idempotencyStore: IdempotencyStore, clock?: () => number }` |
| whatsapp | `{ fetch: typeof fetch, idempotencyStore: IdempotencyStore, clock?: () => number }` |

`ImapClient`, `SmtpTransport`, `MimeParser`, `JwtVerifier` are **local interfaces**
defined in each package. Default factory adapters wrap `imapflow`, `nodemailer`,
`mailparser`, `jose` — but the interfaces themselves do not leak vendor types.

### Webhook adapter surface (Teams + WhatsApp)

The base `ChannelAdapter` contract (`connect`, `disconnect`, `send`, `onMessage`)
has no HTTP ingress method. To make request-bound ack/nack semantics
implementable, both webhook channels expose the same optional surface that
`channel-slack` already established:

```ts
readonly handleHttpRequest?: (request: Request) => Promise<Response>;
```

The runtime/host (gateway, dev server, `@koi/runtime`) is responsible for
binding the channel's `handleHttpRequest` to the appropriate route
(`POST /api/messages` for Teams, `GET|POST /webhook` for WhatsApp). The handler
is what executes the auth → `tryBegin` → `await onMessage` → commit/abort flow
described below; the HTTP `Response` reflects the handler's outcome
deterministically. Email has no `handleHttpRequest` because it is IMAP-driven.

The package's `index.ts` re-exports `handleHttpRequest`-shaped types
(`WebhookRequest`, `WebhookResponse` aliases of standard `Request`/`Response`)
so hosts can integrate without depending on `@koi/channel-base` internals. The
golden-replay tests for each webhook channel call `handleHttpRequest` directly
with synthetic `Request` objects and assert: 200 on commit, 401/403 on auth
failure, 409 on in-flight, 500 on handler throw, 503 on capacity.

### Per-channel detail

#### channel-email

- **Inbound**: IMAP IDLE on configured folder. New `EXISTS` event → fetch UID → parse MIME → `normalize()` → emit `KoiMessage`.
- **Outbound**: SMTP via injected `smtp.sendMail` with a **persistent outbox** for crash safety:
  1. Pre-generate a stable outbound `Message-ID` (`<uuid@configured-from-domain>`).
  2. CAS-write an `outbox` record `{ messageId, threadKey, expectedThreadVersion, payloadHash, status: "pending" }` via `OutboxStore` (injected; default in-memory).
  3. Call `smtp.sendMail` setting that `Message-ID`, `In-Reply-To`, and `References`.
  4. On SMTP success: CAS-update outbox `status: "sent"` and CAS-advance `ThreadStore` with the new chain entry. Both updates use the version recorded at step 2 so concurrent senders cannot race.
  5. On SMTP failure or crash: outbox row stays `pending`; on recovery, the channel scans `pending` rows and either retries the send (SMTP servers are required to dedupe by `Message-ID` per RFC 5321 ESMTP, so a duplicate hop is collapsed) or marks `failed` after a bounded retry budget.
- **Recovery semantics**: because the outbound `Message-ID` is generated *before* SMTP and is included in `From`-side dedupe responsibility, a retry of step 3 with the same `Message-ID` is the standard idempotent-resend pattern; relays that respect the message-id collapse on their end. Threading state is only advanced on confirmed-sent, so a crashed-mid-send never leaves stale `In-Reply-To` pointers.
- **Threading**: keyed by root `Message-ID` of the chain. **Durable + concurrency-safe**: outbound `In-Reply-To`/`References` derive from persisted message metadata, not from in-process state. The channel exposes a `ThreadStore` interface with CAS semantics:

  ```ts
  interface ThreadStore {
    get(threadKey: string): Promise<{ state: ThreadState; version: number } | null>;
    // Compare-and-set: persist new state only if stored version === expectedVersion.
    // Returns true on success, false if a concurrent writer advanced the version.
    // Callers retry the read-modify-write loop on false.
    cas(threadKey: string, expectedVersion: number, next: ThreadState): Promise<boolean>;
  }
  ```

  The append-only field of `ThreadState` is the chain of seen `Message-ID`s; a CAS conflict means another worker added a sibling reply concurrently, and the loser re-reads and re-appends. Default in-process `MapThreadStore` provides CAS via a synchronous Map mutex — single-worker safe only and emits a startup warning. Multi-instance deployments inject a durable CAS-backed store. Pure threading-key logic in `threading.ts` is store-agnostic.
- **Config**: `{ imap: { host, port, user, pass, mailbox }, smtp: { host, port, user, pass, from }, pollInterval? }`.
- **Errors**: `INVALID_CONFIG`, `AUTH_FAILED`, `CONNECTION_LOST`, `PARSE_FAILED`, `SEND_FAILED`.

#### channel-teams

- **Inbound**: HTTP webhook handler. POST `/api/messages` → verify Bot Framework JWT → parse Activity → `normalize()`.
- **Outbound**: POST `{activity.serviceUrl}/v3/conversations/{id}/activities`. Bearer token from injected `tokenVerifier.appToken()`.
- **Format**: text + Adaptive Card v1.5 in `format.ts`. Block kit-style mapper from `ContentBlock[]`.
- **Threading**: `conversation.id` is the thread key.
- **Config**: `{ appId, appPassword, tenantAllowlist: string[], cloud?: "public" | "gov" | { issuer: string, jwksUri: string }, serviceUrlAllowlist: ServiceUrlPattern[] }`. `tenantAllowlist` and `serviceUrlAllowlist` are required (use `["*"]` for tenant to opt into multi-tenant explicitly). `cloud` defaults to `"public"` (issuer `https://api.botframework.com`, JWKS from official discovery doc); `"gov"` is the US-Gov profile; an inline `{ issuer, jwksUri }` is for self-hosted/test clouds and **both must be set together** — never just one.
- **`ServiceUrlPattern`**: `{ scheme: "https", host: string, hostMatch: "exact" | "subdomain" }`. `"subdomain"` matches the literal host plus dot-boundary descendants (`a.example.com` matches `*.a.example.com` but NOT `evila.example.com`). Plain string suffix match is forbidden.
- **Auth invariants** (verify in this exact order, reject with `AUTH_FAILED` on any failure):
  1. JWT signature valid against the issuer-paired JWKS (resolved from `cloud`).
  2. `aud` claim equals configured `appId` — rejects forged-from-other-bot tokens.
  3. `tid` claim is in `tenantAllowlist` (if not `["*"]`) — rejects cross-tenant activities.
  4. `iss` claim matches the issuer paired with `cloud` — rejects gov tokens on public bots and vice versa.
  5. `exp`/`nbf` within clock skew (60s).
  6. Activity body's `serviceUrl` parses as an HTTPS URL whose normalized origin (`scheme://host`, lowercased, default port stripped) matches a `ServiceUrlPattern` per the rules above — rejects bearer-token exfiltration via attacker-controlled `serviceUrl`.
- **Errors**: `INVALID_JWT`, `AUDIENCE_MISMATCH`, `TENANT_NOT_ALLOWED`, `SERVICE_URL_NOT_ALLOWED`, `AUTH_FAILED`, `INVALID_ACTIVITY`, `SEND_FAILED`.

#### channel-whatsapp

- **Inbound**: HTTP webhook (Meta Cloud API).
  - GET `/webhook?hub.verify_token=…` → handshake echo `hub.challenge`.
  - POST `/webhook` → validate `X-Hub-Signature-256` HMAC over raw body → parse `entry[].changes[].value.messages[]` → `normalize()`. Replay protection is provided by durable WAMID-keyed idempotency claim (above), not by a freshness timestamp — Meta does not include one in the signed envelope.
- **Outbound**: POST `https://graph.facebook.com/v18.0/{phoneNumberId}/messages`. Bearer token.
- **Format**: text, template, image/document/audio (URL-only — no upload).
- **Threading**: `wa_id` (E.164 phone) + optional `context.message_id` for replies.
- **Config**: `{ phoneNumberId, accessToken, verifyToken, appSecret, graphBaseUrl? }`.
- **Errors**: `INVALID_SIGNATURE`, `INVALID_TOKEN`, `RATE_LIMITED`, `SEND_FAILED`.

### Shared concerns

- **Rate limiting**: each channel composes `@koi/channel-base/rate-limit` with platform-appropriate limits (e.g., WhatsApp 80 msg/sec/number; Teams 600/30s/conversation).
- **Error formatting**: each maps platform errors via `@koi/channel-base/format-error`.
- **Block rendering**: Slack-style `ContentBlock[]` → platform format via `@koi/channel-base/render-blocks` where applicable.
- **Errors model**: expected failures return `Result<T, KoiError>`; infrastructure failures throw with ES2022 `cause`.

### Inbound idempotency (required for all three channels)

Webhooks are routinely retried on timeout/non-2xx, and IMAP can re-deliver on
reconnect. Without dedupe the agent emits duplicate `KoiMessage` events,
producing duplicate downstream actions and outbound replies. Each channel
**must** dedupe before calling the user's `onMessage` handler.

| Channel | Idempotency key | Notes |
|---------|-----------------|-------|
| email | `mailbox-host \| account \| UIDVALIDITY \| UID` (primary) | IMAP guarantees `(UIDVALIDITY, UID)` uniqueness within a mailbox; this is the durable, collision-free identifier. Optionally cross-checked with `Message-ID` for diagnostics, but the IMAP UID pair is the dedupe key. Mailbox rebuild changes UIDVALIDITY, which legitimately requires a fresh dedupe horizon (operator-acknowledged). No coarse-header fallback — if the IMAP server provides no UID (POP3 or pathological IMAP), the channel rejects ingestion at config time with `UNSUPPORTED_TRANSPORT` rather than silently risking suppression. |
| teams | `channelId \| tid \| conversation.id \| activity.id` | Bot Framework guarantees `activity.id` uniqueness only within a (channel, account, conversation) tuple. Including all four matches the documented uniqueness domain so two conversations with the same `activity.id` both dispatch. |
| whatsapp | `phone_number_id \| messages[].id` | WAMIDs are unique per business phone; including the receiving phone scopes correctly across multi-number deployments. |

Each package exposes an `IdempotencyStore` with a **two-phase reservation**
lifecycle so transient failures don't burn legitimate retries:

```ts
interface IdempotencyStore {
  // Atomically reserve the key with a short lease (leaseMs).
  // - Returns { ok: true, lease } if no live record exists.
  // - Returns { ok: false, reason: "in-flight" } if another worker currently holds a lease.
  // - Returns { ok: false, reason: "committed" } if the key was already committed within commitTtlMs.
  // CAS-based; at most one caller observes ok:true per (key, generation).
  tryBegin(key: string, leaseMs: number): Promise<TryBeginResult>;

  // Promote a held lease to a committed record retained for commitTtlMs.
  commit(lease: Lease, commitTtlMs: number): Promise<void>;

  // Release a held lease so the next provider retry can re-attempt.
  // Used on transient failure after auth/normalize/onMessage throws.
  abort(lease: Lease): Promise<void>;

  // Optional: extend a lease for long-running handler dispatch.
  renew(lease: Lease, leaseMs: number): Promise<void>;
}
```

**Inbound flow + handler-outcome binding**. The current `ChannelAdapter` `onMessage` callback is fire-and-forget — its outcome cannot drive an HTTP response. To make retry semantics enforceable, each enterprise channel ships its own webhook HTTP handler (not the generic `ChannelAdapter` dispatch path) that *awaits* the user-supplied async handler before returning a status:

1. `auth/verify` → on failure return 401/403, no idempotency interaction.
2. `tryBegin(key, leaseMs)`:
   - `committed`: 200 OK, silently drop (true duplicate).
   - `in-flight`: 409 — provider retries (Teams + WhatsApp both retry 4xx other than 4xx-final).
   - `capacity-exhausted`: 503 — provider retries; emit operator alert.
   - `ok`: continue.
3. `await normalize(payload)` → `await handler(message)` (the user's async `onMessage`).
4. On success: `commit(lease, commitTtlMs)` → 200 OK.
5. On thrown error: `abort(lease)` → 500 — provider retries.

Email is **IMAP-backed, not webhook-backed**, so it has no HTTP response to bind. Its loop instead awaits the handler, then `commit`s on success or `abort`s on failure, leaving the IMAP `\Seen` flag unset on abort so the next IMAP fetch re-delivers. Lease TTL is bounded so a crashed worker's lease expires and the next IMAP poll re-claims.

`leaseMs` covers the synchronous handler dispatch window (default 30s, renew with `renew()` for long handlers).

**`commitTtlMs` per channel**:

| Channel | `commitTtlMs` default | Rationale |
|---------|-----------------------|-----------|
| teams | 24h | Bot Framework retry budget is hours; 24h covers all observed retries with margin. |
| whatsapp | 7 days | Meta Cloud API may retry within minutes, but full WAMID dedupe survives tenant moves and disaster recovery for a week. |
| email | **`Infinity` (never expire by default)** | IMAP can re-deliver the same `Message-ID` weeks/months later via reconnect, mailbox rescan, replication failover, or backup restore. Reprocessing historical mail at the 24h boundary triggers duplicate replies and tool calls. Operators may set a finite value when paired with a known-bounded mailbox retention. The default in-memory store still respects `maxCommittedRecords`; durable email deployments must supply a store that retains for the mailbox retention horizon. |

Tests cover: concurrent `tryBegin` (exactly one `ok`), transient handler failure (`abort` releases key, retry succeeds), commit (retry after commit is a true no-op duplicate), and email replay 30+ days later still suppressed (with the default `Infinity` TTL).

**Default store**: `InMemoryIdempotencyStore` — a single-worker store backed by
two Maps (live leases + committed keys). It is **fail-closed** at a configured
capacity (`maxCommittedRecords`, default 100_000): when full, `tryBegin` returns
`{ ok: false, reason: "capacity-exhausted" }` and the channel responds non-2xx
so the provider retries later (operator alert + scale durable store). It does
**not** evict committed records via LRU — silent eviction would silently restore
duplicate-delivery hazards. Multi-worker deployments must inject a durable
CAS-backed store; this is documented in the package README and verified by an
integration test asserting capacity-exhausted is observable.

Outbound retry is the caller's concern: `send()` is idempotent at the platform
level only when the platform supports it (WhatsApp `messaging_product`/`to`+
client-supplied `biz_opaque_callback_data`; Teams via `replyToId`); SMTP is not
naturally idempotent and the spec does not promise it.

## Data flow

```
Inbound:  transport → verify → parse → normalize → KoiMessage → onMessage(handler)
Outbound: send(KoiMessage) → format → rate-limit → platform-send → Result<SendOk>
```

## Testing

Per CLAUDE.md Doc → Tests → Code, every behavior gets a failing test before code.

### Unit tests (colocated)

- `config.test.ts` — Zod schema accepts/rejects valid/invalid configs.
- `normalize.test.ts` — every platform message shape → expected `KoiMessage`.
- `format.test.ts` — every `ContentBlock` → expected platform payload.
- `platform-send.test.ts` — success path, retryable failure, non-retryable failure, signature failures.
- `threading.test.ts` (email only) — chain extension and root resolution.
- `verify-jwt.test.ts` (teams) — valid/invalid/expired tokens, audience mismatch, tenant not allowed, service-URL not allowed, issuer mismatch, clock skew bounds.
- `verify-signature.test.ts` (whatsapp) — HMAC pass/fail, missing header, body-mutation rejection.
- `idempotency.test.ts` (each channel) — first delivery emits `onMessage` and commits; retried delivery with the same key after commit is silently dropped; key extraction handles missing/malformed identifiers; expiry of a committed record after `commitTtlMs` allows re-delivery; concurrent `tryBegin` resolves with exactly one `ok:true`; transient handler failure aborts the lease and the provider retry succeeds; capacity exhaustion returns `capacity-exhausted` and surfaces non-2xx.

### Integration (`__tests__/integration.test.ts`)

For each channel: build channel via factory with **fake** transports → handshake → receive a known message → assert `onMessage` payload → call `send()` → assert outbound transport call.

Adversarial scenarios (also integration-level):
- **Email**: IMAP reconnect re-delivers same UID — handler called once. Process-restart simulation: rebuild channel with same durable `ThreadStore`, send reply, assert `In-Reply-To` matches inbound `Message-ID`.
- **Teams**: token with wrong `aud` rejected with `AUDIENCE_MISMATCH`; activity with `serviceUrl` outside allowlist rejected with `SERVICE_URL_NOT_ALLOWED` (no outbound bearer leak); duplicate `activity.id` only emits once.
- **WhatsApp**: webhook retry with same `messages[].id` only emits once (replay protection comes from durable WAMID dedupe — no signature timestamp is available).
- **All channels**: concurrent duplicate deliveries — fire two parallel webhook POSTs with the same idempotency key and assert `onMessage` is invoked exactly once, proving the atomic `tryBegin` contract.
- **All channels**: transient handler failure — handler throws on first delivery; `abort(lease)` is called; re-deliver same payload, assert `onMessage` is invoked exactly once *successfully* (no message loss).
- **All channels**: capacity exhaustion — fill `InMemoryIdempotencyStore` to `maxCommittedRecords`, assert next `tryBegin` returns `capacity-exhausted` and channel returns non-2xx (no silent eviction of committed records).
- **Teams**: two messages with identical `activity.id` but different `conversation.id` — both dispatch (proves dedupe key includes full uniqueness domain).

### Coverage gate

`bunfig.toml` enforces ≥80% lines/functions/statements per package.

### API surface (`__tests__/api-surface.test.ts`)

Snapshot test on the package's public exports. Fails on accidental surface changes.

### Golden queries (`@koi/runtime`)

Two standalone queries per package added to `packages/meta/runtime/src/__tests__/golden-replay.test.ts`, matching the existing pattern for `channel-slack`/`channel-cli`/`channel-web`. No LLM cassette needed (channels run without a model).

Per channel:
1. **Construct + descriptor query**: factory imports cleanly, descriptor exposes expected shape.
2. **Inbound normalize round-trip**: a captured platform fixture → `normalize()` → assert exact `KoiMessage`.

## CI gates (must all pass)

```
bun run test                    # unit + integration
bun run typecheck               # strict TS6
bun run lint                    # Biome
bun run check:layers            # L2 layer rules
bun run check:unused            # no dead exports
bun run check:duplicates        # no copy-paste blocks
bun run check:orphans           # each package wired into @koi/runtime
bun run check:golden-queries    # each package has golden assertions
bun run test --filter=@koi/runtime
```

## Dependencies introduced

| Package | Runtime deps added | Justification |
|---------|--------------------|---------------|
| channel-email | `imapflow@1.0.171`, `mailparser@3.7.2`, `nodemailer@6.10.1` | IMAP IDLE, MIME parsing, SMTP — no Bun native equivalent. |
| channel-email (dev) | `@types/nodemailer@6.4.17` | nodemailer ships no types. |
| channel-teams | `jose@6.2.1` | JWKS-backed JWT verify. Bun has WebCrypto but no JWKS resolver. |
| channel-whatsapp | none | Uses `fetch` + `Bun.CryptoHasher` for HMAC. |

All pinned exactly per `bunfig.toml` policy.

## File budget

Per CLAUDE.md: < 400 lines/file (800 hard max), < 50 lines/function. Expected per-package source size:

| Package | Source LOC (est.) | Test LOC (est.) |
|---------|-------------------|-----------------|
| channel-email | ~700 | ~900 |
| channel-teams | ~600 | ~700 |
| channel-whatsapp | ~600 | ~800 |

Total ~2300 source / ~2400 test. Larger than issue's 800 LOC estimate because the
issue under-counts; v1 archive sources are the floor.

## Risks

| Risk | Mitigation |
|------|------------|
| Bun + `imapflow` IDLE compatibility unknown | Inject transport interface; default adapter wraps imapflow but tests use fake; fall back to polling if IDLE breaks. |
| Meta Graph API surface drift | Pin API version in config (`graphBaseUrl` includes `/v18.0`). |
| Bot Framework JWKS rotation | Cache via `jose.createRemoteJWKSet` with default 5min refresh. |
| Layer leak via SDK types | Wrap every SDK behind a local interface in `*.ts`; never re-export SDK types. |

## Roll-out

1. Land all three packages in one PR (groups by issue + shared `@koi/channel-base` patterns review benefits).
2. Update `@koi/runtime` deps + golden queries in same PR.
3. After merge, separate PR adds `docs/L2/channel-{email,teams,whatsapp}.md` walkthroughs.

## References

- Issue: https://github.com/windoliver/koi/issues/1363
- v1 sources: `archive/v1/packages/net/channel-{email,teams,whatsapp}/`
- v2 reference impl: `packages/lib/channel-slack/`
- Existing channel-base: `packages/lib/channel-base/`
- Decompiled CC: `/Users/sophiawj/private/claude-code-source-code` (patterns reference)
