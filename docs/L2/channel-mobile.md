# @koi/channel-mobile — WebSocket Gateway Adapter for Native Mobile Apps

WebSocket channel adapter for iOS and Android apps using `Bun.serve()`. Mobile clients connect via WebSocket, exchange JSON frames for messaging, and expose native device capabilities (camera, GPS, haptics) to the agent as tools. Zero external runtime dependencies.

---

## Why It Exists

Native mobile apps need a real-time, bidirectional connection to the Koi agent that HTTP request/response cannot provide. Mobile devices also carry unique hardware capabilities -- camera, GPS, accelerometer, haptic feedback -- that a desktop or web channel never offers. A purpose-built adapter bridges both gaps.

`@koi/channel-mobile` creates a `Bun.serve()` WebSocket server that native iOS/Android clients connect to. One `createMobileChannel()` call returns a `MobileChannelAdapter` with authentication, heartbeat, rate limiting, and a **tool surface** that lets the agent invoke device-native capabilities through WebSocket frames.

### channel-chat-sdk vs channel-mobile

```
+=======================+=======================+===========================+
| Feature               | channel-chat-sdk      | channel-mobile            |
+=======================+=======================+===========================+
| Text messages         | yes (markdown)        | yes (ContentBlock[])      |
| Images                | yes (![](url))        | yes (native)              |
| Files/attachments     | yes ([name](url))     | yes (native)              |
| Buttons               | limited               | yes (native)              |
| Audio                 | no                    | yes (native capture)      |
| Video                 | no                    | yes (native capture)      |
| Threads               | yes                   | yes (mobile:<clientId>)   |
| Device tools (camera) | no                    | yes (tool surface)        |
| Device tools (GPS)    | no                    | yes (tool surface)        |
| Device tools (haptic) | no                    | yes (tool surface)        |
| Auth                  | varies by platform    | bearer token on connect   |
| Heartbeat             | no                    | yes (ping/pong)           |
| Rate limiting         | no                    | yes (per-client sliding)  |
| Transport             | HTTP (webhook/SSE)    | WebSocket (real-time)     |
| External deps         | vercel/ai SDK         | zero                      |
+=======================+=======================+===========================+

Use channel-chat-sdk when: multi-platform (6 platforms, 1 factory), markdown sufficient
Use channel-mobile when: native iOS/Android, device tools, real-time bidirectional, zero deps
```

---

## What This Enables

### Native Mobile Agent -- Device Tools + Real-Time Messaging

```
                         +---------------------------------------------+
                         |           Your Koi Agent (YAML)              |
                         |  name: "mobile-assistant"                    |
                         |  channels: [mobile]                          |
                         |  tools: [search, mobile_camera, mobile_gps]  |
                         +----------------------+-----------------------+
                                                |
                     +--------------------------v------------------------+
                     |            createKoi() -- L1 Engine               |
                     |  +---------------------------------------------+ |
                     |  | Middleware Chain                              | |
                     |  |  audit -> rate-limit -> your-custom -> ...   | |
                     |  +---------------------------------------------+ |
                     |  +---------------------------------------------+ |
                     |  | Engine Adapter (Pi / LangGraph / etc.)       | |
                     |  |  -> real LLM calls (Anthropic, OpenAI)       | |
                     |  +---------------------------------------------+ |
                     +--------------------------+------------------------+
                                                |
               +--------------------------------v--------------------------------+
               |       createMobileChannel() -- THIS PACKAGE                     |
               |                                                                 |
               |  ONE factory -> Bun WebSocket server (zero external deps)       |
               |                                                                 |
               |  +--------+  +--------+  +------+  +-------+  +---------+      |
               |  |  Text  |  | Image  |  | File |  | Audio |  |  Tool   |      |
               |  |Message |  | Block  |  |Block |  | Block |  | Surface |      |
               |  +----+---+  +----+---+  +--+---+  +---+---+  +----+----+      |
               |       |          |          |          |            |            |
               |  +----v----------v----------v----------v------------v--------+  |
               |  |  Bun.serve() WebSocket server                              | |
               |  |  Bearer auth * Heartbeat * Rate limit * JSON frames        | |
               |  +-----------------------------+------------------------------+ |
               +--------------------------------|--------------------------------+
                                                |
                                                v
                              +---------------------------+
                              |    WebSocket Connection    |
                              |    (wss:// or ws://)       |
                              +-------------+-------------+
                                            |
                     +----------------------v----------------------+
                     |             Mobile Device                    |
                     |                                              |
                     |  Chat UI    Camera    GPS     Haptics        |
                     |  "hey bot!" [photo]  [coords] [vibrate]     |
                     |  File share  Audio capture  Video capture    |
                     +----------------------------------------------+
```

