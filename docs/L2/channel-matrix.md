# @koi/channel-matrix — Matrix Homeserver Channel Adapter

Matrix channel adapter using matrix-bot-sdk. Connects to any Matrix homeserver (self-hosted or federated) as a bot, normalizes room events to InboundMessage, and sends OutboundMessage as Matrix room messages. Privacy-first, federated, and self-hostable.

---

## Why It Exists

Matrix is an open, federated protocol for real-time communication. Organizations that need data sovereignty, self-hosting, or federation between independent servers choose Matrix over centralized platforms. Bots on Matrix interact through homeserver APIs, receiving timeline events via filtered sync and sending messages to rooms.

`@koi/channel-matrix` wraps `matrix-bot-sdk` as a Koi L2 channel adapter. One `createMatrixChannel()` call returns a standard `ChannelAdapter` with auto-join, debouncing, send queue serialization, and filtered sync — all configured through a single config object.

### Matrix vs Other Channel Adapters

```
+========================+========================+============================+
| Feature                | channel-chat-sdk       | channel-matrix             |
+========================+========================+============================+
| Text messages          | Yes (markdown)         | Yes (native, 4000-char)    |
| Images                 | Yes (![](url))         | Yes (m.image)              |
| Files/attachments      | Yes ([name](url))      | Yes (m.file + mimetype)    |
| Buttons                | Depends on platform    | No (rendered as text)      |
| Voice/Audio            | No                     | No                         |
| Video                  | No                     | No                         |
| Threads                | Depends on platform    | Yes (room = thread)        |
| Federation             | No                     | Yes (cross-homeserver)     |
| Self-hosted            | No                     | Yes (run your own server)  |
| End-to-end encryption  | No                     | Feature flag (planned)     |
| Protocol               | HTTP webhooks          | Matrix sync API            |
+========================+========================+============================+

Use channel-chat-sdk when: you want multi-platform support (6 platforms, 1 factory)
Use channel-matrix when: you need federation, self-hosting, privacy, or Matrix-native features
```

---

## What This Enables

### Matrix Bot — Federated Messaging

```
                         +---------------------------------------------+
                         |           Your Koi Agent (YAML)              |
                         |  name: "matrix-bot"                          |
                         |  channels: [matrix]                          |
                         |  tools: [search, summarize]                  |
                         +----------------------+-----------------------+
                                                |
                     +--------------------------v-----------------------+
                     |            createKoi() -- L1 Engine              |
                     |  +---------------------------------------------+ |
                     |  | Middleware Chain                              | |
                     |  |  audit -> rate-limit -> your-custom -> ...   | |
                     |  +---------------------------------------------+ |
                     |  +---------------------------------------------+ |
                     |  | Engine Adapter (Pi / LangGraph / etc.)       | |
                     |  |  -> real LLM calls (Anthropic, OpenAI)       | |
                     |  +---------------------------------------------+ |
                     +--------------------------+-----------------------+
                                                |
               +--------------------------------v-------------------------------+
               |       createMatrixChannel() -- THIS PACKAGE                    |
               |                                                                |
               |  ONE factory -> Matrix Sync API (filtered, real-time)          |
               |                                                                |
               |  +--------+  +--------+  +--------+  +-------------------+    |
               |  |  Text   |  | Image  |  |  File  |  | Auto-Join Rooms   |   |
               |  | Message |  | Upload |  | Upload |  | on Invite         |   |
               |  +----+---+  +----+---+  +----+---+  +---------+---------+    |
               |       |          |            |                 |              |
               |  +----v----------v------------v-----------------v-----------+  |
               |  |  matrix-bot-sdk Client (Sync API + REST)                 |  |
               |  |  Filtered sync  *  Debounced events  *  Send queue       |  |
               |  +--------------------------+-------------------------------+  |
               +---------------------------------+------------------------------+
                                                 |
                                                 v
                                    +-------------------------+
                                    |   Matrix Homeserver      |
                                    |   (Sync API, HTTPS)      |
                                    +------------+-------------+
                                                 |
                    +----------------------------v----------------------------+
                    |              Matrix Rooms (Federated)                    |
                    |                                                          |
                    |  !general:matrix.org    !support:company.com             |
                    |  "hey bot!"             "summarize this doc"             |
                    |  [image.png]            [report.pdf]                     |
                    +----------------------------------------------------------+
```

### Event Types -> InboundMessage Mapping

