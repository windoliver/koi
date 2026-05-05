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
| email | `{ imap: ImapClient, smtp: SmtpTransport, parser: MimeParser, threadStore: ThreadStore, outboxStore: OutboxStore, idempotencyStore: IdempotencyStore, ingressQueue: IngressQueue, idGenerator?: () => string, clock?: () => number }` |
| teams | `{ tokenVerifier: JwtVerifier, fetch: typeof fetch, idempotencyStore: IdempotencyStore, conversationAddressStore: ConversationAddressStore, ingressQueue: IngressQueue, clock?: () => number }` |
| whatsapp | `{ fetch: typeof fetch, idempotencyStore: IdempotencyStore, ingressQueue: IngressQueue, clock?: () => number }` |

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

This handler executes the auth → `tryBegin` → `await onMessage` → commit/abort
flow described below; the HTTP `Response` reflects the handler's outcome
deterministically. Email has no `handleHttpRequest` because it is IMAP-driven.

**Host integration is out of scope for this PR.** Like `channel-slack` today, the
host (a `Bun.serve` wrapper, an integration test, or a gateway) is responsible
for binding `channel.handleHttpRequest` to the appropriate route
(`POST /api/messages` for Teams, `GET|POST /webhook` for WhatsApp). `@koi/runtime`
currently exposes the `ChannelAdapter` as-is and does not own HTTP ingress
routing — adding generic webhook route registration to the runtime is a separate
follow-up (tracked outside this issue). What this PR delivers in `@koi/runtime`
is the same as for `channel-slack`: the package is a declared dependency, two
standalone golden queries assert factory + descriptor + `handleHttpRequest`
contract, and the channel can be constructed and exercised end-to-end via
synthetic `Request` objects in tests.

The package's `index.ts` re-exports `handleHttpRequest`-shaped types
(`WebhookRequest`, `WebhookResponse` aliases of standard `Request`/`Response`)
so future host integrations do not depend on `@koi/channel-base` internals.
The golden-replay tests for each webhook channel call `handleHttpRequest`
directly with synthetic `Request` objects and assert: 200 on commit, 401/403 on
auth failure, 503 on in-flight (matches retryable-by-Teams/WhatsApp contract), 500 on handler throw, 503 on capacity.

### Per-channel detail

#### channel-email

