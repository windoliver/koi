# @koi/channel-whatsapp

WhatsApp channel adapter for Meta's WhatsApp Business **Cloud API** (the
official, hosted offering — not Baileys / on-prem). Inbound is a webhook
POST that we authenticate with HMAC-SHA256 over the raw body. Outbound is a
single Graph API call to `${graphBaseUrl}/${phoneNumberId}/messages`.

## Purpose

Single-file replacement for the v1 Baileys adapter, scoped to text-only
conversations as a first cut. Templates, interactive (button/list), and
media uploads are deliberately deferred.

## Dependency injection

`createWhatsAppChannel(config, deps)` takes:

- `fetch` — `(input, init) => Promise<Response>`. Production: globalThis
  fetch. Tests: a stub.
- `idempotencyStore` — durable WAMID dedupe (key
  `${phone_number_id}|${wamid}`). Provided by `@koi/channel-base`.
- `ingressQueue` — buffer between webhook ack and handler dispatch.
- `clock?` — optional clock for tests; defaults to `Date.now`.

## Error codes

| Code | When |
|------|------|
| `INVALID_CONFIG` | `validateWhatsAppConfig` rejected a value |
| `INVALID_SIGNATURE` | `X-Hub-Signature-256` HMAC mismatch (POST 401) |
| `INVALID_TOKEN` | Cloud API responded 401 to send (token expired/revoked) |
| `INVALID_PAYLOAD` | Webhook body shape unparseable / `from` or `id` missing / `send()` missing `threadId` |
| `RATE_LIMITED` | Cloud API responded 429 |
| `SEND_FAILED` | Any other non-2xx or network failure |
| `UNSUPPORTED_BLOCK` | Reserved for future template/interactive payloads |

## Operational notes

- **Signature**: HMAC-SHA256 over the raw request body keyed by
  `appSecret`; header `X-Hub-Signature-256: sha256=<hex>`. Compared
  timing-safe.
- **Replay protection**: Meta does **not** include a freshness timestamp
  on the webhook envelope, so we rely on durable WAMID dedupe (the
  `commitTtlMs` window — default 7 days). Late retries within that window
  return 200 OK without re-dispatching.
- **Default `graphBaseUrl`**: `https://graph.facebook.com/v18.0`.
- **Multi-message webhooks**: v1 only handles the first message in the
  webhook entry; configurations expecting batched delivery should pin
  Meta's webhook config to single-message mode or wait for v2.
- **Threading**: an outbound `OutboundMessage.metadata.contextMessageId`
  (string) is forwarded as Meta's `context.message_id`, which produces a
  threaded reply.
