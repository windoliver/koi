# @koi/channel-chat-sdk — Multi-Platform Channel Adapter

Wraps 6 chat platforms (Slack, Discord, Teams, Google Chat, GitHub, Linear) into Koi `ChannelAdapter` instances using a single shared [Vercel Chat SDK](https://github.com/vercel/chat) instance. One normalizer, one content mapper, 6 platforms — instead of building 6 separate channel adapter packages.

---

## Why It Exists

Supporting 6 chat platforms individually would mean 6 packages, 6 normalizers, 6 content mappers, and ~1800 LOC of largely duplicated adapter code. The Vercel Chat SDK already normalizes these platforms into a unified `Message` type and provides a single `postMessage()` interface.

`@koi/channel-chat-sdk` wraps the Chat SDK as a Koi L2 channel adapter. One factory call returns N ready-to-use `ChannelAdapter` instances — each backed by the same shared `Chat` instance for webhook handling, event normalization, and sending.

---

## What This Enables

### One Agent, Six Platforms

```
                         ┌─────────────────────────────────────────────┐
                         │           Your Koi Agent (YAML)             │
                         │  name: "support-bot"                        │
                         │  channels: [chat-sdk:slack, chat-sdk:discord]│
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
               │          createChatSdkChannels() — THIS PACKAGE         │
               │                                                         │
               │  ONE factory → N channel adapters → ONE shared Chat SDK │
               │                                                         │
               │  ┌─────────┐  ┌─────────┐  ┌──────┐  ┌──────┐  ┌────┐ │
               │  │  Slack   │  │ Discord │  │Teams │  │GChat │  │ ...│ │
               │  └────┬────┘  └────┬────┘  └──┬───┘  └──┬───┘  └──┬─┘ │
               │       │            │           │         │          │   │
               │  ┌────▼────────────▼───────────▼─────────▼──────────▼─┐ │
               │  │  Shared Chat SDK instance (webhook verify,         │ │
               │  │  event normalize, signature check, send)           │ │
               │  └────────────────────┬───────────────────────────────┘ │
               └───────────────────────┼────────────────────────────────┘
                                       │
          ┌────────────────────────────▼────────────────────────────┐
          │                    The Internet                          │
          │                                                          │
          │  ┌──────┐  ┌───────┐  ┌─────┐  ┌─────┐  ┌──────┐  ┌──┐│
          │  │Slack │  │Discord│  │Teams│  │GChat│  │GitHub│  │LN││
          │  │ API  │  │  API  │  │ API │  │ API │  │ API  │  │  ││
          │  └──┬───┘  └──┬────┘  └──┬──┘  └──┬──┘  └──┬───┘  └┬─┘│
          └─────┼─────────┼─────────┼────────┼────────┼────────┼───┘
                │         │         │        │        │        │
          ┌─────▼───┐ ┌───▼──┐ ┌───▼──┐ ┌───▼──┐ ┌───▼──┐ ┌──▼───┐
          │ #general│ │      │ │      │ │      │ │ Issue│ │ Issue│
          │ "hey    │ │"help │ │"file │ │"what │ │ #42  │ │ KOI- │
          │  bot!"  │ │ me"  │ │ this"│ │ is X"│ │      │ │ 123  │
          └─────────┘ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘
            Users on 6 platforms talk to the SAME agent
```

### Before vs After

```
WITHOUT channel-chat-sdk:  6 packages, 6 normalizers, 6 mappers
═══════════════════════════════════════════════════════════════

  @koi/channel-slack     @koi/channel-discord    @koi/channel-teams   ...
  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
  │ Bolt SDK wrapper│    │ Discord.js      │    │ Bot Framework   │
  │ normalizer      │    │ normalizer      │    │ normalizer      │
  │ content mapper  │    │ content mapper  │    │ content mapper  │
  │ webhook verify  │    │ interaction hdlr│    │ webhook verify  │
  │ ~300 LOC each   │    │ ~300 LOC each   │    │ ~300 LOC each   │
  └─────────────────┘    └─────────────────┘    └─────────────────┘
        ~1800 LOC total          ~6 normalizers          ~6 mappers


WITH channel-chat-sdk:  1 package, 1 normalizer, 1 mapper
══════════════════════════════════════════════════════════

                    @koi/channel-chat-sdk
                ┌───────────────────────────────┐
                │ createChatSdkChannels()        │
                │ ● ONE normalizer (~95 LOC)     │
                │ ● ONE content mapper (~55 LOC)  │
                │ ● ONE factory (~340 LOC)        │
                │ ● ONE config validator          │
                │ ● Chat SDK handles:             │
                │   - webhook verification        │
                │   - platform normalization      │
                │   - credential auto-detect      │
                └────────┬──────────────────────┘
           ┌─────────────┼───────────────┐
           ▼             ▼               ▼
    chat-sdk:slack  chat-sdk:discord  chat-sdk:teams  ...
    (ChannelAdapter) (ChannelAdapter) (ChannelAdapter)

        ~545 LOC total     1 normalizer     1 mapper
```

---

## Inbound + Outbound Flow

### Inbound: Platform Event → Agent

```
User types in Slack                  Webhook POST
"hey bot, search for X"  ──────────►  /webhooks/slack
                                            │
                                     handleWebhook(request)
                                            │
                                    Chat SDK verifies Slack
                                    signing secret, parses
                                    event payload
                                            │
                                    onNewMention() fires
                                            │
                                    Event router dispatches
                                    to "slack" handlers only
                                            │
                                     normalize()
                                     Thread + Message →
                                     InboundMessage {
                                       content: [TextBlock("hey bot, search for X")],
                                       senderId: "U12345",
                                       threadId: "C01-1717000000",
                                       timestamp: 1717000000000,
                                       metadata: { isMention: true }
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

### Outbound: Agent → Platform

```
                                     OutboundMessage {
                                       content: [
                                         TextBlock("Found 3 results..."),
                                         ImageBlock(url: "chart.png"),
                                       ],
                                       threadId: "C01-1717000000"
                                     }
                                            │
                                     renderBlocks()
                                     (from @koi/channel-base)
                                     Downgrades unsupported blocks
                                            │
                                     mapContentToPostable()
                                     [Text, Image] →
                                     { markdown: "Found 3 results...\n\n![image](chart.png)" }
                                            │
                                     adapter.postMessage(threadId, postable)
                                            │
                                     Chat SDK formats for
                                     Slack API, sends via HTTPS
                                            │
User sees reply                      Slack API POST
"Found 3 results..."  ◄───────────────────────┘
```

### Typing Indicator (sendStatus)

```
User sends message ──────► Agent starts processing
                                    │
                             sendStatus({
                               kind: "processing",
                               messageRef: "C01-1717000000"
                             })
                                    │
                             adapter.startTyping(threadId)
                                    │
User sees                    Platform API call
"bot is typing..."  ◄──────────────┘
                                    │
                             ... LLM thinks (2-3 sec) ...
                                    │
                             channel.send(response)
                                    │
User sees reply  ◄──────────────────┘
```

### Multi-Platform Event Routing

```
                    Shared Chat SDK Instance
                    ┌──────────────────────────────┐
                    │  onNewMention()               │
                    │  onSubscribedMessage()         │
                    └───────────┬───────────────────┘
                                │
                    Event Router (internal Map)
                    ┌───────────▼───────────────────┐
                    │ "slack"   → [handler₁, ...]   │
                    │ "discord" → [handler₂, ...]   │
                    │ "teams"   → [handler₃, ...]   │
                    └───────────────────────────────┘
                                │
          Slack event comes in: thread.adapter.name = "slack"
                                │
               ┌────────────────┼──────────────────┐
               ▼                ▼                  ▼
          handler₁ (slack)   handler₂ (discord)  handler₃ (teams)
             FIRES              skipped            skipped

     Events route only to the correct platform's handlers.
     Other platforms are completely unaffected.
```

---

## Architecture

`@koi/channel-chat-sdk` is an **L2 feature package** built on `@koi/channel-base` (L0u).

```
┌────────────────────────────────────────────────────────┐
│  @koi/channel-chat-sdk  (L2)                           │
│                                                        │
│  config.ts                  ← config types + validator │
│  capabilities.ts            ← per-platform caps        │
│  normalize.ts               ← Chat SDK → InboundMsg    │
│  map-content.ts             ← ContentBlock → markdown   │
│  create-chat-sdk-channels.ts ← main factory            │
│  types.ts                   ← ChatSdkEvent type        │
│  descriptor.ts              ← BrickDescriptor          │
│  index.ts                   ← public API surface       │
│                                                        │
├────────────────────────────────────────────────────────┤
│  External deps (Chat SDK)                              │
│  ● chat 4.14.0                                         │
│  ● @chat-adapter/slack 4.14.0                         │
│  ● @chat-adapter/discord 4.14.0                       │
│  ● @chat-adapter/teams 4.14.0                         │
│  ● @chat-adapter/gchat 4.14.0                         │
│  ● @chat-adapter/github 4.14.0                        │
│  ● @chat-adapter/linear 4.14.0                        │
│  ● @chat-adapter/state-memory 4.14.0                  │
│                                                        │
├────────────────────────────────────────────────────────┤
│  Internal deps                                         │
│  ● @koi/core (L0) — ChannelAdapter, ContentBlock, etc │
│  ● @koi/channel-base (L0u) — createChannelAdapter     │
│  ● @koi/resolve (L0u) — BrickDescriptor               │
└────────────────────────────────────────────────────────┘
```

### Layer Position

```
L0  @koi/core ──────────────────────────────────────────┐
    ChannelAdapter, ContentBlock, InboundMessage          │
                                                          │
L0u @koi/channel-base ──────────────────┐               │
    createChannelAdapter<ChatSdkEvent>   │               │
                                          │               │
L0u @koi/resolve ────────────┐           │               │
    BrickDescriptor           │           │               │
                               ▼           ▼               ▼
L2  @koi/channel-chat-sdk ◄──┴───────────┴───────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✓ Chat SDK types stay internal (never leak to public API)
```

**Dev-only:** `@koi/engine`, `@koi/engine-pi`, `@koi/test-utils` used in E2E tests but are not runtime imports.

### Internal Structure

```
createChatSdkChannels(config)
│
├── createEventRouter(platforms)
│   Routes events by adapter name → platform handlers
│
├── createSharedLifecycle(config, ...)
│   ● Lazy Chat SDK initialization (promise guard)
│   ● Ref-counted connect/disconnect
│   ● Registers onNewMention + onSubscribedMessage
│
└── for each platform:
    createPlatformChannelAdapter(platform, router, lifecycle)
    │
    └── createChannelAdapter<ChatSdkEvent>({
          name: "chat-sdk:slack",
          capabilities: { text, images, files, buttons, threads },
          platformConnect:    → lifecycle.connect(),
          platformDisconnect: → lifecycle.disconnect(),
          platformSend:       → mapContentToPostable() → adapter.postMessage(),
          platformSendStatus: → adapter.startTyping(),
          onPlatformEvent:    → router.add(platform, handler),
          normalize:          → normalizeChatSdkEvent(),
        })
```

---

## Platform Capabilities

Each platform declares what content types it supports natively. Unsupported blocks are downgraded to text fallbacks by `renderBlocks()` from `@koi/channel-base`.

```
╔═══════════╦══════╦════════╦═══════╦═════════╦═══════╦═══════╦═════════╗
║ Platform  ║ text ║ images ║ files ║ buttons ║ audio ║ video ║ threads ║
╠═══════════╬══════╬════════╬═══════╬═════════╬═══════╬═══════╬═════════╣
║ Slack     ║  ✓   ║   ✓    ║   ✓   ║    ✓    ║   ✗   ║   ✗   ║    ✓    ║
║ Discord   ║  ✓   ║   ✓    ║   ✓   ║    ✓    ║   ✗   ║   ✗   ║    ✓    ║
║ Teams     ║  ✓   ║   ✓    ║   ✓   ║    ✓    ║   ✗   ║   ✗   ║    ✓    ║
║ GChat     ║  ✓   ║   ✓    ║   ✗   ║    ✓    ║   ✗   ║   ✗   ║    ✓    ║
║ GitHub    ║  ✓   ║   ✓    ║   ✗   ║    ✗    ║   ✗   ║   ✗   ║    ✓    ║
║ Linear    ║  ✓   ║   ✓    ║   ✗   ║    ✗    ║   ✗   ║   ✗   ║    ✓    ║
╚═══════════╩══════╩════════╩═══════╩═════════╩═══════╩═══════╩═════════╝

When sending to a platform that lacks support:
  ImageBlock on GitHub → "![alt](url)" markdown (images: true, native)
  FileBlock on GitHub  → "[filename](url)" text fallback (files: false)
  ButtonBlock on Linear → "[label]" text fallback (buttons: false)
```

---

## Content Mapping

### Outbound: Koi ContentBlock → Chat SDK Markdown

```
mapContentToPostable(content) → { markdown: string }

╔═══════════════════════╦══════════════════════════════════╗
║ Koi ContentBlock      ║ Chat SDK markdown                ║
╠═══════════════════════╬══════════════════════════════════╣
║ TextBlock("hello")    ║ "hello"                          ║
║ ImageBlock(url, alt)  ║ "![alt](url)"                    ║
║ FileBlock(url, name)  ║ "[name](url)"                    ║
║ ButtonBlock(label)    ║ "[label]"                         ║
║ CustomBlock(...)      ║ (skipped — not mappable)          ║
╚═══════════════════════╩══════════════════════════════════╝

Multiple blocks joined with "\n\n":
  [TextBlock("Report"), ImageBlock("chart.png")] →
  { markdown: "Report\n\n![image](chart.png)" }
```

### Inbound: Chat SDK Message → Koi InboundMessage

```
normalize(ChatSdkEvent) → InboundMessage | null

╔══════════════════════════════╦════════════════════════════════╗
║ Chat SDK input               ║ Koi output                     ║
╠══════════════════════════════╬════════════════════════════════╣
║ message.text = "hello"       ║ [TextBlock("hello")]           ║
║ attachment type "image"      ║ [ImageBlock(url, alt)]         ║
║ attachment type "file"       ║ [FileBlock(url, mimeType)]     ║
║ message.author.isMe = true   ║ null (bot echo — filtered)     ║
║ empty text + no attachments  ║ null (ignored)                 ║
║ message.isMention = true     ║ metadata: { isMention: true }  ║
╚══════════════════════════════╩════════════════════════════════╝

Thread ID comes from thread.id, sender ID from message.author.userId.
```

---

## Configuration

### ChatSdkChannelConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `platforms` | `readonly PlatformConfig[]` | **required** | One or more platform configs |
| `userName` | `string` | `"koi-bot"` | Bot display name for the Chat SDK |

### Per-Platform Config (discriminated union on `platform`)

```
╔═══════════╦═══════════════════════════════════════════════════════════╗
║ Platform  ║ Optional credentials (auto-detected from env if omitted) ║
╠═══════════╬═══════════════════════════════════════════════════════════╣
║ slack     ║ botToken, signingSecret                                  ║
║ discord   ║ botToken, publicKey, applicationId                       ║
║ teams     ║ appId, appPassword                                       ║
║ gchat     ║ credentials: { client_email, private_key, project_id? }  ║
║ github    ║ token, webhookSecret, userName                           ║
║ linear    ║ apiKey, webhookSecret, userName                          ║
╚═══════════╩═══════════════════════════════════════════════════════════╝

All credentials are optional — Chat SDK adapters auto-detect from
environment variables when not provided explicitly.
```

### Validation

```
validateChatSdkChannelConfig(input: unknown): Result<ChatSdkChannelConfig, KoiError>

Validates:
  ● input is an object
  ● platforms is a non-empty array
  ● each platform has a valid "platform" discriminant
  ● no duplicate platforms
  ● returns Result (never throws)
```

---

## Usage

### Standalone (without L1 engine)

```typescript
import { createChatSdkChannels } from "@koi/channel-chat-sdk";

const adapters = createChatSdkChannels({
  platforms: [
    { platform: "slack" },    // credentials from SLACK_BOT_TOKEN env
    { platform: "discord" },  // credentials from DISCORD_BOT_TOKEN env
  ],
});

// Connect all adapters
for (const adapter of adapters) {
  await adapter.connect();

  // Register message handler
  adapter.onMessage(async (msg) => {
    console.log(`[${adapter.platform}] ${msg.senderId}: ${msg.content}`);
    await adapter.send({
      content: [{ kind: "text", text: "Got it!" }],
      threadId: msg.threadId,
    });
  });
}

// Route webhooks (e.g., in a Bun.serve handler)
const slackAdapter = adapters.find((a) => a.platform === "slack")!;
const response = await slackAdapter.handleWebhook(request);
```

### With Full L1 Runtime (createKoi)

```typescript
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createChatSdkChannels } from "@koi/channel-chat-sdk";