```
Matrix Event                normalizer           InboundMessage
============               ==========           ==============

m.room.message         -->  createNormalizer  -->  TextBlock, ImageBlock,
  msgtype: m.text                                  FileBlock
  msgtype: m.notice                                threadId: roomId
  msgtype: m.image
  msgtype: m.file

m.room.message         -->  createNormalizer  -->  null (filtered)
  sender === botUserId       (bot echo prevention)

m.room.message         -->  createNormalizer  -->  null (filtered)
  msgtype: m.video           (unsupported type)
  msgtype: m.audio
  msgtype: m.location
```

---

## Inbound + Outbound Flow

### Inbound: Matrix Room Event -> Agent

```
User types in !general:matrix.org       Matrix Homeserver
"hey bot, search for X"  ------------>  Sync response
[attaches screenshot.png]               m.room.message event
                                              |
                                       matrix-bot-sdk Client
                                       receives sync, emits
                                       "room.message" event
                                              |
                                       onPlatformEvent()
                                       wraps as (roomId, event)
                                       enriches with room_id
                                              |
                                       createNormalizer(botUserId)
                                       * m.text -> TextBlock
                                       * m.image -> ImageBlock
                                       * m.file -> FileBlock
                                       * filters bot echo
                                       * threadId = room_id
                                              |
                                       InboundMessage {
                                         content: [
                                           TextBlock("hey bot, search for X"),
                                           ImageBlock("mxc://matrix.org/abc"),
                                         ],
                                         senderId: "@user:matrix.org",
                                         threadId: "!general:matrix.org",
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

### Outbound: Agent -> Matrix

```
                                       OutboundMessage {
                                         content: [
                                           TextBlock("Found 3 results..."),
                                           ImageBlock("mxc://matrix.org/img1"),
                                           FileBlock("mxc://matrix.org/f1",
                                                     "application/pdf",
                                                     "report.pdf"),
                                         ],
                                         threadId: "!general:matrix.org"
                                       }
                                              |
                                       createPlatformSend(client)
                                       * TextBlock -> client.sendText(roomId, text)
                                         (chunked at 4000 chars via splitText)
                                       * ImageBlock -> client.sendMessage(roomId,
                                         { msgtype: "m.image", body, url })
                                       * FileBlock -> client.sendMessage(roomId,
                                         { msgtype: "m.file", body, url, info })
                                       * ButtonBlock -> client.sendText(roomId,
                                         "[label]") (text fallback)
                                       * CustomBlock -> silently skipped
                                              |
                                       createRetryQueue serializes sends
                                       (prevents homeserver rate limiting)
                                              |
                                       matrix-bot-sdk REST API call
                                              |
User sees message in               Matrix Homeserver
!general:matrix.org  <--------------------------+
```

---

## Architecture

`@koi/channel-matrix` is an **L2 feature package** built on `@koi/channel-base` (L0u).

```
+------------------------------------------------------------+
|  @koi/channel-matrix  (L2)                                  |
|                                                              |
|  config.ts                  <- config types + defaults       |
|  sync-filter.ts             <- createSyncFilter()            |
|  matrix-channel.ts          <- createMatrixChannel()         |
|  normalize.ts               <- MatrixRoomEvent -> Inbound    |
|  platform-send.ts           <- Outbound -> Matrix API        |
|  descriptor.ts              <- BrickDescriptor               |
|  index.ts                   <- public API surface            |
|                                                              |
+--------------------------------------------------------------+
|  External deps                                               |
|  * matrix-bot-sdk 0.7.1                                      |
|                                                              |
+--------------------------------------------------------------+
|  Internal deps                                               |
|  * @koi/core (L0) -- ChannelAdapter, ContentBlock, etc       |
|  * @koi/channel-base (L0u) -- createChannelAdapter           |
|  * @koi/errors (L0u) -- RETRYABLE_DEFAULTS                   |
|  * @koi/resolve (L0u) -- BrickDescriptor                     |
+--------------------------------------------------------------+
```

### Layer Position

```
L0  @koi/core ------------------------------------------+
    ChannelAdapter, ContentBlock, InboundMessage          |
                                                          |
L0u @koi/channel-base ----------------------+            |
    createChannelAdapter<MatrixRoomEvent>    |            |
                                             |            |
L0u @koi/errors ---------------+            |            |
    RETRYABLE_DEFAULTS          |            |            |
                                |            |            |
L0u @koi/resolve ----+         |            |            |
    BrickDescriptor   |         |            |            |
                      v         v            v            v
