# @koi/channel-discord — Native Discord.js Channel Adapter

Full-featured Discord bot channel adapter using discord.js 14 directly. Supports text messages, slash commands, buttons, select menus, embeds, components, reactions, voice channels, and all Discord-specific features that the Chat SDK abstraction cannot reach.

---

## Why It Exists

`@koi/channel-chat-sdk` provides basic Discord support through the Vercel Chat SDK — text and images via markdown, typing indicators, and webhook handling. But Discord's API surface is far richer: embeds, interactive components (buttons, select menus), slash commands, voice channels, reactions, stickers, and fine-grained permission intents.

`@koi/channel-discord` wraps discord.js 14 directly as a Koi L2 channel adapter. One `createDiscordChannel()` call returns a `DiscordChannelAdapter` with native access to Discord's full Gateway API — plus extended methods for voice and slash command registration.

### channel-chat-sdk vs channel-discord

```
╔═══════════════════════╦═══════════════════════╦═══════════════════════════╗
║ Feature               ║ channel-chat-sdk      ║ channel-discord           ║
╠═══════════════════════╬═══════════════════════╬═══════════════════════════╣
║ Text messages         ║ ✓ (markdown)          ║ ✓ (native 2000-char)     ║
║ Images                ║ ✓ (![](url))          ║ ✓ (embed images)         ║
║ Files/attachments     ║ ✓ ([name](url))       ║ ✓ (native attachments)   ║
║ Embeds                ║ ✗                     ║ ✓ (discord:embed)        ║
║ Buttons               ║ ✗                     ║ ✓ (native components)    ║
║ Select menus          ║ ✗                     ║ ✓ (string select)        ║
║ Slash commands        ║ ✗                     ║ ✓ (auto-acknowledge)     ║
║ Voice channels        ║ ✗                     ║ ✓ (join/leave/play)      ║
║ Reactions             ║ ✗                     ║ ✓ (add/remove tracking)  ║
║ Stickers              ║ ✗                     ║ ✓ (discord:sticker)      ║
║ Message references    ║ ✗                     ║ ✓ (replyToMessageId)     ║
║ Intent auto-compute   ║ ✗                     ║ ✓ (from feature flags)   ║
║ Gateway connection    ║ webhook (HTTP)        ║ WebSocket (real-time)    ║
╚═══════════════════════╩═══════════════════════╩═══════════════════════════╝

Use channel-chat-sdk when: markdown is sufficient, or multi-platform (6 platforms, 1 factory)
Use channel-discord when: you need embeds, components, slash commands, voice, or reactions
```

---

## What This Enables

### Full Discord Bot — Native API Surface

```
                         ┌─────────────────────────────────────────────┐
                         │           Your Koi Agent (YAML)             │
                         │  name: "discord-bot"                        │
                         │  channels: [discord]                        │
                         │  tools: [search, ticket-create]             │
                         └──────────────────┬──────────────────────────┘
                                            │
                     ┌──────────────────────▼──────────────────────┐
                     │            createKoi() — L1 Engine           │
                     │  ┌─────────────────────────────────────────┐ │
                     │  │ Middleware Chain                         │ │
                     │  │  audit → rate-limit → your-custom → ... │ │
                     │  └─────────────────────────────────────────┘ │
                     │  ┌─────────────────────────────────────────┐ │
                     │  │ Engine Adapter (Pi / LangGraph / etc.)  │ │
                     │  │  → real LLM calls (Anthropic, OpenAI)   │ │
                     │  └─────────────────────────────────────────┘ │
                     └──────────────────────┬──────────────────────┘
                                            │
               ┌────────────────────────────▼────────────────────────────┐
               │       createDiscordChannel() — THIS PACKAGE             │
               │                                                         │
               │  ONE factory → Discord Gateway (WebSocket, real-time)   │
               │                                                         │
               │  ┌────────┐  ┌────────┐  ┌──────┐  ┌───────┐  ┌─────┐ │
               │  │  Text   │  │ Slash  │  │Button│  │ Voice │  │React│ │
               │  │ Message │  │Command │  │Click │  │ State │  │-ions│ │
               │  └────┬───┘  └────┬───┘  └──┬───┘  └───┬───┘  └──┬──┘ │
               │       │          │          │          │          │    │
               │  ┌────▼──────────▼──────────▼──────────▼──────────▼──┐ │
               │  │  discord.js 14 Client (Gateway + REST)            │ │
               │  │  Feature-driven intents • Aggressive cache limits │ │
               │  └────────────────────────┬──────────────────────────┘ │
               └───────────────────────────┼────────────────────────────┘
                                           │
                                           ▼
                              ┌─────────────────────────┐
                              │    Discord Gateway API    │
                              │    (WebSocket, wss://)    │
                              └────────────┬──────────────┘
                                           │
                    ┌──────────────────────▼──────────────────────┐
                    │                Discord Server                │
                    │                                              │
                    │  #general    #support    🔊 voice-lounge     │
                    │  "hey bot!"  /ask q=...  👤 user joined      │
                    │  👍 reaction  [Button]    🎵 playing audio    │
                    └──────────────────────────────────────────────┘
```