### Tool Surface -- Agent Invokes Native Device Capabilities

```
Agent decides:                         Mobile WebSocket
"I need a photo"  ----> tool_call  ----> Client receives frame:
                        frame            { kind: "tool_call",
                                           toolCallId: "tc-1",
                                           toolName: "mobile_camera",
                                           input: { facing: "back" } }
                                                  |
                                         Client opens camera,
                                         captures photo,
                                         sends result:
                                                  |
                        tool_result <---- { kind: "tool_result",
                        frame              toolCallId: "tc-1",
                                           result: { url: "data:image/..." } }
                                                  |
Agent receives          <----  LLM processes photo and replies
photo data
```

---

## Inbound + Outbound Flow

### Inbound: Mobile WebSocket Frame -> Agent

```
User taps Send in iOS app           WebSocket connection
"hey bot, what's nearby?"  -------->  JSON frame
  attaches photo                       { kind: "message",
                                         content: [
                                           { kind: "text", text: "..." },
                                           { kind: "image", url: "..." }
                                         ],
                                         senderId: "device-1" }
                                              |
                                       Bun.serve() websocket.message()
                                       parses JSON, validates auth,
                                       checks rate limit
                                              |
                                       enriches threadId if missing:
                                       threadId = "mobile:<clientId>"
                                              |
                                       eventHandler(frame)
                                              |
                                       createNormalizer()
                                       * kind === "message" -> InboundMessage
                                       * kind === "ping"    -> null (handled in WS)
                                       * kind === "auth"    -> null (handled in WS)
                                       * kind === "tool_result" -> null
                                       * empty content      -> null
                                              |
                                       InboundMessage {
                                         content: [
                                           TextBlock("hey bot, what's nearby?"),
                                           ImageBlock("data:image/..."),
                                         ],
                                         senderId: "device-1",
                                         threadId: "mobile:0",
                                         timestamp: 1717000000000,
                                       }
                                              |
                                       channel.onMessage() handlers
                                              |
                                       Koi middleware chain
                                              |
                                       LLM decides: call tool "mobile_gps"
                                              |
                                       Tool result returns coordinates
                                              |
                                       LLM composes reply
```

### Outbound: Agent -> Mobile App

```
                                       OutboundMessage {
                                         content: [
                                           TextBlock("Here are 3 places nearby..."),
                                           ImageBlock("https://maps.example/pin.png"),
                                           ButtonBlock("Show More", "show_more"),
                                         ],
                                         threadId: "mobile:0"
                                       }
                                              |
                                       createPlatformSend()
                                       * TextBlock > 8000 chars -> splitText()
                                       * Resolve clientId from "mobile:0"
                                       * Serialize as MobileOutboundFrame
                                              |
                                       ws.send(JSON.stringify({
                                         kind: "message",
                                         content: [
                                           { kind: "text", text: "Here are..." },
                                           { kind: "image", url: "https://..." },
                                           { kind: "button", label: "Show More",
                                             action: "show_more" },
                                         ]
                                       }))
                                              |
User sees rich message              WebSocket frame delivered
with map + button  <--------------------------+
```

