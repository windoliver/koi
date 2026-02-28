# @koi/channel-teams — Microsoft Teams Channel Adapter

Enterprise-grade Microsoft Teams bot channel adapter using the Bot Framework Activity protocol. Receives Activities via HTTP webhook, normalizes them to Koi InboundMessages, and sends responses through stored turn contexts. Zero external runtime dependencies — all vendor types defined locally.

---

## Why It Exists

Microsoft Teams is the dominant enterprise messaging platform, with deep Azure AD integration, tenant-scoped authentication, and an Activity-based communication protocol (Bot Framework). Koi needs a Teams adapter that speaks this protocol natively — receiving webhook POSTs, normalizing Activities, and sending responses through turn contexts — without leaking Microsoft SDK types into the core architecture.

`@koi/channel-teams` wraps the Bot Framework Activity protocol as a Koi L2 channel adapter. One `createTeamsChannel()` call returns a `TeamsChannelAdapter` that listens on an HTTP webhook endpoint, normalizes inbound Activities, and sends responses through stored turn contexts with retry queue support.

### channel-chat-sdk vs channel-teams

```
+=======================+=======================+===========================+
| Feature               | channel-chat-sdk      | channel-teams             |
+=======================+=======================+===========================+
| Text messages         | Y (markdown)          | Y (native 4000-char)     |
| Images                | Y (![](url))          | Y (attachment)           |
| Files/attachments     | Y ([name](url))       | Y (native attachments)   |
| Buttons               | X                     | Y (text fallback)        |
| Adaptive Cards        | X                     | Y (feature flag)         |
| Task modules          | X                     | Y (feature flag)         |
| Messaging extensions  | X                     | Y (feature flag)         |
| @mention stripping    | X                     | Y (auto-strip <at> tags) |
| Proactive messaging   | X                     | Y (conversation refs)    |
| Azure AD auth         | X                     | Y (appId + appPassword)  |
| Tenant isolation      | X                     | Y (tenantId config)      |
| Bot echo prevention   | X                     | Y (from.id === appId)    |
| Gateway connection    | webhook (HTTP)        | webhook (HTTP)           |
+=======================+=======================+===========================+

Use channel-chat-sdk when: markdown is sufficient, or multi-platform (6 platforms, 1 factory)
Use channel-teams when: you need enterprise Teams features, Azure AD auth, or proactive messaging
```

---

## What This Enables

### Enterprise Teams Bot — Bot Framework Activity Protocol

```
                         +---------------------------------------------+
                         |           Your Koi Agent (YAML)             |
                         |  name: "teams-bot"                          |
                         |  channels: [teams]                          |
                         |  tools: [search, ticket-create]             |
                         +--------------------+------------------------+
                                              |
                     +------------------------v----------------------+
                     |            createKoi() -- L1 Engine           |
                     |  +------------------------------------------+ |
                     |  | Middleware Chain                          | |
                     |  |  audit -> rate-limit -> your-custom -> ...| |
                     |  +------------------------------------------+ |
                     |  +------------------------------------------+ |
                     |  | Engine Adapter (Pi / LangGraph / etc.)   | |
                     |  |  -> real LLM calls (Anthropic, OpenAI)   | |
                     |  +------------------------------------------+ |
                     +------------------------+----------------------+
                                              |
               +------------------------------v----------------------------+
               |       createTeamsChannel() -- THIS PACKAGE                |
               |                                                           |
               |  ONE factory -> HTTP Webhook (Bot Framework Activities)   |
               |                                                           |
               |  +--------+  +----------+  +------+  +---------+         |
               |  |  Text   |  |  Image   |  | File |  | Button  |         |
               |  | Message |  |Attachment |  |Attach|  |Fallback |         |
               |  +----+---+  +-----+----+  +--+---+  +----+----+         |
               |       |            |           |           |              |
               |  +----v------------v-----------v-----------v----------+   |
               |  |  Bun.serve() HTTP Webhook (port 3978)              |   |
               |  |  Activity normalization + turn context storage      |   |
               |  +------------------------+---------------------------+   |
               +---------------------------+-------------------------------+
                                           |
                                           v
                              +-------------------------+
                              |    Bot Framework API      |
                              |    (HTTP POST webhook)    |
                              +------------+------------+
                                           |
                    +----------------------v----------------------+
                    |              Microsoft Teams                 |
                    |                                              |
                    |  #general    #support    #engineering        |
                    |  "hey bot!"  @Bot help   [file attached]    |
                    |  [Adaptive Card response]                   |
                    +---------------------------------------------+
```