### Event Types → InboundMessage Mapping

```
Discord Event               normalizer           InboundMessage
══════════════              ══════════           ══════════════

messageCreate        ──→  normalize-message  ──→  TextBlock, ImageBlock,
  "hello bot!"                                    FileBlock, CustomBlock
  📎 image.png                                    (discord:sticker)
  🎨 sticker                                      metadata: { replyToMessageId }

interactionCreate    ──→  normalize-interaction──→ TextBlock ("/cmd")
  /ask question="..."                              ButtonBlock (click)
  [Button click]                                   CustomBlock (select menu)
  [Select menu]                                    metadata: { isSlashCommand,
                                                   commandName, options }

voiceStateUpdate     ──→  normalize-voice    ──→  CustomBlock
  👤 join/leave/move                               (discord:voice_state)
  🔇 mute/deafen                                  data: { action, channelId,
                                                   selfMute, serverDeaf }

messageReactionAdd   ──→  normalize-reaction ──→  CustomBlock
messageReactionRemove                              (discord:reaction)
  👍 add/remove                                    data: { action, messageId,
  <:custom:123>                                    emoji: { id, name, animated } }
```

---

## Inbound + Outbound Flow

### Inbound: Discord Event → Agent

```
User types in #general             Discord Gateway
"hey bot, search for X"  ────────►  WebSocket event
📎 attaches screenshot               messageCreate
                                           │
                                    discord.js Client
                                    parses event, emits
                                    Events.MessageCreate
                                           │
                                    onPlatformEvent()
                                    wraps as DiscordEvent
                                    { kind: "message", message }
                                           │
                                    normalizeMessage()
                                    ● text → TextBlock
                                    ● image attachment → ImageBlock
                                    ● sticker → CustomBlock
                                    ● filters bot echo
                                    ● resolves threadId
                                    ● captures replyToMessageId
                                           │
                                    InboundMessage {
                                      content: [
                                        TextBlock("hey bot, search for X"),
                                        ImageBlock("screenshot.png"),
                                      ],
                                      senderId: "user-123",
                                      threadId: "guild-001:channel-456",
                                      timestamp: 1717000000000,
                                    }
                                           │
                                    channel.onMessage() handlers
                                           │
                                    Koi middleware chain
                                           │
                                    LLM decides: call tool "search"
                                    with query "X"
                                           │
                                    Tool returns results
                                           │
                                    LLM composes reply
```

### Outbound: Agent → Discord

```
                                    OutboundMessage {
                                      content: [
                                        TextBlock("Found 3 results..."),
                                        CustomBlock("discord:embed", {
                                          title: "Search Results",
                                          fields: [...]
                                        }),
                                        ButtonBlock("Show More", "show_more"),
                                      ],
                                      threadId: "guild-001:channel-456"
                                    }
                                           │
                                    discordSend()
                                    ● TextBlock → content string
                                    ● discord:embed → embeds[]
                                    ● ButtonBlock → components[]
                                    ● Splits text at 2000 chars
                                    ● Batches into minimal API calls
                                           │
                                    channel.send({
                                      content: "Found 3 results...",
                                      embeds: [{ title: "Search Results", ... }],
                                      components: [{ type: 1, components: [
                                        { type: 2, label: "Show More", ... }
                                      ]}]
                                    })
                                           │
                                    discord.js REST API call
                                           │
User sees rich message              Discord API POST
with embed + button  ◄──────────────────────┘
```