### Status Indicator (sendStatus)

```
User sends message --------> Agent starts processing
                                       |
                                sendStatus({
                                  kind: "processing",
                                  messageRef: "mobile:0"
                                })
                                       |
                                JSON frame broadcast:
                                { kind: "status", status: {...} }
                                       |
User sees                       WebSocket frame
"thinking..." <-------------------------+
                                       |
                                ... LLM thinks (2-3 sec) ...
                                       |
                                channel.send(response)
                                       |
User sees reply  <--------------------------+
```

---

## Architecture

`@koi/channel-mobile` is an **L2 feature package** built on `@koi/channel-base` (L0u).

```
+----------------------------------------------------------+
|  @koi/channel-mobile  (L2)                                |
|                                                           |
|  config.ts                  <- config types + defaults    |
|  protocol.ts                <- MobileFrame discriminated  |
|                                union (inbound + outbound) |
|  mobile-channel.ts          <- createMobileChannel()      |
|  normalize.ts               <- MobileInboundFrame ->      |
|                                InboundMessage | null       |
|  platform-send.ts           <- OutboundMessage -> WS send |
|  tools.ts                   <- device tool descriptors    |
|                                (camera, GPS, haptic)      |
|  rate-limit.ts              <- per-client sliding window  |
|  descriptor.ts              <- BrickDescriptor            |
|  index.ts                   <- public API surface         |
|                                                           |
+-----------------------------------------------------------+
|  External deps: NONE (zero runtime deps)                  |
|                                                           |
+-----------------------------------------------------------+
|  Internal deps                                            |
|  * @koi/core (L0) -- ChannelAdapter, ContentBlock, etc    |
|  * @koi/channel-base (L0u) -- createChannelAdapter        |
|  * @koi/errors (L0u) -- RETRYABLE_DEFAULTS                |
|  * @koi/resolve (L0u) -- BrickDescriptor                  |
+-----------------------------------------------------------+
```

### Layer Position

```
L0  @koi/core ------------------------------------------------+
    ChannelAdapter, ContentBlock, InboundMessage,               |
    ToolDescriptor, ChannelCapabilities                         |
                                                                |
L0u @koi/channel-base ----------------------+                  |
    createChannelAdapter<MobileInboundFrame> |                  |
                                              |                  |
L0u @koi/errors ---------------+             |                  |
    RETRYABLE_DEFAULTS          |             |                  |
                                 |             |                  |
L0u @koi/resolve ----+         |             |                  |
    BrickDescriptor   |         |             |                  |
                       v         v             v                  v
L2  @koi/channel-mobile <------+-------------+------------------+
    imports from L0 + L0u only
    x never imports @koi/engine (L1)
    x never imports peer L2 packages
    + Bun.serve() types stay internal (never leak to public API)
    + All interface properties readonly
    + No vendor types in public API surface
    + Zero external runtime dependencies
```

**Dev-only:** `@koi/engine`, `@koi/engine-pi`, `@koi/test-utils` used in E2E tests but are not runtime imports.

### Internal Structure

```
createMobileChannel(config)
|
+-- parse config with defaults:
|   hostname = "0.0.0.0", heartbeatIntervalMs = 30000,
|   idleTimeoutMs = 120000, maxPayloadBytes = 1MB
|
+-- createRateLimiter(config.features.rateLimit)
|   Sliding-window per client (when configured)
|
+-- createChannelAdapter<MobileInboundFrame>({
      name: "mobile",
      capabilities: { text, images, files, buttons, audio, video, threads },
      platformConnect:    -> Bun.serve({ port, hostname, websocket: {...} }),
      platformDisconnect: -> clearInterval(heartbeat), server.stop(), clear clients,
      platformSend:       -> createPlatformSend(getClients)(message),
      platformSendStatus: -> broadcast { kind: "status", status } to all authed clients,
      onPlatformEvent:    -> set eventHandler for WebSocket message callback,
      normalize:          -> createNormalizer(),
    })
    |
    +-- .tools: readonly ToolDescriptor[]  (camera, GPS, haptic, or custom)
    +-- .connectedClients(): number
```