### Activity Types -> InboundMessage Mapping

```
Teams Activity                normalizer            InboundMessage
==============               ==========            ==============

type: "message"        -->  normalize()    -->  TextBlock, ImageBlock,
  text: "hello bot"                              FileBlock
  attachments: [...]                             metadata: { threadId }

type: "message"        -->  normalize()    -->  TextBlock (stripped)
  text: "<at>Bot</at>                            (@mention removed)
         what time?"

from.id === appId      -->  normalize()    -->  null (bot echo filtered)

type: "conversationUpdate" -> normalize()  -->  null (non-message filtered)
type: "invoke"         -->  normalize()    -->  null (non-message filtered)
```

---

## Inbound + Outbound Flow

### Inbound: Teams Activity -> Agent

```
User types in #general             Bot Framework
"@Bot search for X"     --------->  HTTP POST to /
attaches screenshot.png              Activity JSON body
                                          |
                                    Bun.serve() handler
                                    parses JSON body
                                    stores turn context
                                          |
                                    eventHandler(activity)
                                    dispatches to normalizer
                                          |
                                    normalize()
                                    * text -> TextBlock
                                    * strips <at>Bot</at> tags
                                    * image attachment -> ImageBlock
                                    * file attachment -> FileBlock
                                    * filters bot echo (from.id === appId)
                                    * filters non-message activities
                                          |
                                    InboundMessage {
                                      content: [
                                        TextBlock("search for X"),
                                        ImageBlock("screenshot.png"),
                                      ],
                                      senderId: "user-123",
                                      threadId: "conv-456",
                                      timestamp: 1717000000000,
                                    }
                                          |
                                    channel.onMessage() handlers
                                          |
                                    Koi middleware chain
                                          |
                                    LLM decides: call tool "search"
                                    with query "X"
                                          |
                                    Tool returns results
                                          |
                                    LLM composes reply
```

### Outbound: Agent -> Teams

```
                                    OutboundMessage {
                                      content: [
                                        TextBlock("Found 3 results..."),
                                        TextBlock("1. First result"),
                                        ImageBlock("chart.png", "chart"),
                                        FileBlock("report.pdf", ...),
                                      ],
                                      threadId: "conv-456"
                                    }
                                          |
                                    platformSend()
                                    * TextBlock -> merged text string
                                    * ImageBlock -> markdown ![alt](url)
                                    * FileBlock -> markdown [name](url)
                                    * ButtonBlock -> text fallback [label]
                                    * CustomBlock -> skipped
                                    * Splits text at 4000 chars
                                          |
                                    retryQueue.enqueue()
                                    * Extracts Retry-After from 429 errors
                                    * Bot Framework rate limiting
                                          |
                                    turnContext.sendActivity({
                                      type: "message",
                                      text: "Found 3 results...\n1. First result\n![chart](chart.png)\n[report.pdf](report.pdf)"
                                    })
                                          |
                                    Bot Framework REST API
                                          |
User sees response               Teams API POST
in #general channel  <-----------------------+
```

---

## Architecture

`@koi/channel-teams` is an **L2 feature package** built on `@koi/channel-base` (L0u).

