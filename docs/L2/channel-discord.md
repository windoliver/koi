# @koi/channel-discord

**Layer:** L2 · **Contract:** `ChannelAdapter` (L0)

ChannelAdapter for Discord bots using discord.js 14. Listens to
`messageCreate` and `interactionCreate` over the Gateway WebSocket; sends
text, embeds, buttons, and files via the REST API.

## What it owns

- `ChannelAdapter` implementation backed by `discord.js`
- Login + Gateway listener registration / teardown
- Normalization of `Message` and `Interaction` events into `InboundMessage`
  (text, image, file, button, custom blocks)
- Outbound rendering: text (2000-char split), `discord:embed` and
  `discord:action_row` custom-block escape hatches, `ButtonBlock` mapped to a
  single action row, image / file blocks attached by URL
- Slash-command registration (`registerCommands`)
- threadId convention `"<guildId>:<channelId>"`, `"dm:<userId>"`

## What it does NOT own

- Voice channels / audio playback (intentional — separate package)
- Message reactions (out of scope)
- OAuth bot installation flow (caller supplies `token` directly)
- Rate-limit backoff for Discord 429s — discord.js's `rest` client retries
  internally; layer additional backoff via `@koi/middleware-call-limits`

## Dependencies

| Package | Layer | Purpose |
| ------- | ----- | ------- |
| `@koi/core` | L0 | `ChannelAdapter`, `ContentBlock`, message types |
| `@koi/channel-base` | L0u | `createChannelAdapter()` factory |
| `discord.js@14.18.0` | external | Gateway WebSocket + REST client |

`discord.js` is loaded via dynamic `import()` so consumers that never call
`connect()` (e.g., a router that conditionally constructs the channel) do
not pay the bundle cost at import time.

## API

### `createDiscordChannel(config): DiscordChannelAdapter`

Returns the standard `ChannelAdapter` plus:

- `registerCommands(commands)` — register global slash commands. Throws if
  `applicationId` was not supplied at construction.

### `DiscordChannelConfig`

| Field | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `token` | `string` | required | Bot token (`Bot xxx` form not required — discord.js prepends) |
| `applicationId` | `string?` | undefined | Required to call `registerCommands` |
| `intents` | `readonly DiscordIntent[]?` | `["Guilds","GuildMessages","MessageContent","DirectMessages"]` | Gateway intents to subscribe to |
| `client` | `DiscordClientLike?` | undefined | Test-only injected client double |
| `onHandlerError` | `(err, msg) => void?` | undefined | Logged when downstream `onMessage` handler throws |

### Capabilities

```ts
{ text: true, images: true, files: true, buttons: true,
  audio: false, video: false, threads: true, supportsA2ui: false }
```

## threadId convention

| Source | threadId |
| ------ | -------- |
| Guild text channel | `"<guildId>:<channelId>"` |
| Guild thread | `"<guildId>:<threadId>"` |
| DM | `"dm:<userId>"` |

Outbound `send()` parses `threadId`, looks up the channel via
`client.channels.cache`, and calls `.send()` on it. Unknown thread IDs throw.

## Custom block escape hatches

Outbound:

- `{ kind: "custom", type: "discord:embed", data: APIEmbed }` — sent as `embeds[0]`
- `{ kind: "custom", type: "discord:action_row", data: APIActionRowComponent }` — sent verbatim

Inbound:

- Slash command → `{ kind: "custom", type: "discord:slash_command", data: { name, options } }`
- Button press → `{ kind: "button", action: customId, payload? }`

## Security

- `token` and `applicationId` are never logged
- Bot's own messages are filtered out by user-id comparison after login

## Reference

Trimmed and simplified from `archive/v1/packages/net/channel-discord`.
Differences from v1: voice + reactions removed (separate scope), no
`@koi/resolve` dependency, no `descriptor.ts`, single normalizer module.