---

## Protocol Frames

All communication uses JSON-serialized WebSocket frames discriminated by `kind`.

### Inbound (client -> server)

```
+============================+=============================================+
| Frame Kind                 | Structure                                    |
+============================+=============================================+
| message                    | { kind: "message",                           |
|                            |   content: ContentBlock[],                   |
|                            |   senderId: string,                          |
|                            |   threadId?: string }                        |
+----------------------------+----------------------------------------------+
| tool_result                | { kind: "tool_result",                       |
|                            |   toolCallId: string,                        |
|                            |   result: unknown }                          |
+----------------------------+----------------------------------------------+
| ping                       | { kind: "ping" }                             |
+----------------------------+----------------------------------------------+
| auth                       | { kind: "auth", token: string }              |
+============================+=============================================+
```

### Outbound (server -> client)

```
+============================+=============================================+
| Frame Kind                 | Structure                                    |
+============================+=============================================+
| message                    | { kind: "message",                           |
|                            |   content: ContentBlock[] }                  |
+----------------------------+----------------------------------------------+
| tool_call                  | { kind: "tool_call",                         |
|                            |   toolCallId: string,                        |
|                            |   toolName: string,                          |
|                            |   input: unknown }                           |
+----------------------------+----------------------------------------------+
| pong                       | { kind: "pong" }                             |
+----------------------------+----------------------------------------------+
| error                      | { kind: "error",                             |
|                            |   message: string,                           |
|                            |   retryAfterMs?: number }                    |
+============================+=============================================+
```

### Content Mapping

```
Inbound normalize(MobileInboundFrame) -> InboundMessage | null

+================================+==========================================+
| Mobile input                   | Koi output                                |
+================================+==========================================+
| { kind: "message",             | InboundMessage {                          |
|   content: [TextBlock, ...],   |   content: [TextBlock, ...],              |
|   senderId: "device-1" }       |   senderId: "device-1",                   |
|                                |   threadId: "mobile:<clientId>",           |
|                                |   timestamp: Date.now() }                 |
+--------------------------------+-------------------------------------------+
| { kind: "message",             | null (filtered -- empty content)           |
|   content: [],                 |                                           |
|   senderId: "device-1" }       |                                           |
+--------------------------------+-------------------------------------------+
| { kind: "ping" }              | null (handled by WS layer, pong sent)     |
+--------------------------------+-------------------------------------------+
| { kind: "auth", token: "..." } | null (handled by WS layer)               |
+--------------------------------+-------------------------------------------+
| { kind: "tool_result", ... }  | null (handled by tool surface)            |
+================================+==========================================+

Thread ID convention:
  Auto-assigned:  "mobile:<clientId>"  (monotonic integer)
  Client-provided: preserved as-is from frame.threadId
```

```
Outbound createPlatformSend() -> ws.send(JSON frame)

+================================+==========================================+
| Koi ContentBlock               | WebSocket payload                         |
+================================+==========================================+
| TextBlock("hello")             | { kind: "message",                        |
|                                |   content: [{ kind: "text",               |
|                                |     text: "hello" }] }                    |
+--------------------------------+-------------------------------------------+
| ImageBlock(url, alt)           | { kind: "message",                        |
|                                |   content: [{ kind: "image",              |
|                                |     url: url }] }                         |
+--------------------------------+-------------------------------------------+
| ButtonBlock(label, action)     | { kind: "message",                        |
|                                |   content: [{ kind: "button",             |
|                                |     label: label, action: action }] }     |
+================================+==========================================+

Text chunking: text blocks > 8000 chars are split via splitText()
  from @koi/channel-base into multiple TextBlock entries within
  a single frame. Prefers splitting at newline boundaries.

Routing:
  * threadId present -> send to specific client (strip "mobile:" prefix)
  * threadId absent  -> broadcast to all connected clients
```