// 1. Create channel adapters
const [channel] = createChatSdkChannels({
  platforms: [{ platform: "slack" }],
});

// 2. Create engine adapter (real LLM)
const adapter = createPiAdapter({
  model: "anthropic:claude-haiku-4-5-20251001",
  systemPrompt: "You are a helpful Slack bot.",
  getApiKey: async () => process.env.ANTHROPIC_API_KEY!,
});

// 3. Assemble L1 runtime
const runtime = await createKoi({
  manifest: {
    name: "SlackBot",
    version: "1.0.0",
    model: { name: "anthropic:claude-haiku-4-5-20251001" },
  },
  adapter,
  channelId: "@koi/channel-chat-sdk",
  // Wire typing indicators
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

### Webhook Routing (Bun.serve)

```typescript
Bun.serve({
  port: 3000,
  async fetch(request) {
    const url = new URL(request.url);

    // Route by platform prefix
    if (url.pathname === "/webhooks/slack") {
      return slackAdapter.handleWebhook(request);
    }
    if (url.pathname === "/webhooks/discord") {
      return discordAdapter.handleWebhook(request);
    }

    return new Response("Not Found", { status: 404 });
  },
});
```

### Auto-Resolution via BrickDescriptor

```yaml
# agent-manifest.yaml
name: support-bot
channels:
  - id: "@koi/channel-chat-sdk"
    options:
      platforms:
        - platform: slack
        - platform: discord
```

The `descriptor` export enables the Koi resolver to discover and instantiate the channel adapter from a manifest.

---

## Shared Lifecycle

The Chat SDK instance is shared across all platform adapters. Lifecycle is ref-counted:

```
createChatSdkChannels({
  platforms: [slack, discord, teams]
})
       │
       ▼
┌──────────────────────────────────────────────┐
│  SharedLifecycle                              │
│                                               │
│  Chat instance: null (lazy — created on       │
│                        first connect)         │
│  connectedCount: 0                            │
│                                               │
│  ensureInitialized()                          │
│   ● Promise guard prevents concurrent init    │
│   ● Creates Chat instance with all adapters   │
│   ● Registers onNewMention + onSubscribedMsg  │
│   ● Calls chat.initialize()                   │
│                                               │
│  connect()                                    │
│   ● Initializes if needed                     │
│   ● connectedCount++                          │
│                                               │
│  disconnect()                                 │
│   ● connectedCount--                          │
│   ● When count reaches 0: chat.shutdown()     │
│                                               │
│  shutdown()                                   │
│   ● Force shutdown regardless of count        │
└──────────────────────────────────────────────┘

Timeline:
  slackAdapter.connect()   → connectedCount = 1 (Chat initialized)
  discordAdapter.connect() → connectedCount = 2 (no-op, already init)
  slackAdapter.disconnect()→ connectedCount = 1 (Chat stays alive)
  discordAdapter.disconnect()→ connectedCount = 0 (Chat shutdown)
```

---

## API Reference

### Factory Functions

| Function | Returns | Purpose |
|----------|---------|---------|
| `createChatSdkChannels(config, overrides?)` | `readonly ChatSdkChannelAdapter[]` | Create N adapters from config |
| `validateChatSdkChannelConfig(input)` | `Result<ChatSdkChannelConfig, KoiError>` | Validate config (never throws) |

### ChatSdkChannelAdapter (extends ChannelAdapter)

| Method / Property | Returns | Purpose |
|-------------------|---------|---------|
| `connect()` | `Promise<void>` | Initialize shared Chat SDK + platform adapter |
| `disconnect()` | `Promise<void>` | Ref-counted; shuts down Chat on last disconnect |
| `send(message)` | `Promise<void>` | Map content → markdown → `adapter.postMessage()` |
| `onMessage(handler)` | `() => void` | Register handler (returns unsubscribe) |
| `sendStatus(status)` | `Promise<void>` | Typing indicator via `adapter.startTyping()` |
| `handleWebhook(request, options?)` | `Promise<Response>` | Delegate to Chat SDK webhook handler |
| `platform` | `string` | Platform name (`"slack"`, `"discord"`, etc.) |
| `name` | `string` | Adapter name (`"chat-sdk:slack"`, etc.) |
| `capabilities` | `ChannelCapabilities` | Per-platform capability flags |

### Types

| Type | Description |
|------|-------------|
| `ChatSdkChannelConfig` | `{ platforms: PlatformConfig[], userName?: string }` |
| `PlatformConfig` | Discriminated union on `platform` field |
| `PlatformName` | `"slack" \| "discord" \| "teams" \| "gchat" \| "github" \| "linear"` |
| `ChatSdkChannelAdapter` | Extended `ChannelAdapter` with `handleWebhook` + `platform` |
| `SlackPlatformConfig` | Slack-specific: `botToken?`, `signingSecret?` |
| `DiscordPlatformConfig` | Discord-specific: `botToken?`, `publicKey?`, `applicationId?` |
| `TeamsPlatformConfig` | Teams-specific: `appId?`, `appPassword?` |
| `GchatPlatformConfig` | Google Chat-specific: `credentials?` |
| `GithubPlatformConfig` | GitHub-specific: `token?`, `webhookSecret?`, `userName?` |
| `LinearPlatformConfig` | Linear-specific: `apiKey?`, `webhookSecret?`, `userName?` |

### BrickDescriptor

| Field | Value |
|-------|-------|
| `kind` | `"channel"` |
| `name` | `"@koi/channel-chat-sdk"` |
| `aliases` | `["chat-sdk"]` |
| `factory` | Returns first adapter from `createChatSdkChannels()` |

---

## Testing

### Test Structure

```
packages/channel-chat-sdk/src/
  config.test.ts                     Config validation (valid, invalid, edge cases)
  capabilities.test.ts               Per-platform capability constants
  normalize.test.ts                  Inbound normalization (text, attachments, bot echo)
  map-content.test.ts                Outbound content mapping (markdown generation)
  create-chat-sdk-channels.test.ts   Factory, lifecycle, send, status, error paths
  __tests__/
    integration.test.ts              Full webhook → normalize → send flow
    api-surface.test.ts              .d.ts snapshot stability
    e2e-full-stack.test.ts           Real LLM calls through full L1 runtime
```

### Coverage

77 tests, 0 failures, 90.86% coverage across 8 test files.

### E2E Tests (Real LLM)

Gated behind `E2E_TESTS=1` environment variable + `ANTHROPIC_API_KEY` presence:

```bash
# Run unit + integration tests only
bun test packages/channel-chat-sdk/

# Run everything including E2E with real Anthropic API calls
E2E_TESTS=1 bun test packages/channel-chat-sdk/
```

E2E tests validate the full pipeline:
- Channel adapter creation + properties
- Inbound → real LLM (Anthropic) → outbound through `createKoi`
- Tool calls through full stack (LLM invokes tool, result flows back)
- `sendStatus` typing indicators
- Multi-platform event isolation
- Middleware lifecycle hooks (`session_start` → `after_turn` → `session_end`)
- Rich content block mapping
- Bot echo prevention

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Chat SDK as internal infra | Chat SDK handles webhook verification, platform normalization, credential detection. Koi owns routing, state, and lifecycle |
| In-memory state only | `@chat-adapter/state-memory` — no Redis dependency. Koi handles persistence at higher layers |
| One normalizer for all platforms | Chat SDK already normalizes to unified `Message` type — platform differences are handled internally |
| One content mapper (markdown) | All Chat SDK adapters accept `{ markdown: string }` natively. Rich cards can be added in v2 |
| Lazy initialization | Chat SDK instance created on first `connect()`, not at factory call time. Saves resources for unused adapters |
| Ref-counted lifecycle | Multiple adapters share one Chat instance. Last disconnect triggers shutdown |
| Promise guard on init | Prevents concurrent initialization when multiple adapters call `connect()` simultaneously |
| `handleWebhook` on each adapter | Consumer routes HTTP to the right platform; adapter delegates to Chat SDK's verified webhook handler |
| Credentials optional | Chat SDK adapters auto-detect from env vars (`SLACK_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, etc.) |
| `@ts-expect-error` for adapter types | Chat SDK's `botUserId: string \| undefined` doesn't match `Adapter`'s `string?` under `exactOptionalPropertyTypes` |
| `sendStatus` → `startTyping` | Simple delegation. Chat SDK adapters handle platform-specific typing API internally |
| Event router via `Map` | O(1) lookup by adapter name. Immutable updates (new arrays on add/remove) |

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────┐
    ChannelAdapter, ContentBlock, InboundMessage,         │
    OutboundMessage, ChannelStatus, KoiError              │
                                                          │
L0u @koi/channel-base ──────────────────┐               │
    createChannelAdapter<ChatSdkEvent>   │               │
                                          │               │
L0u @koi/resolve ────────────┐           │               │
    BrickDescriptor           │           │               │
                               ▼           ▼               ▼
L2  @koi/channel-chat-sdk ◄──┴───────────┴───────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✓ Chat SDK types stay internal (never leak to public API)
    ✓ All interface properties readonly
    ✓ No vendor types in public API surface
```