- **Inbound**: IMAP IDLE on configured folder. New `EXISTS` event → fetch UID → parse MIME → `normalize()` → emit `KoiMessage`.
- **Outbound**: explicit state machine with **per-thread serialization** for header-derivation correctness and **outbox persistence** for crash safety. Each outbound send transitions through exactly one of these states:

  | State | Meaning | Allowed transitions |
  |-------|---------|---------------------|
  | `reserved` | Thread CAS-advanced (tentative `Message-ID` in chain); outbox row written; SMTP not yet attempted. | → `sending`, → `aborted` |
  | `sending` | SMTP DATA write in progress. | → `sent`, → `aborted` (pre-DATA only), → `awaiting-recovery` (post-DATA crash) |
  | `sent` | Relay returned `250 OK`; outbox status durable. | terminal |
  | `aborted` | **Pre-DATA** SMTP failure (connection refused, 4xx/5xx pre-DATA, validation reject). Tentative thread reservation rolled back. | terminal — caller may retry as a fresh send (new `Message-ID`) |
  | `awaiting-recovery` | Process crash or socket drop **after** DATA write started but before our `sent` write. | terminal until operator resolves via `resolvePending(messageId, "sent" \| "failed")` |

  **Transitions** (each is an atomic CAS write; no two transitions overlap):

  1. **`(none) → reserved`**: pre-generate `Message-ID = <uuid@from-domain>`. Loop: read `ThreadStore.get(threadKey)` → derive headers → CAS-advance to a new tentative version that includes this `Message-ID`. On CAS conflict, re-read and re-derive headers (this is the only point where headers can be re-derived). On CAS success, write `OutboxStore` row `{ messageId, threadKey, threadVersion, payloadHash, status: "reserved" }`.
  2. **`reserved → sending`**: single CAS write to outbox flipping `status: "sending"` immediately before invoking `smtp.sendMail`.
  3. **`sending → sent`**: relay returned `250 OK`. CAS outbox to `status: "sent"`. Thread state was already advanced in step 1 — no further `ThreadStore` write.
  4. **`reserved → aborted` OR `sending → aborted`** (pre-DATA failure only — see classification below): CAS outbox to `status: "aborted"`. Best-effort CAS-rollback `ThreadStore` to the prior version (skip silently if a concurrent sender advanced past us — the reserved chain entry becomes a benign hole since no email carrying that `Message-ID` exists). Caller may retry as a fresh send.
  5. **`sending → awaiting-recovery`**: process crash or socket drop after the SMTP DATA octet stream began but before `250 OK` was acknowledged into our outbox. Detected at startup by scanning outbox for `status: "sending"`. Channel does **not** auto-resend (SMTP `Message-ID` is not a protocol idempotency key per RFC 5321). `getPendingSends()` exposes the row; the thread is **blocked** for any further outbound sends until resolved (`send()` returns `Result<…, KoiError>` with code `THREAD_BLOCKED_PENDING_RECOVERY`). Resolution is operator-driven via:

     ```ts
     resolvePending(messageId: string, outcome: "sent" | "failed"): Promise<void>;
     ```

     The resolution is itself a state transition with strict thread-store semantics:

     - **`awaiting-recovery → sent` (operator confirms relay accepted via mailbox/MTA logs)**: CAS outbox to `status: "sent"`. Thread reservation from step 1 stands as the new chain head. Thread unblocks. Future replies derive `In-Reply-To`/`References` including this `Message-ID`.
     - **`awaiting-recovery → failed` (operator confirms relay did not accept)**: CAS outbox to `status: "failed"`. Atomically CAS-rollback `ThreadStore` to remove this `Message-ID` from the chain (best-effort: if a concurrent reply has reserved a *new* tentative entry built on top of this one, rollback is rejected with `RECOVERY_CONFLICT` and the operator must resolve later sends first; the system never silently corrupts ancestry). Thread unblocks once the rollback succeeds. Future replies derive headers from the pre-reservation chain head.

     Both branches are atomic across `OutboxStore` + `ThreadStore` writes via per-thread serialization at the in-process level; durable stores must support the same per-thread linearization (operator's `ThreadStore` choice). `resolvePending` is idempotent — calling it twice with the same outcome is a no-op; calling with a different outcome on an already-resolved row returns `ALREADY_RESOLVED`. Tests cover both branches across simulated process restarts.

  **Pre-DATA vs post-DATA classification**: the SMTP transport adapter exposes `await smtp.sendMail(...)` which resolves with `{ phase: "pre-data" | "post-data", ok: boolean, error? }`. The state machine reads `phase` to choose `aborted` (pre-DATA) vs `awaiting-recovery` (post-DATA crash). nodemailer's events expose enough information to populate `phase`; the wrapper lives in `platform-send.ts`.

- **Delivery guarantee**: **at-most-once acknowledged delivery** (no automated post-DATA retry by default) + **at-least-once intent persistence** (outbox is durable; nothing is dropped silently). Operators may opt into automated post-DATA retry via `autoRetryAfterDataAck: true` (default `false`), accepting the risk of duplicate user-visible mail.

- **Threading**: state advances exactly once per send, in transition 1. Header derivation is locked at that point. `aborted` triggers rollback; `awaiting-recovery` holds the reservation until operator resolution. No code path can ever advance the thread *after* SMTP success because step 1 already did so. The channel exposes a `ThreadStore` interface with CAS semantics:

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

- **Inbound**: HTTP webhook handler. POST `/api/messages` → verify Bot Framework JWT → parse Activity → **persist conversation address** (see below) → `normalize()`.
- **Outbound**: POST `{address.serviceUrl}/v3/conversations/{id}/activities` where `address` is loaded from the **`ConversationAddressStore`**, not from the inbound activity in scope. Bearer token from injected `tokenVerifier.appToken()`.
- **Conversation address store**: required at construction. Interface:

  ```ts
  interface ConversationAddressStore {
    // Persist or refresh the address for a conversation seen on inbound.
    put(conversationId: string, address: ConversationAddress): Promise<void>;
    // Load address for a later send. Returns null if unknown/stale.
    get(conversationId: string): Promise<ConversationAddress | null>;
  }
  type ConversationAddress = {
    readonly serviceUrl: string;        // already validated against serviceUrlAllowlist
    readonly tenantId: string;
    readonly channelId: string;         // bot framework channel (msteams, slack-via-bf, etc.)
    readonly recipient: { readonly id: string; readonly name?: string };
    readonly lastSeenAt: number;        // ms epoch; for staleness eviction by operator
  };
  ```

  On inbound, the channel calls `put()` after JWT + serviceUrl-allowlist verification — only verified addresses are persisted, so a later `send()` cannot route to an unverified `serviceUrl`. On outbound, the channel calls `get()`; if it returns `null`, `send()` returns `Result<…, KoiError>` with code `CONVERSATION_ADDRESS_UNKNOWN` (caller may have lost a conversation that predates this deployment, or addresses were manually purged). The store is **required** to be durable for production deployments; the package ships an `InMemoryConversationAddressStore` for tests/dev only and the factory rejects production configs paired with it (analogous to the `IdempotencyStore` rule).
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

  // Extend a lease (called automatically by the channel; not user-visible).
  renew(lease: Lease, leaseMs: number): Promise<void>;
}
```

**Lease renewal is automatic and channel-managed.** While `await handler(message)` runs, the channel sets a renewal interval at `leaseMs / 3` (default 10s for a 30s lease) that calls `renew(lease, leaseMs)` until the handler resolves, throws, or the channel-level `handlerTimeoutMs` (default 5 minutes) elapses. If renewal itself fails (durable store unavailable), the channel cancels the in-flight handler via `AbortSignal` and returns 500 — never silently allowing the lease to expire under an active handler. If the handler exceeds `handlerTimeoutMs`, the channel aborts it and returns 500. This guarantees: a duplicate cannot acquire the key while a handler is still running, full stop. Users do not see, hold, or renew leases.

**Inbound flow + handler-outcome binding**. The current `ChannelAdapter` `onMessage` callback is fire-and-forget — its outcome cannot drive an HTTP response. To make retry semantics enforceable, each enterprise channel ships its own webhook HTTP handler (not the generic `ChannelAdapter` dispatch path) that *awaits* the user-supplied async handler before returning a status:

1. `auth/verify` → on failure return 401/403, no idempotency interaction.
2. `tryBegin(key, leaseMs)`:
   - `committed`: 200 OK, silently drop (true duplicate).
   - `in-flight`: short bounded wait (default 2s, ≤ provider socket timeout) polling for `committed`. If observed → 200 OK. Otherwise → **503 Service Unavailable**. Both Teams (per Microsoft Learn retry table — 502/503/504) and WhatsApp (Meta Cloud API retries 5xx) explicitly retry 503; this maps duplicate races to documented retryable behavior. **409 is not used** because Teams does not retry 409.
   - `capacity-exhausted`: 503 — provider retries; emit operator alert.
   - `ok`: continue.
3. `await normalize(payload)` → **`enqueueDurable({ key, payload, normalized })`** to an injected durable `IngressQueue`. The enqueue is atomic with the lease (same store, single CAS write). Once the queue write commits, the webhook returns **200 OK** to the provider — the message is now durably owned by the channel. The webhook does **not** invoke `handler` synchronously.
4. A separate **handler worker** (started by the channel on `connect()`) polls the queue, claims items via the same atomic `tryBegin`-style CAS, calls the user `handler(message)`, and on success calls `commit(key, commitTtlMs)` followed by `dequeue(item)`. On handler throw, the worker calls `abort(lease)` and the queue item stays available for the next worker tick (at-least-once handler invocation, but bounded by the worker's own retry budget — not by every webhook delivery).

This separation has two material effects:

- **Provider-facing path is exactly-once-acknowledged**: a transient store fault during `commit` no longer causes the provider to redeliver and re-run the handler, because the provider already got 200 OK. Subsequent provider retries see `committed` (or `in-flight` while still processing) on the next `tryBegin` and short-circuit.
- **Handler invocation is at-least-once but bounded**: only the channel's own worker can re-invoke the handler, and it does so under its own retry policy and dead-letter rules — not every duplicate webhook delivery from the provider triggers a handler run. Side effects are the user's responsibility to make idempotent against the ingress key (documented in README), but the *blast radius* of duplicate handler runs is the worker's retry count (default 3), not the provider's retry budget (which can be unbounded).

5. **Crash before `enqueueDurable` returns**: webhook returns 500, provider retries, no handler ran. Safe.
6. **Crash after `enqueueDurable` but before 200 OK reaches provider**: provider retries; on retry, `tryBegin` finds the lease still held by the dead worker (lease TTL elapsed → released) or finds the queue item already present and the inbound de-dupes via the same key. Either way, exactly one queue entry exists.
7. **Crash mid-handler (worker dies)**: lease expires; queue item still present; worker retries on restart. Handler re-runs (at-least-once); after `maxHandlerRetries` (default 3), the item moves to a dead-letter list surfaced via `getDeadLetters()`.

`IngressQueue` interface (injected; durable required for production, in-memory for tests):

```ts
interface IngressQueue {
  enqueue(key: string, item: QueueItem): Promise<{ ok: true } | { ok: false; reason: "duplicate" }>;
  // Returns next unclaimed item with a fresh lease, or null.
  claim(workerId: string, leaseMs: number): Promise<ClaimedItem | null>;
  ack(workerId: string, key: string): Promise<void>;        // success — remove item
  nack(workerId: string, key: string): Promise<void>;       // failure — release lease, increment attempt count
  deadLetter(workerId: string, key: string, reason: string): Promise<void>;
  getDeadLetters(): Promise<readonly DeadLetterItem[]>;
}
```

Telemetry: each transition (`enqueue`, `claim`, `ack`, `nack`, `dead-letter`, `commit`, `commit-failure`) emits a structured event.

This is now a **three-state pipeline: webhook 200-OK on durable enqueue → worker handler with bounded retry → committed (durable suppression).** Provider-facing duplicate suppression is exactly-once-on-ack; handler-facing is at-least-once-bounded. Side-effect bridges that need stricter exactly-once semantics layer their own outbox keyed on the ingress key (README).

Email is **IMAP-backed, not webhook-backed**, so it has no HTTP response to bind. Its loop instead awaits the handler, then `commit`s on success or `abort`s on failure, leaving the IMAP `\Seen` flag unset on abort so the next IMAP fetch re-delivers. Lease TTL is bounded so a crashed worker's lease expires and the next IMAP poll re-claims.

`leaseMs` covers the synchronous handler dispatch window (default 30s, renew with `renew()` for long handlers).

**`commitTtlMs` per channel**:

| Channel | `commitTtlMs` default | Rationale |
|---------|-----------------------|-----------|
| teams | 24h | Bot Framework retry budget is hours; 24h covers all observed retries with margin. |
| whatsapp | 7 days | Meta Cloud API may retry within minutes, but full WAMID dedupe survives tenant moves and disaster recovery for a week. |
| email | no in-process default — **a durable `IdempotencyStore` is mandatory at construction**; factory throws `INVALID_CONFIG` otherwise | IMAP can re-deliver the same UIDVALIDITY+UID weeks/months later via reconnect, mailbox rescan, replication failover, or backup restore, so committed records must outlive any in-memory cap. Pairing the in-memory `maxCommittedRecords` cap with `Infinity` retention would silently fail-closed on routine mailbox volume; the spec rules that combination out by *requiring* a durable store. The injected store's retention must cover the mailbox retention horizon (operator-configured, typically 90d–`Infinity`). The package does **not** ship a bundled "default" filesystem store, because any single-node store with `Infinity` retention either grows resident memory unboundedly (in-memory index over append-only log) or trades that for unindexed disk seeks. The package documents two operator-supplied options: (a) external KV/SQL with native TTL/range queries, or (b) a sharded filesystem store with explicit on-disk index files (e.g., one segment per UTC week, segments older than retention window are dropped). The `IdempotencyStore` interface is the contract; concrete implementations are the operator's choice and not part of this PR. |

Tests cover: concurrent `tryBegin` (exactly one `ok`), transient handler failure (`abort` releases key, retry succeeds), commit (retry after commit is a true no-op duplicate), and email replay 30+ days later still suppressed (with the default `Infinity` TTL).

**Store selection** is per-channel and enforced at construction:

- **email**: a durable `IdempotencyStore` is **mandatory** (covered above).
- **whatsapp**: a durable `IdempotencyStore` is **mandatory**. At a documented platform ceiling of 80 msg/sec/number × 7 days, the committed-record working set can approach ~50M entries per number; no in-memory cap can cover that. Factory throws `INVALID_CONFIG` if an in-memory store is passed.
- **teams**: a durable `IdempotencyStore` is **mandatory** when `expectedTrafficPerSec > 1` (operator-declared in config) or unconditionally for production deployments. Bot Framework retry rates can be bursty and the 24h horizon × multi-conversation traffic likewise exceeds any safe in-memory cap. Factory throws `INVALID_CONFIG` if `expectedTrafficPerSec * 86400 * commitTtlMs/86400 > maxCommittedRecords` of the supplied store.

The package ships an `InMemoryIdempotencyStore` for **tests and local development only** (size 10_000, fail-closed when full, no LRU eviction — silent eviction would silently restore duplicate-delivery hazards). It is *not* the production default for any of the three channels. The README and config Zod schema both document this; integration tests assert that production-config + in-memory store rejects at construction.

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