---

## Configuration

### MobileChannelConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `port` | `number` | **required** | WebSocket server port |
| `hostname` | `string?` | `"0.0.0.0"` | WebSocket server bind address |
| `authToken` | `string?` | `undefined` | Bearer token for `auth` frame validation |
| `tools` | `readonly ToolDescriptor[]?` | `[]` | Native mobile tool descriptors exposed to the agent |
| `heartbeatIntervalMs` | `number?` | `30000` | Interval for heartbeat pong broadcasts |
| `idleTimeoutMs` | `number?` | `120000` | Close connection after this idle duration |
| `maxPayloadBytes` | `number?` | `1048576` (1 MB) | Max WebSocket payload size |
| `features` | `MobileFeatures?` | see below | Feature toggles |
| `onHandlerError` | `function?` | `undefined` | Error callback for message processing failures |
| `queueWhenDisconnected` | `boolean?` | `false` | Buffer sends while disconnected |

### MobileFeatures

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `heartbeat` | `boolean?` | `true` | Enable heartbeat pong broadcasts at configured interval |
| `requireAuth` | `boolean?` | `false` | Require bearer token `auth` frame before accepting messages |
| `rateLimit` | `RateLimitConfig?` | `undefined` | Per-client sliding-window rate limit (disabled when absent) |

### RateLimitConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxMessages` | `number` | `30` | Maximum messages allowed in the window |
| `windowMs` | `number` | `60000` | Window duration in milliseconds |

### Test Injection Points

| Field | Purpose |
|-------|---------|
| `_server` | Pre-configured server instance (skip `Bun.serve()` call) |

---

## Usage

### Standalone (without L1 engine)

```typescript
import { createMobileChannel } from "@koi/channel-mobile";

const channel = createMobileChannel({
  port: 8080,
  features: { heartbeat: true, requireAuth: false },
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
import { createMobileChannel } from "@koi/channel-mobile";
import { DEFAULT_MOBILE_TOOLS } from "@koi/channel-mobile";

// 1. Create channel adapter with device tools
const channel = createMobileChannel({
  port: 8080,
  authToken: process.env.MOBILE_AUTH_TOKEN,
  tools: DEFAULT_MOBILE_TOOLS,
  features: {
    requireAuth: true,
    heartbeat: true,
    rateLimit: { maxMessages: 30, windowMs: 60_000 },
  },
});

// 2. Create engine adapter (real LLM)
const adapter = createPiAdapter({
  model: "anthropic:claude-haiku-4-5-20251001",
  systemPrompt: "You are a helpful mobile assistant with access to device tools.",
  getApiKey: async () => process.env.ANTHROPIC_API_KEY!,
});

// 3. Assemble L1 runtime
const runtime = await createKoi({
  manifest: {
    name: "MobileAssistant",
    version: "1.0.0",
    model: { name: "anthropic:claude-haiku-4-5-20251001" },
  },
  adapter,
  channelId: "mobile",
});

// 4. Connect and wire message handler
await channel.connect();
channel.onMessage(async (msg) => {
  for await (const event of runtime.run({ kind: "messages", messages: [msg] })) {
    // process engine events
  }
});
```

### With Device Tools (Camera, GPS, Haptic)