L2  @koi/channel-matrix <------+------------+------------+
    imports from L0 + L0u only
    x never imports @koi/engine (L1)
    x never imports peer L2 packages
    ok matrix-bot-sdk types stay internal (never leak to public API)
    ok All interface properties readonly
    ok No vendor types in public API surface
```

**Dev-only:** `@koi/engine`, `@koi/engine-pi`, `@koi/test-utils` used in E2E tests but are not runtime imports.

### Internal Structure

```
createMatrixChannel(config)
|
+-- createSyncFilter()
|   Returns filter object: timeline limit 10, exclude presence,
|   targeted state types (m.room.message, m.room.member)
|
+-- getClient()
|   Dynamic import of matrix-bot-sdk (lazy, avoids bundling)
|   SimpleFsStorageProvider(storagePath)
|   new MatrixClient(homeserverUrl, accessToken, storage)
|   (or config._client for testing)
|
+-- createDebouncer({ windowMs: 500 })
|   500ms debounce window to coalesce rapid messages
|
+-- createRetryQueue()
|   Serializes outbound sends (prevents homeserver rate limiting)
|
+-- createChannelAdapter<MatrixRoomEvent>({
      name: "matrix",
      capabilities: { text, images, files, buttons:false, audio:false,
                       video:false, threads, supportsA2ui:false },
      platformConnect:    -> client.start(syncFilter)
                           + auto-join handler on "room.invite",
      platformDisconnect: -> debouncer.dispose(), client.stop(),
      platformSend:       -> createPlatformSend(client) via sendQueue,
      onPlatformEvent:    -> client.on("room.message") -> handler(enriched),
      normalize:          -> createNormalizer(botUserId),
    })
```

---

## Sync Filter

The adapter applies a sync filter to reduce bandwidth and processing overhead:

```
+=======================+==========================================+
| Filter                | Effect                                   |
+=======================+==========================================+
| room.timeline.limit   | 10 most recent events per room           |
| room.state.types      | Only m.room.message and m.room.member    |
| presence.not_types    | Exclude ALL presence updates (["*"])     |
+=======================+==========================================+

Result: minimal sync payloads, faster startup, lower memory usage.
The bot only receives timeline events it can act on.
```

---

## Content Mapping

### Outbound: Koi ContentBlock -> Matrix Payload

```
createPlatformSend(client)(message)

+======================+=============================================+
| Koi ContentBlock     | Matrix API call                             |
+======================+=============================================+
| TextBlock("hello")   | client.sendText(roomId, "hello")            |
|                      | (chunked at 4000 chars via splitText)        |
| ImageBlock(url, alt) | client.sendMessage(roomId, {                |
|                      |   msgtype: "m.image", body: alt, url })     |
| FileBlock(url, m, n) | client.sendMessage(roomId, {                |
|                      |   msgtype: "m.file", body: name, url,       |
|                      |   info: { mimetype } })                     |
| ButtonBlock(label,a) | client.sendText(roomId, "[label]")          |
|                      | (text fallback -- Matrix has no buttons)    |
| CustomBlock(type, d) | silently skipped                            |
+======================+=============================================+

Text chunking: messages exceeding 4000 characters are split via
splitText (from @koi/channel-base) and sent as multiple sendText calls.

Send ordering: blocks are sent sequentially (one API call per block).
The createRetryQueue serializes all outbound to prevent rate limiting.
```

### Inbound: Matrix Event -> Koi InboundMessage

```
normalize(MatrixRoomEvent) -> InboundMessage | null

+==============================+========================================+
| Matrix input                 | Koi output                             |
+==============================+========================================+
| m.text body="hello"         | [TextBlock("hello")]                   |
| m.notice body="notice"      | [TextBlock("notice")]                  |
| m.image url="mxc://..." b   | [ImageBlock(url, body)]                |
| m.file url="mxc://..." b    | [FileBlock(url, mimetype, body)]       |
| sender === botUserId         | null (filtered -- bot echo)            |
| type !== "m.room.message"    | null (filtered -- non-message event)   |
| m.text body="" (empty)       | null (filtered -- empty text)          |
| m.image url="" (no url)      | null (filtered -- missing media)       |
| m.file url="" (no url)       | null (filtered -- missing media)       |
| m.video, m.audio, etc.       | null (filtered -- unsupported msgtype) |
+==============================+========================================+

Thread ID convention:
  Room ID is used directly as threadId: "!room1:matrix.org"
  One room = one conversation thread.
  All messages in a room share the same threadId.