```
+----------------------------------------------------------+
|  @koi/channel-teams  (L2)                                  |
|                                                            |
|  config.ts                  <- config types + features     |
|  activity-types.ts          <- local vendor type subset    |
|  teams-channel.ts           <- createTeamsChannel()        |
|  normalize.ts               <- Activity -> InboundMessage  |
|  platform-send.ts           <- OutboundMessage -> Activity |
|  descriptor.ts              <- BrickDescriptor             |
|  index.ts                   <- public API surface          |
|                                                            |
+------------------------------------------------------------+
|  External deps                                             |
|  * NONE — zero external runtime dependencies               |
|  * activity-types.ts defines minimal Bot Framework types   |
|    locally to avoid vendor SDK imports                      |
|                                                            |
+------------------------------------------------------------+
|  Internal deps                                             |
|  * @koi/core (L0) -- ChannelAdapter, ContentBlock, etc     |
|  * @koi/channel-base (L0u) -- createChannelAdapter         |
|  * @koi/errors (L0u) -- RETRYABLE_DEFAULTS                 |
|  * @koi/resolve (L0u) -- BrickDescriptor                   |
+------------------------------------------------------------+
```

### Layer Position

```
L0  @koi/core -----------------------------------------+
    ChannelAdapter, ContentBlock, InboundMessage          |
                                                          |
L0u @koi/channel-base -----------------+                |
    createChannelAdapter<TeamsActivity> |                |
                                        |                |
L0u @koi/errors -----------+           |                |
    RETRYABLE_DEFAULTS      |           |                |
                             |           |                |
L0u @koi/resolve ------+   |           |                |
    BrickDescriptor     |   |           |                |
                         v   v           v                v
L2  @koi/channel-teams <----+----------+----------------+
    imports from L0 + L0u only
    X never imports @koi/engine (L1)
    X never imports peer L2 packages
    Y vendor types defined locally (activity-types.ts)
    Y all interface properties readonly
    Y no vendor types in public API surface
    Y zero external runtime dependencies
```

**Dev-only:** `@koi/engine`, `@koi/engine-pi`, `@koi/test-utils` used in E2E tests but are not runtime imports.

### Internal Structure

```
createTeamsChannel(config)
|
+-- conversationRefs Map
|   Stores TeamsConversationReference for proactive messaging
|   (OpenClaw pattern)
|
+-- contextStore (TurnContextStore)
|   Maps conversationId -> most recent TeamsTurnContext
|   Used by platformSend to deliver responses
|
+-- createRetryQueue({ extractRetryAfterMs })
|   Extracts retryAfter from Bot Framework 429 errors
|   Converts seconds -> milliseconds
|
+-- Bun.serve({ port })
|   HTTP webhook endpoint (default port 3978)
|   POST -> parse Activity JSON -> store turn context -> dispatch
|   Non-POST -> 405 Method Not Allowed
|
+-- createChannelAdapter<TeamsActivity>({
      name: "teams",
      capabilities: { text, images, files, buttons, audio, video, threads },
      platformConnect:    -> Bun.serve(port) or skip (_agent test mode),
      platformDisconnect: -> server.stop(), clear maps,
      platformSend:       -> retryQueue.enqueue(sendFn),
      onPlatformEvent:    -> handler for incoming Activities,
      normalize:          -> createNormalizer(appId),
    })
    +-- .handleActivity(activity) -> dispatch + store conversation ref
    +-- .conversationReferences() -> ReadonlyMap of stored refs
```

---

## Content Mapping

### Outbound: Koi ContentBlock -> Teams Activity

```
platformSend(message) -> turnContext.sendActivity(payload)

+=======================+==============================================+
| Koi ContentBlock      | Teams payload                                |
+=======================+==============================================+
| TextBlock("hello")    | { type: "message", text: "hello" }           |
| ImageBlock(url, alt)  | { text: "![alt](url)" }  (markdown)         |
| FileBlock(url, _, n)  | { text: "[name](url)" }  (markdown link)    |
| ButtonBlock(label, a) | { text: "[label]" }  (text fallback)         |
| CustomBlock           | silently skipped                             |
+=======================+==============================================+

Chunking: all text blocks in a single OutboundMessage are merged into
one string with newline separators. Overflow splits into multiple sends:
  * Text > 4000 chars -> split via splitText, multiple sendActivity() calls
  * Each chunk sent as a separate Activity via the retry queue
```

### Inbound: Teams Activity -> Koi InboundMessage

