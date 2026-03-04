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
| `WebhookConfig` | Port + path prefix |
| `WebhookServer` | HTTP server with start/stop/port |
| `WebhookDispatcher` | `(session, frame) => void` — injected from gateway |
| `WebhookAuthenticator` | Optional request authentication |