```

---

## Configuration

### MatrixChannelConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `homeserverUrl` | `string` | **required** | Matrix homeserver URL (e.g., `"https://matrix.org"`) |
| `accessToken` | `string` | **required** | Bot access token from homeserver |
| `storagePath` | `string?` | `"./matrix-storage"` | Path for SimpleFsStorageProvider (sync state persistence) |
| `autoJoin` | `boolean?` | `true` | Auto-join rooms when invited |
| `features` | `MatrixFeatures?` | see below | Feature toggles |
| `debounceMs` | `number?` | `500` | Debounce window for rapid messages (ms) |
| `onHandlerError` | `function?` | `undefined` | Error callback for handler exceptions |
| `queueWhenDisconnected` | `boolean?` | `false` | Buffer sends while disconnected |

### MatrixFeatures

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `threads` | `boolean?` | `true` | Enable thread support (room = thread) |
| `reactions` | `boolean?` | `false` | Enable reaction handling |
| `encryption` | `boolean?` | `false` | Enable end-to-end encryption |
| `richText` | `boolean?` | `true` | Enable rich text (HTML) formatting in outbound messages |

### Test Injection Points

| Field | Purpose |
|-------|---------|
| `_client` | Pre-configured MatrixClient (skip `new MatrixClient()` and SDK import) |

---

## Usage

### Standalone (without L1 engine)

```typescript
import { createMatrixChannel } from "@koi/channel-matrix";