```
normalize(TeamsActivity) -> InboundMessage | null

+==============================+========================================+
| Teams input                  | Koi output                             |
+==============================+========================================+
| activity.text = "hello"      | [TextBlock("hello")]                   |
| activity.text with <at> tags | [TextBlock("...")] (@mention stripped) |
| image/* attachment           | [ImageBlock(url, name)]                |
| other attachment             | [FileBlock(url, mimeType, name)]       |
| text + attachments           | [TextBlock, ImageBlock/FileBlock, ...] |
| from.id === appId            | null (bot echo filtered)               |
| type !== "message"           | null (non-message filtered)            |
| empty text, no attachments   | null (filtered)                        |
| text = "<at>Bot</at>" only   | null (empty after strip)               |
+==============================+========================================+

Thread ID convention:
  Teams conversation:  conversationId (e.g., "conv-456")
  The conversationId maps directly to threadId (Teams conversation = thread)
```

---

## Configuration

### TeamsChannelConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `appId` | `string` | **required** | Azure AD application ID |
| `appPassword` | `string` | **required** | Azure AD application password |
| `tenantId` | `string?` | `undefined` | Single-tenant Azure AD tenant ID |
| `port` | `number?` | `3978` | HTTP webhook endpoint port |
| `features` | `TeamsFeatures?` | see below | Feature toggles |
| `onHandlerError` | `function?` | `undefined` | Error callback for handler exceptions |
| `queueWhenDisconnected` | `boolean?` | `false` | Buffer sends while disconnected |

### TeamsFeatures

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `adaptiveCards` | `boolean?` | `false` | Enable Adaptive Cards support |
| `taskModules` | `boolean?` | `false` | Enable task modules |
| `messagingExtensions` | `boolean?` | `false` | Enable messaging extensions |

### Test Injection Points

| Field | Purpose |
|-------|---------|
| `_agent` | Skip real HTTP server setup (test mode) |

---

## Usage

### Standalone (without L1 engine)

```typescript
import { createTeamsChannel } from "@koi/channel-teams";

const channel = createTeamsChannel({
  appId: process.env.TEAMS_APP_ID!,
  appPassword: process.env.TEAMS_APP_PASSWORD!,
  port: 3978,
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
import { createTeamsChannel } from "@koi/channel-teams";

// 1. Create channel adapter
const channel = createTeamsChannel({
  appId: process.env.TEAMS_APP_ID!,
  appPassword: process.env.TEAMS_APP_PASSWORD!,
  tenantId: process.env.TEAMS_TENANT_ID,
});

// 2. Create engine adapter (real LLM)
const adapter = createPiAdapter({
  model: "anthropic:claude-haiku-4-5-20251001",
  systemPrompt: "You are a helpful Teams bot for enterprise support.",
  getApiKey: async () => process.env.ANTHROPIC_API_KEY!,
});

// 3. Assemble L1 runtime
const runtime = await createKoi({
  manifest: {
    name: "TeamsBot",
    version: "1.0.0",
    model: { name: "anthropic:claude-haiku-4-5-20251001" },
  },
  adapter,
  channelId: "@koi/channel-teams",
});

// 4. Connect and wire message handler
await channel.connect();
channel.onMessage(async (msg) => {
  for await (const event of runtime.run({ kind: "messages", messages: [msg] })) {
    // process engine events
  }
});
```

### Custom HTTP Integration (handleActivity)

```typescript
const channel = createTeamsChannel({
  appId: process.env.TEAMS_APP_ID!,
  appPassword: process.env.TEAMS_APP_PASSWORD!,
  _agent: {}, // Skip built-in HTTP server
});

await channel.connect();

channel.onMessage(async (msg) => {
  console.log("Received:", msg.content);
});

// Inject Activity from your own HTTP handler
await channel.handleActivity?.({
  type: "message",
  text: "hello from custom endpoint",
  from: { id: "user-1", name: "User" },
  conversation: { id: "conv-1" },
  serviceUrl: "https://smba.trafficmanager.net/teams/",
});
```

### Proactive Messaging (Conversation References)

