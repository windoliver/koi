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
  index.ts                 — public exports (factory + descriptor only)
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
| email | `{ imap: ImapClient, smtp: SmtpTransport, parser: MimeParser, clock?: () => number }` |
| teams | `{ tokenVerifier: JwtVerifier, fetch: typeof fetch, clock?: () => number }` |
| whatsapp | `{ fetch: typeof fetch, clock?: () => number }` |

`ImapClient`, `SmtpTransport`, `MimeParser`, `JwtVerifier` are **local interfaces**
defined in each package. Default factory adapters wrap `imapflow`, `nodemailer`,
`mailparser`, `jose` — but the interfaces themselves do not leak vendor types.

### Per-channel detail

#### channel-email

- **Inbound**: IMAP IDLE on configured folder. New `EXISTS` event → fetch UID → parse MIME → `normalize()` → emit `KoiMessage`.
- **Outbound**: SMTP via injected `smtp.sendMail`. Sets `In-Reply-To` and `References` headers from threading state.
- **Threading**: keyed by root `Message-ID` of the chain. State lives in `Map<threadKey, lastMessageId>` per channel instance. Pure logic in `threading.ts`.
- **Config**: `{ imap: { host, port, user, pass, mailbox }, smtp: { host, port, user, pass, from }, pollInterval? }`.
- **Errors**: `INVALID_CONFIG`, `AUTH_FAILED`, `CONNECTION_LOST`, `PARSE_FAILED`, `SEND_FAILED`.

#### channel-teams

- **Inbound**: HTTP webhook handler. POST `/api/messages` → verify Bot Framework JWT (issuer `https://api.botframework.com`) via `jose` JWKS → parse Activity → `normalize()`.
- **Outbound**: POST `{activity.serviceUrl}/v3/conversations/{id}/activities`. Bearer token from injected `tokenVerifier.appToken()`.
- **Format**: text + Adaptive Card v1.5 in `format.ts`. Block kit-style mapper from `ContentBlock[]`.
- **Threading**: `conversation.id` is the thread key.
- **Config**: `{ appId, appPassword, tenantId?, jwksUri? }`.
- **Errors**: `INVALID_JWT`, `AUTH_FAILED`, `INVALID_ACTIVITY`, `SEND_FAILED`.

#### channel-whatsapp

- **Inbound**: HTTP webhook (Meta Cloud API).
  - GET `/webhook?hub.verify_token=…` → handshake echo `hub.challenge`.
  - POST `/webhook` → validate `X-Hub-Signature-256` HMAC → parse `entry[].changes[].value.messages[]` → `normalize()`.
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
- `verify-jwt.test.ts` (teams) — valid/invalid/expired tokens.
- `verify-signature.test.ts` (whatsapp) — HMAC pass/fail, missing header, replay window.

### Integration (`__tests__/integration.test.ts`)

For each channel: build channel via factory with **fake** transports → handshake → receive a known message → assert `onMessage` payload → call `send()` → assert outbound transport call.

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