```typescript
import { createMobileChannel, CAMERA_TOOL, GPS_TOOL, HAPTIC_TOOL } from "@koi/channel-mobile";

// Built-in tools
const channel = createMobileChannel({
  port: 8080,
  tools: [CAMERA_TOOL, GPS_TOOL, HAPTIC_TOOL],
});

// Or use DEFAULT_MOBILE_TOOLS (includes all three)
import { DEFAULT_MOBILE_TOOLS } from "@koi/channel-mobile";
const channel2 = createMobileChannel({
  port: 8081,
  tools: DEFAULT_MOBILE_TOOLS,
});

// Custom tools
const channel3 = createMobileChannel({
  port: 8082,
  tools: [
    ...DEFAULT_MOBILE_TOOLS,
    {
      name: "mobile_contacts",
      description: "Search the device contact list.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query for contacts." },
        },
      },
      tags: ["mobile", "contacts"],
    },
  ],
});
```

### With Authentication

```typescript
const channel = createMobileChannel({
  port: 8080,
  authToken: "secret-bearer-token",
  features: { requireAuth: true },
});

await channel.connect();

// Client must send auth frame before any messages:
// ws.send(JSON.stringify({ kind: "auth", token: "secret-bearer-token" }))
//
// Messages sent before auth receive:
// { kind: "error", message: "Not authenticated" }
//
// Invalid auth token receives:
// { kind: "error", message: "Authentication failed" }
// followed by connection close with code 4001
```

### Auto-Resolution via BrickDescriptor

```yaml
# agent-manifest.yaml
name: mobile-assistant
channels:
  - id: "@koi/channel-mobile"
    options:
      port: 8080
      authToken: "${MOBILE_AUTH_TOKEN}"
```

The descriptor reads `port` from options (default: 8080) and `authToken` from options (enables `requireAuth: true` when present).

---

## Built-In Tool Descriptors

The package ships three device-native tool descriptors the agent can invoke on the mobile client:

```
+==================+====================================================+
| Tool             | Description                                         |
+==================+====================================================+
| mobile_camera    | Capture a photo using the device camera.             |
|                  | Input: { facing: "front" | "back" }                 |
|                  | Tags: ["mobile", "media"]                           |
+------------------+-----------------------------------------------------+
| mobile_gps       | Get the current GPS coordinates of the device.       |
|                  | Input: { accuracy: "high" | "balanced" | "low" }    |
|                  | Tags: ["mobile", "location"]                        |
+------------------+-----------------------------------------------------+
| mobile_haptic    | Trigger haptic feedback (vibration) on the device.   |
|                  | Input: { pattern: "light"|"medium"|"heavy"|"success"}|
|                  | Tags: ["mobile", "feedback"]                        |
+==================+====================================================+
```

All three are exported individually (`CAMERA_TOOL`, `GPS_TOOL`, `HAPTIC_TOOL`) and as a collection (`DEFAULT_MOBILE_TOOLS`).

---

## Rate Limiting

Per-client sliding-window rate limiter prevents message flooding from mobile devices.

```
Client "device-1" sends messages:  t=0  t=1  t=2  t=3  ...
                                    |    |    |    |
                                    v    v    v    v
Window: [t=0, t=1, t=2]  (maxMessages: 3, windowMs: 60000)
                                              |
                                         t=3 -> BLOCKED
                                         retryAfterMs = oldest + windowMs - now
                                              |
                                         { kind: "error",
                                           message: "Rate limit exceeded",
                                           retryAfterMs: 58000 }

When client disconnects -> limiter.reset(clientId)
When server stops       -> limiter.resetAll()
```

---

## API Reference

### Factory Functions

| Function | Returns | Purpose |
|----------|---------|---------|
| `createMobileChannel(config)` | `MobileChannelAdapter` | Create adapter backed by Bun WebSocket server |
| `createRateLimiter(config?)` | `{ check, reset, resetAll }` | Create per-client sliding-window rate limiter |

### MobileChannelAdapter (extends ChannelAdapter)