```typescript
const channel = createTeamsChannel({
  appId: process.env.TEAMS_APP_ID!,
  appPassword: process.env.TEAMS_APP_PASSWORD!,
});

await channel.connect();

// After receiving at least one message from a conversation...
const refs = channel.conversationReferences();
for (const [convId, ref] of refs) {
  console.log(`Can message ${convId} via ${ref.serviceUrl} (bot: ${ref.botId})`);
}
```

### Auto-Resolution via BrickDescriptor

```yaml
# agent-manifest.yaml
name: teams-bot
channels:
  - id: "@koi/channel-teams"
    options:
      features:
        adaptiveCards: true
```

Environment variables: `TEAMS_APP_ID` (required), `TEAMS_APP_PASSWORD` (required), `TEAMS_TENANT_ID` (optional, for single-tenant apps).

---

## API Reference

### Factory Functions

| Function | Returns | Purpose |
|----------|---------|---------|
| `createTeamsChannel(config)` | `TeamsChannelAdapter` | Create adapter with HTTP webhook endpoint |

### TeamsChannelAdapter (extends ChannelAdapter)

| Method / Property | Returns | Purpose |
|-------------------|---------|---------|
| `connect()` | `Promise<void>` | Start HTTP webhook server on configured port |
| `disconnect()` | `Promise<void>` | Stop server, clear turn contexts and conversation refs |
| `send(message)` | `Promise<void>` | Serialize content blocks -> turn context sendActivity |
| `onMessage(handler)` | `() => void` | Register handler (returns unsubscribe) |
| `handleActivity?(activity)` | `Promise<void>` | Inject raw Activity for custom HTTP integration |
| `conversationReferences()` | `ReadonlyMap<string, TeamsConversationReference>` | Stored refs for proactive messaging |
| `name` | `string` | `"teams"` |
| `capabilities` | `ChannelCapabilities` | `{ text, images, files, buttons, audio: false, video: false, threads, supportsA2ui: false }` |

### Types

| Type | Description |
|------|-------------|
| `TeamsChannelConfig` | Config for `createTeamsChannel()` |
| `TeamsFeatures` | Feature flags: `adaptiveCards`, `taskModules`, `messagingExtensions` |
| `TeamsChannelAdapter` | Extended `ChannelAdapter` with `handleActivity` + `conversationReferences` |
| `TeamsActivity` | Minimal Bot Framework Activity shape (locally defined) |
| `TeamsAccount` | `{ id, name? }` identity in a conversation |
| `TeamsAttachment` | `{ contentType, contentUrl?, content?, name? }` |
| `TeamsConversation` | `{ id, name?, isGroup?, tenantId? }` |
| `TeamsConversationReference` | `{ conversationId, serviceUrl, botId, tenantId? }` |

### BrickDescriptor

| Field | Value |
|-------|-------|
| `kind` | `"channel"` |
| `name` | `"@koi/channel-teams"` |
| `aliases` | `["teams"]` |
| `factory` | Reads `TEAMS_APP_ID` + `TEAMS_APP_PASSWORD` + `TEAMS_TENANT_ID` from env |

---

## Testing

### Test Structure

```
packages/channel-teams/src/
  normalize.test.ts                  Activity normalization (text, images, files, @mention stripping,
                                      bot echo, non-message filtering, timestamps)
  platform-send.test.ts              Outbound serialization (text merge, markdown images/files,
                                      button fallback, custom skip, text chunking, missing context)
  teams-channel.test.ts              Factory, lifecycle, contract suite (testChannelAdapter),
                                      capabilities, handleActivity, conversation references
  __tests__/
    e2e-full-stack.test.ts           Real LLM calls through full L1 runtime
```

### Coverage

37 unit tests + 8 E2E tests, 0 failures. 95%+ line coverage.

### E2E Tests (Real LLM)

Gated behind `E2E_TESTS=1` environment variable + `ANTHROPIC_API_KEY` presence:

```bash
# Run unit tests only
bun test --cwd packages/channel-teams

# Run everything including E2E with real Anthropic API calls
export $(grep ANTHROPIC_API_KEY .env) && E2E_TESTS=1 bun test --cwd packages/channel-teams src/__tests__/e2e-full-stack.test.ts
```