const channel = createMatrixChannel({
  homeserverUrl: "https://matrix.example.com",
  accessToken: process.env.MATRIX_ACCESS_TOKEN!,
  autoJoin: true,
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
import { createMatrixChannel } from "@koi/channel-matrix";

// 1. Create channel adapter
const channel = createMatrixChannel({
  homeserverUrl: "https://matrix.example.com",
  accessToken: process.env.MATRIX_ACCESS_TOKEN!,
  autoJoin: true,
});

// 2. Create engine adapter (real LLM)
const adapter = createPiAdapter({
  model: "anthropic:claude-haiku-4-5-20251001",
  systemPrompt: "You are a helpful Matrix bot.",
  getApiKey: async () => process.env.ANTHROPIC_API_KEY!,
});

// 3. Assemble L1 runtime
const runtime = await createKoi({
  manifest: {
    name: "MatrixBot",
    version: "1.0.0",
    model: { name: "anthropic:claude-haiku-4-5-20251001" },
  },
  adapter,
  channelId: "matrix",
});

// 4. Connect and wire message handler
await channel.connect();
channel.onMessage(async (msg) => {
  for await (const event of runtime.run({ kind: "messages", messages: [msg] })) {
    // process engine events
  }
});
```

### Auto-Resolution via BrickDescriptor

```yaml
# agent-manifest.yaml
name: matrix-bot
channels:
  - id: "@koi/channel-matrix"
    options:
      autoJoin: true
```

Environment variables: `MATRIX_HOMESERVER_URL` (required), `MATRIX_ACCESS_TOKEN` (required).

---

## API Reference

### Factory Functions

| Function | Returns | Purpose |
|----------|---------|---------|
| `createMatrixChannel(config)` | `ChannelAdapter` | Create adapter with matrix-bot-sdk client |

### ChannelAdapter (standard interface)

| Method / Property | Returns | Purpose |
|-------------------|---------|---------|
| `connect()` | `Promise<void>` | Resolve bot userId, register auto-join handler, start sync |
| `disconnect()` | `Promise<void>` | Dispose debouncer, unregister handlers, stop client |
| `send(message)` | `Promise<void>` | Send content blocks to Matrix room via send queue |
| `onMessage(handler)` | `() => void` | Register handler (returns unsubscribe) |
| `name` | `string` | `"matrix"` |
| `capabilities` | `ChannelCapabilities` | `{ text: true, images: true, files: true, buttons: false, audio: false, video: false, threads: true, supportsA2ui: false }` |

### Types

| Type | Description |
|------|-------------|
| `MatrixChannelConfig` | Config for `createMatrixChannel()` |
| `MatrixFeatures` | Feature flags: `threads`, `reactions`, `encryption`, `richText` |
| `MatrixRoomEvent` | Minimal Matrix room event shape used for normalization |

### BrickDescriptor

| Field | Value |
|-------|-------|
| `kind` | `"channel"` |
| `name` | `"@koi/channel-matrix"` |
| `aliases` | `["matrix"]` |
| `factory` | Reads `MATRIX_HOMESERVER_URL` + `MATRIX_ACCESS_TOKEN` from env |

---

## Testing

### Test Structure

```
packages/channel-matrix/src/
  normalize.test.ts                 m.text, m.notice, m.image, m.file normalization + bot echo filtering
  platform-send.test.ts             Outbound text, image, file, button fallback, chunking, ordering
  matrix-channel.test.ts            Factory, lifecycle, contract suite (testChannelAdapter), capabilities
  __tests__/
    e2e-full-stack.test.ts          Real LLM calls through full L1 runtime
```

### Coverage

34 unit tests + 6 E2E tests, 0 failures. 97%+ line coverage.

### E2E Tests (Real LLM)

Gated behind `E2E_TESTS=1` environment variable + `ANTHROPIC_API_KEY` presence:

```bash
# Run unit tests only
bun test --cwd packages/channel-matrix

# Run everything including E2E with real Anthropic API calls
export $(grep ANTHROPIC_API_KEY .env) && E2E_TESTS=1 bun test --cwd packages/channel-matrix src/__tests__/e2e-full-stack.test.ts
```

E2E tests validate the full pipeline through `createKoi` + `createPiAdapter`:
- Text message -> real Anthropic LLM -> outbound text
- Tool calls through full middleware chain (multiply tool)
- Bot echo prevention (bot's own messages filtered at normalization)
- Session + turn lifecycle hooks (`session_start` -> `after_turn` -> `session_end`)
- Connect/disconnect lifecycle
- Channel adapter capabilities verification

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| matrix-bot-sdk (TypeScript-native) | Bot-focused SDK with minimal API surface. TypeScript types built-in, no runtime type casting needed. Simpler than matrix-js-sdk (which targets full client apps) |
| Dynamic SDK import | `await import("matrix-bot-sdk")` avoids bundling the SDK when the adapter is not used. Only loaded at `connect()` time |
| Room ID as threadId | One room = one conversation thread. Simple 1:1 mapping avoids complex thread resolution. Matrix rooms are the natural conversation boundary |
| Filtered sync | Timeline limit of 10, exclude presence, targeted state types. Reduces bandwidth, memory, and processing overhead for bot-only use cases |
| Auto-join on invite | Default `true` — bots should join rooms when invited without manual intervention. Disabled via `autoJoin: false` for restricted deployments |
| 500ms debounce window | Coalesces rapid messages (e.g., user typing fast, paste-split). Uses `createDebouncer` from channel-base for consistency across channel adapters |
| Send queue serialization | `createRetryQueue` prevents homeserver rate limiting by serializing outbound messages. Matrix homeservers enforce rate limits on bot accounts |
| 4000-char text limit | Matrix messages have no official hard limit, but clients truncate long messages. 4000 chars provides a safe margin with room for formatting |
| Button text fallback | Matrix protocol has no native button support. Rendering as `[label]` text provides a readable fallback rather than silently dropping the block |
| Custom blocks silently skipped | No Matrix-specific escape hatches (unlike Discord embeds). Custom blocks are platform-specific and have no Matrix equivalent |
| Config-injected `_client` | Tests run without a real homeserver connection. No global mocks — just pass a mock client implementing `MatrixClientLike` |
| SimpleFsStorageProvider | Persists sync state to disk for efficient reconnection. Configurable via `storagePath` for multi-bot deployments or containerized environments |
| Bot echo prevention at normalizer | Filters `sender === botUserId` before the message enters the middleware chain. Prevents infinite loops where the bot responds to its own messages |
| Per-block sequential send | Each content block is sent as a separate Matrix API call (unlike Discord batching). Matrix API does not support multi-content payloads — each message type is a separate endpoint |

---

## Layer Compliance

```
L0  @koi/core ------------------------------------------+
    ChannelAdapter, ContentBlock, InboundMessage,         |
    OutboundMessage, ChannelCapabilities, KoiError        |
                                                          |
L0u @koi/channel-base ----------------------+            |
    createChannelAdapter<MatrixRoomEvent>    |            |
    createDebouncer, createRetryQueue        |            |
    splitText, text, image, file             |            |
                                             |            |
L0u @koi/errors ---------------+            |            |
    RETRYABLE_DEFAULTS          |            |            |
                                |            |            |
L0u @koi/resolve ----+         |            |            |
    BrickDescriptor   |         |            |            |
                      v         v            v            v
L2  @koi/channel-matrix <------+------------+------------+
    imports from L0 + L0u only
    x never imports @koi/engine (L1)
    x never imports peer L2 packages
    ok matrix-bot-sdk types stay internal (MatrixClientLike is local interface)
    ok All interface properties readonly
    ok No vendor types in public API surface
```