### Typing Indicator (sendStatus)

```
User sends message ──────► Agent starts processing
                                    │
                             sendStatus({
                               kind: "processing",
                               messageRef: "guild-001:channel-456"
                             })
                                    │
                             channel.sendTyping()
                                    │
User sees                    Discord API call
"bot is typing..."  ◄──────────────┘
                                    │
                             ... LLM thinks (2-3 sec) ...
                                    │
                             channel.send(response)
                                    │
User sees reply  ◄──────────────────┘
```

---

## Architecture

`@koi/channel-discord` is an **L2 feature package** built on `@koi/channel-base` (L0u).

```
┌─────────────────────────────────────────────────────────┐
│  @koi/channel-discord  (L2)                              │
│                                                          │
│  config.ts                  ← config types + features    │
│  intents.ts                 ← computeIntents(features)   │
│  discord-channel.ts         ← createDiscordChannel()     │
│  normalize.ts               ← composer (dispatches)      │
│  normalize-message.ts       ← messageCreate → Inbound    │
│  normalize-interaction.ts   ← interactionCreate → Inbound│
│  normalize-voice.ts         ← voiceStateUpdate → Inbound │
│  normalize-reaction.ts      ← reaction events → Inbound  │
│  platform-send.ts           ← Outbound → Discord API     │
│  voice.ts                   ← voice connection lifecycle  │
│  slash-commands.ts          ← registerCommands() + types  │
│  descriptor.ts              ← BrickDescriptor             │
│  index.ts                   ← public API surface          │
│  test-helpers.ts            ← mock factories              │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  External deps                                           │
│  ● discord.js 14.18.0                                    │
│  ● @discordjs/voice 0.18.0                              │
│  ● libsodium-wrappers 0.7.15 (WASM, portable)           │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  Internal deps                                           │
│  ● @koi/core (L0) — ChannelAdapter, ContentBlock, etc   │
│  ● @koi/channel-base (L0u) — createChannelAdapter        │
│  ● @koi/resolve (L0u) — BrickDescriptor                  │
└──────────────────────────────────────────────────────────┘
```

### Layer Position

```
L0  @koi/core ──────────────────────────────────────────┐
    ChannelAdapter, ContentBlock, InboundMessage          │
                                                          │
L0u @koi/channel-base ──────────────────┐               │
    createChannelAdapter<DiscordEvent>   │               │
                                          │               │
L0u @koi/resolve ────────────┐           │               │
    BrickDescriptor           │           │               │
                               ▼           ▼               ▼
L2  @koi/channel-discord ◄───┴───────────┴───────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✓ discord.js types stay internal (never leak to public API)
    ✓ All interface properties readonly
    ✓ No vendor types in public API surface
```

**Dev-only:** `@koi/engine`, `@koi/engine-pi`, `@koi/test-utils` used in E2E tests but are not runtime imports.

### Internal Structure

```
createDiscordChannel(config)
│
├── computeIntents(features)
│   Maps feature flags → GatewayIntentBits[]
│   Only requests privileged intents when needed
│
├── new Client({ intents, makeCache: ... })
│   Aggressive cache limits: 50 msgs, 200 members, 0 presences
│   (or config._client for testing)
│
├── createVoiceManager(voiceDeps)
│   Join/leave/reconnect with @discordjs/voice
│   Auto-reconnect: 5s timeout, 3 retries
│
└── createChannelAdapter<DiscordEvent>({
      name: "discord",
      capabilities: { text, images, files, buttons, audio, video, threads },
      platformConnect:    → client.login(token),
      platformDisconnect: → controller.abort(), voiceManager.destroyAll(), client.destroy(),
      platformSend:       → discordSend(getChannel, message),
      platformSendStatus: → channel.sendTyping(),
      onPlatformEvent:    → client.on(Events.*) → handler(DiscordEvent),
      normalize:          → createNormalizer(botUserId),
    })
    ├── .registerCommands(commands) → REST.put(applicationCommands)
    ├── .joinVoice(guildId, channelId) → voiceManager.joinVoice()
    └── .leaveVoice(guildId) → voiceManager.leaveVoice()
```