E2E tests validate the full pipeline through `createKoi` + `createPiAdapter`:
- Teams Activity -> real Anthropic LLM -> outbound text
- Tool calls through full middleware chain (multiply tool)
- Bot echo prevention (from.id === appId -> filtered)
- @mention stripping (`<at>Bot</at>` -> removed)
- Conversation reference storage + cleanup on disconnect
- Non-message activity filtering (conversationUpdate -> ignored)
- Session/turn lifecycle hooks (`session_start` -> `after_turn` -> `session_end`)
- Channel capabilities verification

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Zero external runtime deps | All Bot Framework types defined locally in `activity-types.ts`. No Microsoft SDK import at runtime. Minimizes attack surface and avoids vendor lock-in in the dependency tree |
| HTTP webhook (Bun.serve) | Bot Framework uses HTTP POST for Activity delivery. `Bun.serve()` is the native Bun HTTP server — no Express, no Hono, no framework overhead |
| Local vendor type definitions | `TeamsActivity`, `TeamsAccount`, `TeamsAttachment`, `TeamsConversation` defined in `activity-types.ts` as minimal readonly interfaces. Never imports `botbuilder` or `@microsoft/agents-*` SDK types |
| 4000-char text limit | Teams messages support up to ~28K characters, but OpenClaw-derived convention uses 4000 for consistent chunking. `splitText()` from `@koi/channel-base` handles splitting |
| Config-injected `_agent` | Tests run without a real HTTP server or Azure AD credentials. Pass `_agent: {}` to skip `Bun.serve()` — then use `handleActivity()` to inject Activities directly |
| Conversation reference storage | Stores `TeamsConversationReference` (conversationId, serviceUrl, botId, tenantId) for each incoming Activity. Enables proactive messaging (OpenClaw pattern) without the full Microsoft SDK |
| Retry queue with Retry-After | Bot Framework returns 429 with `retryAfter` field (seconds). The retry queue extracts this and converts to milliseconds for `createRetryQueue()` from `@koi/channel-base` |
| Bot echo prevention via appId | Filters Activities where `from.id === appId` at normalization time. Prevents infinite loops when the bot receives its own outbound messages |
| @mention stripping via regex | Teams wraps bot mentions in `<at>BotName</at>` tags. Regex `/<at>.*?<\/at>\s*/g` strips them before creating TextBlock. Falls back to null if text is empty after stripping |
| Only process `type: "message"` | `conversationUpdate`, `invoke`, `installationUpdate`, and other Activity types return null from the normalizer. Keeps the adapter focused on conversational messages |
| Turn context store pattern | Maps `conversationId -> TeamsTurnContext` for response delivery. Each incoming Activity refreshes the context. Enables response delivery without maintaining a persistent connection |
| Feature flags for future capabilities | `TeamsFeatures` includes `adaptiveCards`, `taskModules`, `messagingExtensions` — all defaulting to false. Infrastructure for progressive feature enablement without breaking changes |
| Markdown fallback for rich content | Images rendered as `![alt](url)`, files as `[name](url)`, buttons as `[label]`. Teams renders markdown natively, so this provides rich-enough output without Adaptive Cards |

---

## Layer Compliance

```
L0  @koi/core -----------------------------------------+
    ChannelAdapter, ContentBlock, InboundMessage,         |
    OutboundMessage, ChannelCapabilities, KoiError        |
                                                          |
L0u @koi/channel-base -----------------+                |
    createChannelAdapter<TeamsActivity> |                |
    createRetryQueue, splitText         |                |
                                        |                |
L0u @koi/errors -----------+           |                |
    RETRYABLE_DEFAULTS      |           |                |
                             |           |                |
L0u @koi/resolve ------+   |           |                |
    BrickDescriptor     |   |           |                |
                         v   v           v                v
L2  @koi/channel-teams <----+----------+----------------+
    imports from L0 + L0u only
    X never imports @koi/engine (L1)
    X never imports peer L2 packages
    Y Bot Framework types defined locally (never imported from vendor SDK)
    Y all interface properties readonly
    Y no vendor types in public API surface
    Y zero external runtime dependencies
```
