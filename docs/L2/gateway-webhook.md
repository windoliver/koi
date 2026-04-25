# @koi/gateway-webhook — Webhook HTTP Ingestion

Converts inbound HTTP POST requests from external services (Slack, GitHub, Stripe, etc.) into `GatewayFrame` events dispatched through the gateway pipeline. Extracts routing context (channel, account, peer) from the URL path.

---

## Why It Exists

Koi agents need to react to external events — a Slack message, a GitHub PR comment, a Stripe payment. These arrive as HTTP webhooks. This package:

- **Normalizes** webhook payloads into `GatewayFrame` events
- **Extracts routing context** from URL path segments (`/webhook/:channel/:account`)
- **Authenticates** requests via pluggable `WebhookAuthenticator`
- **Dispatches** through the same pipeline as WebSocket frames

Previously embedded in `@koi/gateway`, extracting it enables independent deployment and optional disabling without touching core gateway code.

---

## Architecture

`@koi/gateway-webhook` is an **L2 feature package** — depends on `@koi/core` (L0) and `@koi/gateway-types` (L0u).

```
┌──────────────────────────────────────────────────────┐
│  @koi/gateway-webhook  (L2)                          │
│                                                      │
│  webhook.ts       ← HTTP server + dispatcher         │
│  http-helpers.ts  ← JSON response, body parse        │
│  index.ts         ← public API surface               │
│                                                      │
├──────────────────────────────────────────────────────┤
│  Dependencies                                        │
│                                                      │
│  @koi/core           (L0)  Result, KoiError          │
│  @koi/gateway-types  (L0u) GatewayFrame, Session,    │
│                             RoutingContext             │
└──────────────────────────────────────────────────────┘
```

---

## Quick Start

```typescript
import { createWebhookServer } from "@koi/gateway-webhook";

const webhook = createWebhookServer(
  { port: 8082, pathPrefix: "/webhook" },
  gateway.dispatch,  // WebhookDispatcher — receives (session, frame)
  optionalAuth,      // WebhookAuthenticator
);

await webhook.start();

// POST /webhook/slack/acme → dispatches frame with routing:
//   { channel: "slack", account: "acme", peer: req.headers["X-Webhook-Peer"] }
```

---

## Key Types

| Type | Purpose |
|------|---------|
| `WebhookConfig` | Port, path prefix, auth, idempotency options |
| `WebhookServer` | HTTP server with start/stop/port |
| `WebhookDispatcher` | `(session, frame, signal?) => void` — injected from gateway |
| `WebhookAuthenticator` | Optional request authentication |
| `IdempotencyStore` | Pluggable dedup backend (default: in-memory) |

---

## Security Properties

**Signature verification** (`signing.ts`) — HMAC-SHA256 over raw bytes (not re-encoded strings) for all four providers. Two-part streaming update via `node:crypto` `createHmac` eliminates the body-copy allocation of a concat buffer.

| Provider | Header | Signing string |
|----------|--------|----------------|
| GitHub | `X-Hub-Signature-256` | raw body |
| Slack | `X-Slack-Signature` | `v0:<ts>:<body>` |
| Stripe | `Stripe-Signature` | `<ts>.<body>` |
| Generic | `X-Webhook-Signature` | `<id>.<ts>.<body>` |

All provider verifiers accept `rawBodyBytes?: Uint8Array` for byte-exact HMAC when the body has already been buffered as bytes.

**Account binding** — `allowUnauthenticated` bypasses the no-auth guard only for non-provider routes. Provider routes with an account URL segment always require an authenticated account binding; `allowUnauthenticated` cannot override this.

**Dispatcher cancellation** — `WebhookDispatcher` receives an `AbortSignal` that fires when `maxDispatchMs` expires. Dispatchers should honour it for cooperative timeout handling.

**Idempotency** — four-phase protocol: `tryBegin` (reserve) → `renew` (heartbeat) → `commit`/`abort` (settle). Dedup keys are scoped by `provider + account` so the same event ID from two tenants dispatches both.