---

## Feature-Driven Intent Computation

Each feature flag maps to the minimal set of Gateway intents:

```
╔════════════════════╦════════════════════════════════════════╦══════════╗
║ Feature Flag       ║ Gateway Intents Requested              ║ Default  ║
╠════════════════════╬════════════════════════════════════════╬══════════╣
║ text: true         ║ Guilds, GuildMessages, MessageContent* ║ true     ║
║ voice: true        ║ GuildVoiceStates                       ║ false    ║
║ reactions: true    ║ GuildMessageReactions                  ║ false    ║
║ threads: true      ║ (included via Guilds)                  ║ true     ║
║ slashCommands: true║ (no additional intents needed)         ║ true     ║
╚════════════════════╩════════════════════════════════════════╩══════════╝

* MessageContent is a PRIVILEGED intent — requires manual toggle
  in the Discord Developer Portal under Bot → Privileged Intents.

Guilds intent is ALWAYS included (required for guild context).

Example: features: { text: true, reactions: true, voice: false }
  → [Guilds, GuildMessages, MessageContent, GuildMessageReactions]
```

---

## Content Mapping

### Outbound: Koi ContentBlock → Discord Payload

```
discordSend(message) → channel.send(payload)

╔═══════════════════════╦══════════════════════════════════════════════╗
║ Koi ContentBlock      ║ Discord payload                              ║
╠═══════════════════════╬══════════════════════════════════════════════╣
║ TextBlock("hello")    ║ { content: "hello" }                         ║
║ ImageBlock(url, alt)  ║ { embeds: [{ image: { url }, description }] }║
║ FileBlock(url, _, n)  ║ { files: [{ attachment: url, name: n }] }    ║
║ ButtonBlock(label, a) ║ { components: [ActionRow → Button] }         ║
║ CustomBlock            ║                                              ║
║  "discord:embed"      ║ { embeds: [data] }                           ║
║  "discord:action_row" ║ { components: [data] }                       ║
║  (other)              ║ silently skipped                              ║
╚═══════════════════════╩══════════════════════════════════════════════╝

Batching: all blocks in a single OutboundMessage are combined into
one Discord API call. Overflow splits into additional messages:
  ● Text > 2000 chars → split at newlines, multiple messages
  ● > 10 embeds → flush current, start new message
  ● > 5 action rows → flush current, start new message
```

### Inbound: Discord Event → Koi InboundMessage

```
normalize(DiscordEvent) → InboundMessage | null

╔══════════════════════════════╦════════════════════════════════════════╗
║ Discord input                ║ Koi output                             ║
╠══════════════════════════════╬════════════════════════════════════════╣
║ message.content = "hello"    ║ [TextBlock("hello")]                   ║
║ image attachment             ║ [ImageBlock(url, name)]                ║
║ file attachment              ║ [FileBlock(url, mimeType, name)]       ║
║ sticker                      ║ [CustomBlock("discord:sticker")]       ║
║ reply to message             ║ metadata: { replyToMessageId }         ║
║ /command option=value        ║ [TextBlock("/command")]                 ║
║                              ║ metadata: { isSlashCommand, options }  ║
║ button click                 ║ [ButtonBlock(customId)]                ║
║ select menu                  ║ [CustomBlock("discord:select_menu")]   ║
║ voice join/leave/move        ║ [CustomBlock("discord:voice_state")]   ║
║ reaction add/remove          ║ [CustomBlock("discord:reaction")]      ║
║ bot's own message            ║ null (filtered)                        ║
║ empty message (system event) ║ null (filtered)                        ║
║ bot's own reaction           ║ null (filtered)                        ║
║ bot's own voice state        ║ null (filtered)                        ║
╚══════════════════════════════╩════════════════════════════════════════╝

Thread ID convention:
  Guild channel:  "guildId:channelId"
  DM channel:     "dm:userId"
  Thread channel:  "guildId:threadId"
  Voice channel:  "guildId:voiceChannelId"
```

---

## Configuration

### DiscordChannelConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `token` | `string` | **required** | Discord bot token |
| `applicationId` | `string?` | `undefined` | Required for `registerCommands()` |
| `features` | `DiscordFeatures?` | see below | Feature flags controlling intents |
| `onHandlerError` | `function?` | `console.error` | Error callback for handler exceptions |
| `queueWhenDisconnected` | `boolean?` | `false` | Buffer sends while disconnected |

### DiscordFeatures

| Flag | Type | Default | Intents Added |
|------|------|---------|---------------|
| `text` | `boolean?` | `true` | GuildMessages, MessageContent (privileged) |
| `voice` | `boolean?` | `false` | GuildVoiceStates |
| `reactions` | `boolean?` | `false` | GuildMessageReactions |
| `threads` | `boolean?` | `true` | (via Guilds, always included) |
| `slashCommands` | `boolean?` | `true` | (none needed) |

### Test Injection Points

| Field | Purpose |
|-------|---------|
| `_client` | Pre-configured discord.js Client (skip `new Client()`) |
| `_joinVoiceChannel` | Mock `@discordjs/voice.joinVoiceChannel` |
| `_createAudioPlayer` | Mock `@discordjs/voice.createAudioPlayer` |

---

## Usage

### Standalone (without L1 engine)

```typescript
import { createDiscordChannel } from "@koi/channel-discord";

const channel = createDiscordChannel({
  token: process.env.DISCORD_BOT_TOKEN!,
  features: { text: true, reactions: true },
});

await channel.connect();

channel.onMessage(async (msg) => {
  console.log(`${msg.senderId}: ${msg.content}`);
  await channel.send({
    content: [{ kind: "text", text: "Got it!" }],
    threadId: msg.threadId,
  });
});
```

### With Full L1 Runtime (createKoi)

```typescript
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createDiscordChannel } from "@koi/channel-discord";

// 1. Create channel adapter
const channel = createDiscordChannel({
  token: process.env.DISCORD_BOT_TOKEN!,
  applicationId: process.env.DISCORD_APPLICATION_ID,
  features: { text: true, slashCommands: true, reactions: true },
});

// 2. Create engine adapter (real LLM)
const adapter = createPiAdapter({
  model: "anthropic:claude-haiku-4-5-20251001",
  systemPrompt: "You are a helpful Discord bot.",
  getApiKey: async () => process.env.ANTHROPIC_API_KEY!,
});

// 3. Assemble L1 runtime
const runtime = await createKoi({
  manifest: {
    name: "DiscordBot",
    version: "1.0.0",
    model: { name: "anthropic:claude-haiku-4-5-20251001" },
  },
  adapter,
  channelId: "@koi/channel-discord",
  ...(channel.sendStatus !== undefined ? { sendStatus: channel.sendStatus } : {}),
});

// 4. Connect and wire message handler
await channel.connect();
channel.onMessage(async (msg) => {
  for await (const event of runtime.run({ kind: "messages", messages: [msg] })) {
    // process engine events
  }
});
```

### Slash Command Registration

```typescript
await channel.registerCommands([
  {
    name: "ask",
    description: "Ask the bot a question",
    options: [
      {
        name: "question",
        description: "Your question",
        type: 3, // STRING
        required: true,
      },
    ],
  },
  {
    name: "ping",
    description: "Check if the bot is alive",
  },
]);
```

### Voice Channel

```typescript
const channel = createDiscordChannel({
  token: process.env.DISCORD_BOT_TOKEN!,
  features: { text: true, voice: true },
});

await channel.connect();

// Join a voice channel
const voice = channel.joinVoice("guild-001", "voice-channel-789");

// Play audio
voice.playAudio(audioResource);

// Leave
channel.leaveVoice("guild-001");
```

### Rich Outbound Messages (Embeds + Components)

```typescript
await channel.send({
  content: [
    { kind: "text", text: "Here are the search results:" },
    {
      kind: "custom",
      type: "discord:embed",
      data: {
        title: "Search Results",
        color: 0x5865f2,
        fields: [
          { name: "Result 1", value: "Description...", inline: true },
          { name: "Result 2", value: "Description...", inline: true },
        ],
      },
    },
    { kind: "button", label: "Show More", action: "show_more" },
  ],
  threadId: msg.threadId,
});
```

### Auto-Resolution via BrickDescriptor

