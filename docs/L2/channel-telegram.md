# @koi/channel-telegram

**Layer:** L2 · **Contract:** `ChannelAdapter` (L0)

ChannelAdapter for Telegram bots using `grammy`. Two deployments:
**polling** (long-poll loop) and **webhook** (caller forwards HTTPS updates
into `handleUpdate`). Outbound calls go through the Bot API.

## What it owns

- `createTelegramChannel(config)` factory
- Normalization of grammy `Context` → `InboundMessage` (text, photo as
  image, document/audio/video as file, callback_query as button block).
  Inbound media `url` fields are opaque `tg://file/<fileId>` references —
  the token-bearing CDN URL is **never** surfaced. Consumers call
  `adapter.resolveMediaUrl(ref)` at the fetch site to obtain a short-lived
  download URL.
- Outbound rendering: text (4096-char split), inline keyboards built from
  `ButtonBlock`s, photo via `sendPhoto`, file via `sendDocument`
- `handleUpdate(update)` for webhook deployments
- 429 `retry_after` handling on outbound calls (single retry)

## What it does NOT own

- Webhook server / HTTPS termination — caller's job
- Media file caching (URLs from the Telegram CDN expire after ~1h)
- Inline query results
- Payments, polls, locations

## Dependencies

| Package | Layer | Purpose |
| ------- | ----- | ------- |
| `@koi/core` | L0 | `ChannelAdapter`, `ContentBlock` types |
| `@koi/channel-base` | L0u | `createChannelAdapter()` factory |
| `grammy@1.40.0` | external | Bot API client + update typings |

`grammy` is loaded via dynamic `import()`.

## API

### `createTelegramChannel(config): TelegramChannelAdapter`

Returns the standard `ChannelAdapter` plus, in webhook mode:

- `handleUpdate(update)` — feed an HTTPS-delivered update into the adapter.

### `TelegramChannelConfig`

| Field | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `token` | `string` | required | Bot token from `@BotFather` |
| `deployment` | `TelegramDeployment` | `{ mode: "polling" }` | `polling` or `webhook` |
| `bot` | `TelegramBotLike?` | undefined | Test-only injected Bot double |

`TelegramDeployment`:

```ts
| { mode: "polling" }
| { mode: "webhook" }
```

### Capabilities

```ts
{ text: true, images: true, files: true, buttons: true,
  audio: false, video: false, threads: true, supportsA2ui: false }
```

## threadId convention

| Source | threadId |
| ------ | -------- |
| Private chat / group | `String(chatId)` |
| Forum topic | `"<chatId>:<messageThreadId>"` |

Outbound `send()` parses `threadId`, splits on `:`, and routes to
`sendMessage` with `chat_id` and (when present) `message_thread_id`.

## Custom block escape hatches

Inbound:

- Callback query (button press) → `{ kind: "button", action, payload? }`.
  Payload is the JSON-decoded suffix after the first `:` in `callback_data`.

## Security

- Token never logged.
- Inbound media URLs surfaced to consumers are opaque `tg://file/<fileId>`
  strings — the bot token is **not** embedded. Token-bearing CDN URLs are
  only constructed inside `resolveMediaUrl()` at the fetch site and must
  not be stored or logged. Avoiding token-bearing URLs in `ContentBlock.url`
  prevents the token from leaking into transcripts, model prompts, and
  third-party log sinks.
- 429 handling: on first 429, sleep `retry_after` seconds and retry once;
  on subsequent failure, throw.

## Reference

Trimmed from `archive/v1/packages/net/channel-telegram`. v2 drops:
sticker custom blocks, voice notes, audio file blocks (unless capability is
flipped on). Adds explicit `handleUpdate` for webhook mode rather than
hidden grammy internals.