| Method / Property | Returns | Purpose |
|-------------------|---------|---------|
| `connect()` | `Promise<void>` | Start Bun WebSocket server, begin heartbeat |
| `disconnect()` | `Promise<void>` | Stop server, clear heartbeat, disconnect all clients |
| `send(message)` | `Promise<void>` | Send OutboundMessage as JSON frame to client(s) |
| `onMessage(handler)` | `() => void` | Register handler (returns unsubscribe) |
| `sendStatus(status)` | `Promise<void>` | Broadcast status frame to all authenticated clients |
| `tools` | `readonly ToolDescriptor[]` | Device tool descriptors available to the agent |
| `connectedClients()` | `number` | Count of currently connected WebSocket clients |
| `name` | `string` | `"mobile"` |
| `capabilities` | `ChannelCapabilities` | `{ text, images, files, buttons, audio, video, threads, supportsA2ui: false }` |

### Types

| Type | Description |
|------|-------------|
| `MobileChannelConfig` | Config for `createMobileChannel()` |
| `MobileChannelAdapter` | Extended `ChannelAdapter` with `tools` + `connectedClients()` |
| `MobileFeatures` | Feature flags: `heartbeat`, `requireAuth`, `rateLimit` |
| `MobileInboundFrame` | Discriminated union: `message`, `tool_result`, `ping`, `auth` |
| `MobileOutboundFrame` | Discriminated union: `message`, `tool_call`, `pong`, `error` |
| `RateLimitConfig` | `{ maxMessages, windowMs }` |
| `RateLimitResult` | `{ allowed, retryAfterMs }` |

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_HEARTBEAT_INTERVAL_MS` | `30000` | Default heartbeat interval |
| `DEFAULT_IDLE_TIMEOUT_MS` | `120000` | Default idle timeout |
| `DEFAULT_MAX_PAYLOAD_BYTES` | `1048576` | Default max payload (1 MB) |
| `DEFAULT_MOBILE_PORT` | `8080` | Default WebSocket server port |
| `DEFAULT_RATE_LIMIT` | `{ maxMessages: 30, windowMs: 60000 }` | Default rate limit config |
| `CAMERA_TOOL` | `ToolDescriptor` | Camera capture tool descriptor |
| `GPS_TOOL` | `ToolDescriptor` | GPS location tool descriptor |
| `HAPTIC_TOOL` | `ToolDescriptor` | Haptic feedback tool descriptor |
| `DEFAULT_MOBILE_TOOLS` | `readonly ToolDescriptor[]` | All three built-in mobile tools |

### BrickDescriptor

| Field | Value |
|-------|-------|
| `kind` | `"channel"` |
| `name` | `"@koi/channel-mobile"` |
| `aliases` | `["mobile"]` |
| `factory` | Reads `port` + `authToken` from options, enables `requireAuth` when token present |

---

## Testing

### Test Structure

```
packages/channel-mobile/src/
  normalize.test.ts                     Normalizer: message -> InboundMessage, ping/auth/tool_result -> null
  platform-send.test.ts                 Outbound: targeted send, broadcast, text chunking, prefix stripping
  tools.test.ts                         Tool descriptors: required fields, unique names, DEFAULT_MOBILE_TOOLS
  rate-limit.test.ts                    Rate limiter: allow, block, independent clients, window expiry, reset
  mobile-channel.test.ts                Factory, lifecycle, contract suite (testChannelAdapter), WebSocket
                                        integration (auth, ping/pong, client tracking, threadId assignment)
  __tests__/
    e2e-full-stack.test.ts              Real LLM calls through full L1 runtime
```

### Coverage

46 unit tests + 7 E2E tests, 0 failures across 6 test files. 95%+ line coverage.

### E2E Tests (Real LLM)

Gated behind `E2E_TESTS=1` environment variable + `ANTHROPIC_API_KEY` presence:

```bash
# Run unit tests only
bun test --cwd packages/channel-mobile