```yaml
# agent-manifest.yaml
name: discord-bot
channels:
  - id: "@koi/channel-discord"
    options:
      features:
        text: true
        reactions: true
        slashCommands: true
```

Environment variables: `DISCORD_BOT_TOKEN` (required), `DISCORD_APPLICATION_ID` (optional, for slash commands).

---

## Voice Lifecycle

```
channel.connect()
│
├── client.login(token)
│   Gateway WebSocket connected
│
├── channel.joinVoice(guildId, channelId)
│   │
│   ├── joinVoiceChannel({ guildId, channelId, adapterCreator })
│   │   @discordjs/voice creates UDP connection
│   │
│   ├── createAudioPlayer()
│   │   connection.subscribe(player)
│   │
│   └── Auto-reconnect handler registered:
│       on("stateChange"):
│         Disconnected → wait 5s → retry (max 3 attempts)
│         Ready → reset reconnect counter
│         3 failures → destroy connection
│
├── voice.playAudio(resource)
│   player.play(resource) → audio streams to channel
│
├── channel.leaveVoice(guildId)
│   connection.destroy(), remove from map
│
└── channel.disconnect()
    voiceManager.destroyAll() → all connections destroyed
    controller.abort()
    client.destroy()
```

---

## API Reference

### Factory Functions

| Function | Returns | Purpose |
|----------|---------|---------|
| `createDiscordChannel(config)` | `DiscordChannelAdapter` | Create adapter with discord.js client |
| `registerCommands(token, appId, commands)` | `Promise<void>` | Register global slash commands via REST |

### DiscordChannelAdapter (extends ChannelAdapter)

| Method / Property | Returns | Purpose |
|-------------------|---------|---------|
| `connect()` | `Promise<void>` | Login to Discord Gateway via WebSocket |
| `disconnect()` | `Promise<void>` | Abort listeners, destroy voice, destroy client |
| `send(message)` | `Promise<void>` | Batch content blocks → Discord API |
| `onMessage(handler)` | `() => void` | Register handler (returns unsubscribe) |
| `sendStatus(status)` | `Promise<void>` | Typing indicator via `channel.sendTyping()` |
| `registerCommands(commands)` | `Promise<void>` | Register global slash commands (requires `applicationId`) |
| `joinVoice(guildId, channelId)` | `DiscordVoiceConnection` | Join voice channel, returns playback handle |
| `leaveVoice(guildId)` | `void` | Leave voice channel in guild |
| `name` | `string` | `"discord"` |
| `capabilities` | `ChannelCapabilities` | `{ text, images, files, buttons, audio, video, threads }` |

### DiscordVoiceConnection

| Field / Method | Type | Purpose |
|----------------|------|---------|
| `channelId` | `string` | Voice channel ID |
| `guildId` | `string` | Guild ID |
| `destroy()` | `void` | Disconnect and cleanup |
| `playAudio(resource)` | `void` | Play an `AudioResource` in the channel |

### Types

| Type | Description |
|------|-------------|
| `DiscordChannelConfig` | Config for `createDiscordChannel()` |
| `DiscordFeatures` | Feature flags: `text`, `voice`, `reactions`, `threads`, `slashCommands` |
| `DiscordChannelAdapter` | Extended `ChannelAdapter` with `registerCommands` + `joinVoice` + `leaveVoice` |
| `DiscordSlashCommand` | `{ name, description, options? }` |
| `DiscordCommandOption` | `{ name, description, type, required?, choices? }` |

### BrickDescriptor

| Field | Value |
|-------|-------|
| `kind` | `"channel"` |
| `name` | `"@koi/channel-discord"` |
| `aliases` | `["discord"]` |
| `factory` | Reads `DISCORD_BOT_TOKEN` + `DISCORD_APPLICATION_ID` from env |

---

## Testing

### Test Structure

