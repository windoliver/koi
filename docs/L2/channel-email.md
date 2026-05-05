# @koi/channel-email

L2 channel adapter for email (IMAP IDLE inbound, SMTP outbound).

## Purpose

Bidirectional email integration with RFC 5322 thread tracking. Designed for
agent deployments that need durable, crash-safe email conversations.

## Public API

- `createEmailChannel(config, deps): EmailChannelAdapter` — factory.
- `EmailDescriptor` — manifest binding.
- `EmailConfig`, `EmailChannelAdapter`, `EmailDependencies`.

See `src/index.ts` for the full export list once implementation lands.

## Required dependencies (DI)

- `imap`, `smtp`, `parser` — transport adapters wrapping `imapflow`,
  `nodemailer`, `mailparser` respectively.
- `threadStore`, `outboxStore` — CAS-backed; mandatory for production.
- `idempotencyStore`, `ingressQueue` — durable required; in-memory rejected
  by config validation when `production: true`.
- `idGenerator` — outbound `Message-ID` generator (default UUID).
- `clock` — injected `() => number`; defaults to `Date.now`.

## Error codes

`INVALID_CONFIG`, `AUTH_FAILED`, `CONNECTION_LOST`, `PARSE_FAILED`,
`SEND_FAILED`, `UNSUPPORTED_TRANSPORT`, `THREAD_BLOCKED_PENDING_RECOVERY`,
`RECOVERY_CONFLICT`, `ALREADY_RESOLVED`.

## Outbound state machine

`reserved → sending → sent | aborted | awaiting-recovery`.
See `docs/superpowers/specs/2026-05-05-issue-1363-enterprise-channels-design.md`
for full transition rules and recovery semantics (`resolvePending`).

## Operational notes

- IMAP transport must support UIDVALIDITY+UID dedupe; POP3 is rejected at
  config time with `UNSUPPORTED_TRANSPORT`.
- `getPendingSends()` and `resolvePending(messageId, outcome)` are operator
  APIs; do not call from agent handlers.
- `autoRetryAfterDataAck` is `false` by default; enabling it accepts duplicate
  user-visible mail risk.
