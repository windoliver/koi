# @koi/channel-teams

L2 channel adapter for Microsoft Teams (Bot Framework webhook + Adaptive Cards).

## Purpose

Bidirectional Teams integration via the Bot Framework Activity Protocol. The
channel verifies inbound webhook JWTs against the configured cloud's JWKS,
persists the verified `serviceUrl` per conversation, and routes outbound
messages through that durable address — never the inbound activity in scope.

## Public API

- `createTeamsChannel(config, deps): TeamsChannelAdapter` — factory.
- `validateTeamsConfig(input): Result<TeamsConfig>` — Zod-backed validator.
- `createTokenVerifier(config, options?): JwtVerifier` — default `jose`-backed verifier.
- `matchServiceUrl(url, allowlist): boolean` — pure URL allowlist check.
- `TeamsConfig`, `TeamsChannelAdapter`, `TeamsDependencies`, `TeamsErrorCode`,
  `Activity`, `ServiceUrlPattern`, `JwtVerifier`, `VerifyResult`.

See `src/index.ts` for the full export list.

## Required dependencies (DI)

- `tokenVerifier` — verifies Bot Framework JWTs and mints app-bearer tokens.
  The package ships `createTokenVerifier` (jose JWKS resolver) but tests
  inject fakes.
- `fetch` — `typeof globalThis.fetch`. Outbound POSTs to `serviceUrl`.
- `idempotencyStore`, `ingressQueue` — durable required for production.
  Webhooks are routinely retried; without dedupe duplicate `KoiMessage`
  events occur.
- `conversationAddressStore` — durable map of `conversation.id` →
  `ConversationAddress` (`serviceUrl`, `tenantId`, `channelId`, `recipient`).
  `send()` resolves outbound addresses through this store; an unknown
  conversation surfaces `CONVERSATION_ADDRESS_UNKNOWN`.
- `clock` — `() => number`; defaults to `Date.now`.

## Error codes

`INVALID_CONFIG`, `AUTH_FAILED`, `INVALID_JWT`, `AUDIENCE_MISMATCH`,
`TENANT_NOT_ALLOWED`, `SERVICE_URL_NOT_ALLOWED`, `INVALID_ACTIVITY`,
`SEND_FAILED`, `CONVERSATION_ADDRESS_UNKNOWN`.

## Inbound idempotency key

`channelId | tid | conversation.id | activity.id` — Bot Framework guarantees
`activity.id` uniqueness only within a `(channel, tenant, conversation)`
tuple, so two conversations with the same `activity.id` both dispatch.

## Operational notes

- **Cloud profiles**: `cloud` defaults to `"public"` (issuer
  `https://api.botframework.com`, JWKS via Microsoft's discovery doc).
  `"gov"` selects the US-Gov profile. An inline
  `{ issuer, jwksUri }` is for self-hosted/test clouds and
  **both fields must be set together** — partial inline config is rejected
  by `validateTeamsConfig`.
- **`ServiceUrlPattern` matching**: `hostMatch: "exact"` requires an exact
  host match; `"subdomain"` matches the literal host plus dot-boundary
  descendants (`a.example.com` matches `*.a.example.com` but **not**
  `evila.example.com`). Plain string-suffix matching is forbidden — the
  dot-boundary check prevents bearer-token exfiltration via attacker-
  controlled `serviceUrl` values.
- **`ConversationAddressStore` durability**: required to be durable for
  production deployments. The package ships `InMemoryConversationAddressStore`
  (re-exported from `@koi/channel-base`) for tests/dev only.

See `docs/superpowers/specs/2026-05-05-issue-1363-enterprise-channels-design.md`
for the full auth, dedupe, and outbound semantics.