```
packages/channel-discord/src/
  intents.test.ts                     Intent computation from feature flags
  normalize-message.test.ts           messageCreate normalization (text, images, stickers, DMs, replies)
  normalize-interaction.test.ts       interactionCreate normalization (slash cmds, buttons, selects)
  normalize-voice.test.ts             voiceStateUpdate normalization (join, leave, move, mute, deafen)
  normalize-reaction.test.ts          reaction normalization (add, remove, custom emoji, bot filtering)
  normalize.test.ts                   Composer dispatching to correct normalizer
  platform-send.test.ts               Outbound batching, text splitting, embeds, components, files
  discord-channel.test.ts             Factory, lifecycle, contract suite (testChannelAdapter), voice
  voice.test.ts                       Voice manager (join, leave, reconnect, destroy)
  slash-commands.test.ts              Command registration via REST API
  __tests__/
    api-surface.test.ts               .d.ts snapshot stability
    e2e-full-stack.test.ts            Real LLM calls through full L1 runtime
```

### Coverage

128 tests, 0 failures across 12 test files.

### E2E Tests (Real LLM)

Gated behind `E2E_TESTS=1` environment variable + `ANTHROPIC_API_KEY` presence:

```bash
# Run unit tests only
bun test --cwd packages/channel-discord

# Run everything including E2E with real Anthropic API calls
export $(grep ANTHROPIC_API_KEY .env) && E2E_TESTS=1 bun test --cwd packages/channel-discord src/__tests__/e2e-full-stack.test.ts
```

E2E tests validate the full pipeline through `createKoi` + `createPiAdapter`:
- Text message → real Anthropic LLM → outbound text
- Tool calls through full middleware chain
- Slash commands, button clicks, select menus
- Reaction normalization through full stack
- Message references (reply metadata)
- Bot echo prevention
- `sendStatus` typing indicators
- Lifecycle hooks (`session_start` → `after_turn` → `session_end`)
- DM normalization (threadId = `dm:userId`)
- Connect/disconnect lifecycle
- Attachment handling (images, files)

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| discord.js 14 (full) | Direct Gateway access unlocks embeds, components, voice, reactions — features the Chat SDK abstraction cannot reach |
| Gateway-only (WebSocket) | Real-time event delivery. Webhooks planned for v2 (HTTP-triggered bots) |
| Feature-driven intent computation | Only requests privileged intents (e.g., `MessageContent`) when the feature is explicitly enabled. Minimizes required permissions |
| Config-injected `_client` | Tests run without a real Discord token or Gateway connection. No global `jest.mock()` — just pass a mock client |
| Batched outbound send | Combines text + embeds + components + files into one API call. Splits only on overflow (>2000 chars, >10 embeds, >5 action rows) |
| Text splitting at newlines | Prefers splitting at `\n` boundaries over mid-word cuts. Falls back to 2000-char hard cut when no newline found |
| Auto-acknowledge interactions | Calls `deferReply()` / `deferUpdate()` immediately to prevent the 3-second Discord timeout. Agent reply replaces the deferred response |
| `discord:embed` / `discord:action_row` escape hatches | CustomBlock with typed `type` field passes raw Discord payload. Agent sends rich embeds without vendor types in L0 |
| Aggressive cache limits | 50 messages, 200 members, 0 presences. Reduces memory footprint for bot-only use cases where full caching is unnecessary |
| Voice auto-reconnect | 5s timeout, 3 retries. Handles transient disconnects without manual intervention. Gives up after 3 failures to prevent infinite loops |
| `libsodium-wrappers` (WASM) over `sodium-native` (native) | Maximum portability — no native compilation required. Works in all environments including Docker and CI |
| Per-event-type normalizers | Each normalizer is a focused pure function (~30-60 LOC). Thin composer dispatches by `DiscordEvent.kind`. Easy to add new event types |
| Reaction support via feature flag | `reactions: false` by default — avoids requesting `GuildMessageReactions` intent unless explicitly needed |

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────┐
    ChannelAdapter, ContentBlock, InboundMessage,         │
    OutboundMessage, ChannelStatus, KoiError              │
                                                          │
L0u @koi/channel-base ──────────────────┐               │
    createChannelAdapter<DiscordEvent>   │               │
                                          │               │
L0u @koi/resolve ────────────┐           │               │
    BrickDescriptor           │           │               │
                               ▼           ▼               ▼
L2  @koi/channel-discord ◄───┴───────────┴───────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✓ discord.js types stay internal (never leak to public API)
    ✓ All interface properties readonly
    ✓ No vendor types in public API surface
```
