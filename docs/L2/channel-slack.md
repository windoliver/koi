# @koi/channel-slack

**Layer:** L2 · **Contract:** `ChannelAdapter` (L0)

ChannelAdapter for Slack bots. Two deployments: **Socket Mode** (WebSocket
via `@slack/socket-mode`) for self-hosted bots, **HTTP Events** (signed
webhook) for serverless. Both ride on `@slack/web-api` for outbound calls.

## What it owns

- `ChannelAdapter` implementation backed by Slack Bolt-style primitives
- Socket Mode start/stop + event listener registration
- HTTP Events: signature verification (`x-slack-signature` HMAC) +
  `url_verification` challenge
- Slash command interception, `app_mention`, plain `message`,
  `block_action` events. (Reaction events are NOT supported — subscribing
  to `reaction_added/removed` in Slack will result in unhandled deliveries.)
- Thread routing — `threadId` convention `channelId[:thread_ts]`
- `replyToMode`: `"all" | "off"` — controls whether the bot replies in-thread
  or in the channel root. (`"first"` is intentionally unsupported — it
  requires server-side first-message lookup; passing it throws at construction.)
- File-block fallback when an `OutboundMessage` carries oversize media

## What it does NOT own

- OAuth installation flow (caller supplies `botToken` + optional `signingSecret`)
- Message persistence / search index
- Rate-limit backoff for Slack 429s — use `@koi/middleware-call-limits`
- `chat.update` / message editing

## Dependencies

| Package | Layer | Purpose |
|---------|-------|---------|
| `@koi/core` | L0 | `ChannelAdapter`, `ContentBlock`, message types |
| `@koi/channel-base` | L0u | `createChannelAdapter()` factory |
| `@slack/web-api@7.9.1` | external | `chat.postMessage` + `auth.test` |
| `@slack/socket-mode@2.0.3` | external | WebSocket runtime (Socket Mode only) |

Both Slack SDKs are loaded via dynamic `import()` so HTTP-only deployments
never pay the Socket Mode bundle cost.

## API

### `createSlackChannel(config): SlackChannelAdapter`

Returns the standard `ChannelAdapter` plus one of:

- `handleEvent(payload)` — Socket Mode only. Forward an SDK-verified payload.
- `handleHttpRequest(request)` — HTTP only. Performs signature verification
  internally; returns the `Response` to send back to Slack.

### `SlackChannelConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `botToken` | `string` (`xoxb-…`) | required | Bot user token |
| `deployment` | `SlackDeployment` | required | Socket Mode or HTTP |
| `features` | `Partial<SlackFeatures>` | all on | Toggle slash, threads, files |
| `replyToMode` | `"all" \| "off"` | `"all"` | Thread routing. `"first"` removed — throws at construction. |
| `defaultChannel` | `string` | undefined | Slack channel ID used for outbound messages with no `threadId`. Required for proactive sends; without it, `send()` throws rather than calling Slack with `channel: ""` |
| `mediaMaxMb` | `number` | `8` | Max attachment size before fallback |

`SlackDeployment` discriminated union:

```typescript
| { mode: "socket"; appToken: `xapp-${string}` }
| { mode: "http";   signingSecret: string }
```

### Capabilities

```typescript
{ text: true, images: false, files: false, buttons: false,
  audio: false, video: false, threads: true, supportsA2ui: false }
```

We currently render via `chat.postMessage` text only. Block Kit, file uploads,
and interactive button rendering are not implemented yet, so we mark those
capabilities `false` — `@koi/channel-base`'s `renderBlocks()` will downgrade
upstream `image/file/button` blocks to text BEFORE they reach the adapter, so
callers never believe attachments survived the round-trip. To upgrade: implement
Slack native rendering, then flip the capability flags back on.

## Security

- HTTP mode: HMAC-SHA256 signature check on every request; rejects requests
  older than 5 minutes (replay protection)
- HTTP mode does NOT expose `handleEvent` — only the verified
  `handleHttpRequest` path
- `botToken` and `signingSecret` are never logged or echoed in error messages
- 401 returned on signature failure with no body details

## threadId convention

```
"C123456"               → post to channel root
"C123456:1700000000.0"  → post in thread (thread_ts = "1700000000.0")
```

`replyToMode` strips `thread_ts` before send according to mode.

## Reference

Ported and trimmed from `archive/v1/packages/net/channel-slack`. Differences
from v1: no `@koi/resolve` dep (now L0u), simplified to a single
`createSlackChannel` factory, dropped the test-only `_webClient`/`_socketClient`
config injection in favour of explicit constructor injection during tests.