# Run everything including E2E with real Anthropic API calls
export $(grep ANTHROPIC_API_KEY .env) && E2E_TESTS=1 bun test --cwd packages/channel-mobile src/__tests__/e2e-full-stack.test.ts
```

E2E tests validate the full pipeline through `createKoi` + `createPiAdapter`:
- WebSocket message -> real Anthropic LLM -> outbound WebSocket frame
- Tool calls through full middleware chain (multiply tool)
- Session and turn lifecycle hooks (`session_start` -> `after_turn` -> `session_end`)
- Connect/disconnect lifecycle + client tracking
- Ping/pong heartbeat via WebSocket
- Auth flow: reject unauthenticated, accept after valid auth frame
- ThreadId auto-assignment (`mobile:<clientId>` format)
- Channel adapter capabilities verification

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| `Bun.serve()` WebSocket (zero deps) | Native Bun WebSocket server eliminates all external runtime dependencies. No `ws`, no `socket.io` -- just the runtime |
| JSON frame protocol | Simple, debuggable, universal. Every mobile platform has JSON parsing. Binary protocols (protobuf, msgpack) are a premature optimization for chat workloads |
| `kind`-discriminated unions | Type-safe frame dispatch. `MobileInboundFrame` and `MobileOutboundFrame` use `kind` field matching Koi's discriminated union pattern throughout |
| Tool surface via WebSocket frames | Agent sends `tool_call` frame, client responds with `tool_result` frame. This bidirectional pattern lets the agent invoke device-native capabilities (camera, GPS, haptics) without any bridge library |
| Bearer token auth (not TLS client certs) | Mobile apps already manage bearer tokens for API auth. Reusing the same pattern keeps the client SDK simple. TLS client certs are complex on mobile |
| Auth frame on connect (not HTTP header) | WebSocket upgrade in Bun doesn't expose headers easily. An explicit `auth` frame after connect is simpler and more debuggable |
| Per-client rate limiting | Mobile clients can flood the server (rapid tapping, automation). Sliding-window per clientId prevents abuse. Rate limiter is optional (disabled by default) to avoid overhead for trusted deployments |
| Text chunking at 8000 chars | More generous than Discord's 2000 or Slack's 4000 -- native apps can render long text. Still split to prevent WebSocket frame size issues and UI jank |
| `mobile:<clientId>` threadId format | Monotonic integer client IDs are simple and collision-free within a server instance. The `mobile:` prefix makes threadIds globally unique across channel types |
| Config-injected `_server` | Tests run without binding a real port. Pass a mock server object to test WebSocket logic in isolation |
| Heartbeat as server-initiated pong | Server broadcasts `pong` frames at interval. Client sends `ping` to check liveness. This is the inverse of typical WebSocket ping/pong but works better for mobile where the client needs to know the server is alive |
| `connectedClients()` method | Monitoring hook for dashboards and health checks. Returns the current count without exposing the internal client map |
| Broadcast when no threadId | Outbound messages without a `threadId` go to all connected clients. Useful for announcements, system messages, or single-client deployments |
| Status frame broadcast to authed clients only | `sendStatus` only sends to authenticated clients, preventing status leaks to unauthenticated connections |

---

## Layer Compliance

```
L0  @koi/core ------------------------------------------------+
    ChannelAdapter, ContentBlock, InboundMessage,               |
    OutboundMessage, ChannelStatus, ToolDescriptor              |
                                                                |
L0u @koi/channel-base ----------------------+                  |
    createChannelAdapter<MobileInboundFrame> |                  |
    splitText()                               |                  |
                                              |                  |
L0u @koi/errors ---------------+             |                  |
    RETRYABLE_DEFAULTS          |             |                  |
                                 |             |                  |
L0u @koi/resolve ----+         |             |                  |
    BrickDescriptor   |         |             |                  |
                       v         v             v                  v
L2  @koi/channel-mobile <------+-------------+------------------+
    imports from L0 + L0u only
    x never imports @koi/engine (L1)
    x never imports peer L2 packages
    + Bun.serve() types stay internal (never leak to public API)
    + All interface properties readonly
    + No vendor types in public API surface
    + Zero external runtime dependencies
```
