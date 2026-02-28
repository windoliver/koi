# @koi/channel-signal — Signal Messenger Channel Adapter

Signal messenger channel adapter using signal-cli subprocess in JSON-RPC mode. End-to-end encrypted messaging for Koi agents via the Signal Protocol — supports DMs and group messages with E.164 phone number normalization.

---

## Why It Exists

Signal is the gold standard for end-to-end encrypted messaging. Organizations that need secure, privacy-first agent communication cannot use platforms where messages are readable by the platform operator. `@koi/channel-signal` bridges Koi agents to Signal's encrypted network through signal-cli — a Java-based command-line client that implements the full Signal Protocol.

One `createSignalChannel()` call returns a standard `ChannelAdapter` that manages a signal-cli subprocess, reads JSON-RPC events from stdout, writes commands to stdin, and normalizes everything into Koi's `InboundMessage`/`OutboundMessage` types. No native Signal SDK, no Electron, no browser — just a subprocess that speaks JSON.

### What Signal Gives You

```
+--------------------------------------------------------------+
| Signal Protocol (via signal-cli subprocess)                   |
|                                                               |
|  End-to-end encryption  ......  Messages never readable       |
|                                  by the server                |
|  DMs + Group messages  .......  Phone number = identity       |
|  Text + Attachments  .........  Images, files, documents      |
|  Delivery receipts  ..........  Read/delivered confirmations   |
|  Typing indicators  ..........  (received, not surfaced)      |
|  No vendor lock-in  ..........  Open-source protocol          |
+--------------------------------------------------------------+

Capabilities:
  text: true   | images: true  | files: true   | buttons: false
  audio: false | video: false  | threads: false | supportsA2ui: false

Signal is text-first. No buttons, no embeds, no interactive components.
Images and files are supported as attachments.
```

---

## What This Enables

### Encrypted Agent Communication — Zero Platform Trust

```
                         +---------------------------------------------+
                         |           Your Koi Agent (YAML)             |
                         |  name: "secure-assistant"                   |
                         |  channels: [signal]                         |
                         |  tools: [lookup, summarize]                 |
                         +--------------------+------------------------+
                                              |
                     +------------------------v----------------------+
                     |            createKoi() -- L1 Engine           |
                     |  +------------------------------------------+ |
                     |  | Middleware Chain                          | |
                     |  |  audit -> rate-limit -> your-custom      | |
                     |  +------------------------------------------+ |
                     |  +------------------------------------------+ |
                     |  | Engine Adapter (Pi / LangGraph / etc.)   | |
                     |  |  -> real LLM calls (Anthropic, OpenAI)   | |
                     |  +------------------------------------------+ |
                     +------------------------+----------------------+
                                              |
               +------------------------------v----------------------------+
               |       createSignalChannel() -- THIS PACKAGE               |
               |                                                           |
               |  ONE factory -> signal-cli subprocess (JSON-RPC mode)     |
               |                                                           |
               |  +--------+  +----------+  +----------+  +------------+  |
               |  |  Text   |  | E.164    |  | Debounce |  | Subprocess |  |
               |  | Message |  | Normalize|  | Window   |  | Lifecycle  |  |
               |  +----+---+  +----+-----+  +----+-----+  +-----+-----+  |
               |       |           |              |              |         |
               |  +----v-----------v--------------v--------------v------+  |
               |  |  signal-cli subprocess (Java, JSON-RPC on stdio)   |  |
               |  |  Bun.spawn() -> stdout reader + stdin writer       |  |
               |  +------------------------+--------------------------+   |
               +---------------------------+-------------------------------+
                                           |
                                           v
                              +-------------------------+
                              |    Signal Protocol       |
                              |    (E2E encrypted)       |
                              +------------+------------+
                                           |
                    +----------------------v----------------------+
                    |              Signal Network                  |
                    |                                              |
                    |  +1234567890    +4915123456789               |
                    |  "hey agent!"  "Zusammenfassung bitte"      |
                    |  [attachment]   group.abc123                 |
                    +---------------------------------------------+
```

### Event Types -> InboundMessage Mapping

```
signal-cli Event            normalizer           InboundMessage
================            ==========           ==============

dataMessage              ->  createNormalizer  ->  TextBlock(body)
  "hello agent!"                                   senderId: "+1234567890"
  body: "hello agent!"                             threadId: "+1234567890" (DM)
                                                   threadId: "group.abc" (group)

dataMessage + groupInfo  ->  createNormalizer  ->  TextBlock(body)
  group message                                    threadId: groupId

receiptMessage           ->  createNormalizer  ->  null (filtered)
  delivery/read receipt

typingMessage            ->  createNormalizer  ->  null (filtered)
  typing indicator

empty body               ->  createNormalizer  ->  null (filtered)
  system event
```

---

## Inbound + Outbound Flow

### Inbound: Signal Event -> Agent

```
User sends Signal message           signal-cli subprocess
"hey agent, look up X"  ---------->  stdout JSON-RPC event
+1234567890                          { params: { source, dataMessage } }
                                           |
                                    readStdout()
                                    line-by-line JSON parsing
                                    parseSignalEvent(json)
                                           |
                                    SignalEvent {
                                      kind: "message",
                                      source: "+1234567890",
                                      body: "hey agent, look up X",
                                      timestamp: 1700000000000
                                    }
                                           |
                                    createNormalizer()
                                    * text body -> TextBlock
                                    * normalizeE164(source)
                                    * threadId = groupId ?? phone
                                    * filters receipts, typing
                                    * filters empty body
                                           |
                                    InboundMessage {
                                      content: [
                                        TextBlock("hey agent, look up X"),
                                      ],
                                      senderId: "+1234567890",
                                      threadId: "+1234567890",
                                      timestamp: 1700000000000,
                                    }
                                           |
                                    channel.onMessage() handlers
                                           |
                                    Koi middleware chain
                                           |
                                    LLM decides: call tool "lookup"
                                           |
                                    Tool returns results
                                           |
                                    LLM composes reply
```

### Outbound: Agent -> Signal

```
                                    OutboundMessage {
                                      content: [
                                        TextBlock("Found 3 results..."),
                                        ImageBlock(url, "screenshot"),
                                      ],
                                      threadId: "+1234567890"
                                    }
                                           |
                                    createPlatformSend()
                                    * TextBlock -> message body
                                    * ImageBlock -> "[Image: alt]"
                                    * FileBlock -> "[File: name]"
                                    * ButtonBlock -> "[label]"
                                    * CustomBlock -> skipped
                                    * Merge all text, join with \n
                                    * splitText at 4000 chars
                                    * Detect DM vs group (group.*)
                                           |
                                    JSON-RPC command to stdin:
                                    {
                                      "jsonrpc": "2.0",
                                      "method": "send",
                                      "params": {
                                        "message": "Found 3 results...\n[Image: screenshot]",
                                        "recipient": "+1234567890",
                                        "account": "+0987654321"
                                      }
                                    }
                                           |
                                    signal-cli subprocess
                                    writes to stdin
                                           |
User receives encrypted             Signal Protocol
message on their device  <--------------------+
```

---

## Architecture

`@koi/channel-signal` is an **L2 feature package** built on `@koi/channel-base` (L0u).

```
+----------------------------------------------------------+
|  @koi/channel-signal  (L2)                                |
|                                                           |
|  config.ts                  <- config types + defaults    |
|  signal-channel.ts          <- createSignalChannel()      |
|  normalize.ts               <- SignalEvent -> Inbound     |
|  platform-send.ts           <- Outbound -> JSON-RPC send  |
|  signal-process.ts          <- subprocess lifecycle       |
|  e164.ts                    <- phone number normalization  |
|  descriptor.ts              <- BrickDescriptor             |
|  index.ts                   <- public API surface          |
|                                                           |
+-----------------------------------------------------------+
|  External deps                                            |
|  * NONE (zero external runtime dependencies)              |
|                                                           |
+-----------------------------------------------------------+
|  System requirements                                      |
|  * Java runtime (JRE 21+)                                 |
|  * signal-cli binary (installed separately)               |
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
    ChannelAdapter, ContentBlock, InboundMessage                |
                                                                |
L0u @koi/channel-base ----------------------+                  |
    createChannelAdapter<SignalEvent>        |                  |
                                             |                  |
L0u @koi/errors --------------------+       |                  |
    RETRYABLE_DEFAULTS              |       |                  |
                                     |       |                  |
L0u @koi/resolve ----------+        |       |                  |
    BrickDescriptor         |        |       |                  |
                             v        v       v                  v
L2  @koi/channel-signal <---+--------+-------+------------------+
    imports from L0 + L0u only
    x never imports @koi/engine (L1)
    x never imports peer L2 packages
    + signal-cli types stay internal (never leak to public API)
    + All interface properties readonly
    + Zero external runtime dependencies
```

**Dev-only:** `@koi/engine`, `@koi/engine-pi`, `@koi/test-utils` used in E2E tests but are not runtime imports.

### Internal Structure

```
createSignalChannel(config)
|
+-- createSignalProcess(account, signalCliPath, configPath, spawnFn)
|   Manages signal-cli subprocess lifecycle
|   Reads stdout line-by-line (JSON events)
|   Writes JSON-RPC commands to stdin
|   Graceful shutdown: SIGTERM -> 5s -> SIGKILL
|
+-- createDebouncer({ windowMs: debounceMs })
|   500ms default debounce for rapid messages
|   (skipped when debounceMs = 0)
|
+-- createPlatformSend(signalProcess, account)
|   Converts OutboundMessage -> JSON-RPC "send" commands
|   Detects DM vs group by threadId prefix ("group.")
|   Chunks text at 4000 chars via splitText
|
+-- createChannelAdapter<SignalEvent>({
      name: "signal",
      capabilities: { text, images, files, buttons:false, ... },
      platformConnect:    -> signalProcess.start(),
      platformDisconnect: -> debouncer.dispose(), signalProcess.stop(),
      platformSend:       -> createPlatformSend(process, account),
      onPlatformEvent:    -> signalProcess.onEvent(handler),
      normalize:          -> createNormalizer(),
    })
```

---

## Subprocess Lifecycle

```
channel.connect()
|
+-- signalProcess.start()
|   |
|   +-- Bun.spawn(["signal-cli", "-a", account, "jsonRpc"])
|   |   (or with --config if configPath provided)
|   |
|   +-- readStdout(proc.stdout)
|       Line-by-line JSON parsing in background
|       parseSignalEvent(json) -> SignalEvent | null
|       eventHandler?.(event) -> dispatches to normalizer
|
+-- channel.onMessage(handler)
|   Registers inbound message handler
|
+-- ... messages flow in/out ...
|
+-- channel.disconnect()
    |
    +-- debouncer?.dispose()
    |   Cleans up any pending debounce timers
    |
    +-- signalProcess.stop()
        |
        +-- proc.kill(15)           // SIGTERM
        +-- await Promise.race([
        |     proc.exited,          // clean exit
        |     timeout(5000)         // 5 second grace period
        |   ])
        +-- if timeout: proc.kill(9)  // SIGKILL
        +-- proc = undefined
```

---

## Content Mapping

### Outbound: Koi ContentBlock -> Signal Message

```
createPlatformSend(message) -> signalProcess.send(rpc)

+=======================+==========================================+
| Koi ContentBlock      | Signal output                            |
+=======================+==========================================+
| TextBlock("hello")    | message body: "hello"                    |
| ImageBlock(url, alt)  | message body: "[Image: alt]"             |
| FileBlock(url, _, n)  | message body: "[File: name]"             |
| ButtonBlock(label, a) | message body: "[label]"                  |
| CustomBlock(type, d)  | silently skipped                         |
+=======================+==========================================+

All renderable blocks are merged into a single text body, joined
by newlines. The body is split at 4000 characters into multiple
JSON-RPC "send" commands if needed.

Recipient detection:
  threadId starts with "group." -> params: { groupId, message, account }
  otherwise                     -> params: { recipient, message, account }
```

### Inbound: signal-cli Event -> Koi InboundMessage

```
normalize(SignalEvent) -> InboundMessage | null

+==============================+========================================+
| signal-cli input             | Koi output                             |
+==============================+========================================+
| dataMessage.message = "hi"   | [TextBlock("hi")]                      |
| dataMessage + groupInfo      | threadId: groupInfo.groupId            |
| dataMessage (DM, no group)   | threadId: normalizeE164(source)        |
| receiptMessage               | null (filtered)                        |
| typingMessage                | null (filtered)                        |
| empty body ("")              | null (filtered)                        |
| malformed JSON line          | silently skipped (parse error)         |
+==============================+========================================+

Thread ID convention:
  DM:     "+1234567890" (E.164 phone number)
  Group:  "group.abc123" (signal-cli group identifier)

Phone normalization (normalizeE164):
  "+1 202 555 1234"  ->  "+12025551234"
  "+1-202-555-1234"  ->  "+12025551234"
  "12025551234"      ->  "+12025551234"
  "+1(202)555.1234"  ->  "+12025551234"
  "abc"              ->  null (invalid, uses raw source)
```

---

## Configuration

### SignalChannelConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `account` | `string` | **required** | Signal account phone number in E.164 format (e.g., `"+1234567890"`) |
| `signalCliPath` | `string?` | `"signal-cli"` | Path to signal-cli binary |
| `configPath` | `string?` | `undefined` | signal-cli config directory (passed as `--config`) |
| `debounceMs` | `number?` | `500` | Debounce window for rapid messages in milliseconds |
| `onHandlerError` | `function?` | `undefined` | Error callback for message processing failures |
| `queueWhenDisconnected` | `boolean?` | `false` | Buffer outbound messages while disconnected |

### Test Injection Points

| Field | Purpose |
|-------|---------|
| `_spawn` | `SpawnFn` — mock `Bun.spawn` for testing without a real signal-cli binary |

---

## Usage

### Standalone (without L1 engine)

```typescript
import { createSignalChannel } from "@koi/channel-signal";

const channel = createSignalChannel({
  account: "+1234567890",
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
import { createSignalChannel } from "@koi/channel-signal";

// 1. Create channel adapter
const channel = createSignalChannel({
  account: "+1234567890",
  debounceMs: 500,
});

// 2. Create engine adapter (real LLM)
const adapter = createPiAdapter({
  model: "anthropic:claude-haiku-4-5-20251001",
  systemPrompt: "You are a helpful Signal bot.",
  getApiKey: async () => process.env.ANTHROPIC_API_KEY!,
});

// 3. Assemble L1 runtime
const runtime = await createKoi({
  manifest: {
    name: "SignalBot",
    version: "1.0.0",
    model: { name: "anthropic:claude-haiku-4-5-20251001" },
  },
  adapter,
  channelId: "signal",
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
name: secure-assistant
channels:
  - id: "@koi/channel-signal"
    options:
      signalCliPath: "/usr/local/bin/signal-cli"
      configPath: "/home/bot/.signal"
```

Environment variables: `SIGNAL_ACCOUNT` (required — the registered phone number in E.164 format).

### E.164 Phone Normalization (standalone utility)

```typescript
import { normalizeE164, isE164 } from "@koi/channel-signal";

isE164("+12025551234");          // true
isE164("12025551234");           // false (missing +)
isE164("+1 202 555 1234");       // false (formatting chars)

normalizeE164("+1 202 555 1234"); // "+12025551234"
normalizeE164("+1-202-555-1234"); // "+12025551234"
normalizeE164("12025551234");     // "+12025551234"
normalizeE164("abc");             // null
```

---

## API Reference

### Factory Functions

| Function | Returns | Purpose |
|----------|---------|---------|
| `createSignalChannel(config)` | `ChannelAdapter` | Create adapter backed by signal-cli subprocess |

### ChannelAdapter (standard Koi interface)

| Method / Property | Returns | Purpose |
|-------------------|---------|---------|
| `connect()` | `Promise<void>` | Spawn signal-cli subprocess in JSON-RPC mode |
| `disconnect()` | `Promise<void>` | Dispose debouncer, SIGTERM/SIGKILL subprocess |
| `send(message)` | `Promise<void>` | Convert content blocks to JSON-RPC send commands |
| `onMessage(handler)` | `() => void` | Register handler (returns unsubscribe) |
| `name` | `string` | `"signal"` |
| `capabilities` | `ChannelCapabilities` | `{ text: true, images: true, files: true, buttons: false, audio: false, video: false, threads: false, supportsA2ui: false }` |

### Utility Functions

| Function | Returns | Purpose |
|----------|---------|---------|
| `normalizeE164(phone)` | `string \| null` | Normalize phone to E.164 format, null if invalid |
| `isE164(phone)` | `boolean` | Validate strict E.164 format |

### Types

| Type | Description |
|------|-------------|
| `SignalChannelConfig` | Config for `createSignalChannel()` |
| `SpawnFn` | Subprocess spawn function signature (for test injection) |
| `SignalEvent` | Discriminated union: `message`, `receipt`, `typing` |
| `SignalAttachment` | `{ contentType, filename?, id }` |
| `SignalCommand` | JSON-RPC command: `{ method, params }` |
| `SignalProcess` | Subprocess lifecycle handle: `start`, `stop`, `send`, `onEvent`, `isRunning` |

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_SIGNAL_DEBOUNCE_MS` | `500` | Default debounce window |
| `SIGNAL_SHUTDOWN_TIMEOUT_MS` | `5000` | Grace period before SIGKILL |

### BrickDescriptor

| Field | Value |
|-------|-------|
| `kind` | `"channel"` |
| `name` | `"@koi/channel-signal"` |
| `aliases` | `["signal"]` |
| `factory` | Reads `SIGNAL_ACCOUNT` from env, creates adapter |

---

## Testing

### Test Structure

```
packages/channel-signal/src/
  e164.test.ts                      E.164 validation and normalization
  normalize.test.ts                 Signal event -> InboundMessage normalization
  platform-send.test.ts             Outbound text merging, chunking, DM vs group routing
  signal-process.test.ts            Subprocess spawn, stdin/stdout, lifecycle
  signal-channel.test.ts            Factory, capabilities, contract suite (testChannelAdapter)
  __tests__/
    e2e-full-stack.test.ts          Real LLM calls through full L1 runtime
```

### Coverage

44 unit tests + 6 E2E tests, 0 failures across 6 test files. 95%+ line coverage.

### E2E Tests (Real LLM)

Gated behind `E2E_TESTS=1` environment variable + `ANTHROPIC_API_KEY` presence:

```bash
# Run unit tests only
bun test --cwd packages/channel-signal

# Run everything including E2E with real Anthropic API calls
export $(grep ANTHROPIC_API_KEY .env) && E2E_TESTS=1 bun test --cwd packages/channel-signal src/__tests__/e2e-full-stack.test.ts
```

E2E tests validate the full pipeline through `createKoi` + `createPiAdapter`:
- Signal JSON-RPC event -> real Anthropic LLM -> outbound JSON-RPC send
- Tool calls through full middleware chain (multiply tool)
- Middleware hook observation (`session_start` -> `after_turn` -> `session_end`)
- Connect/disconnect lifecycle (spawn and kill verification)
- E.164 phone normalization in inbound messages
- Bot echo prevention (filtered at normalizer level)

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| signal-cli subprocess (JSON-RPC mode) | Mature Java implementation of the full Signal Protocol. No native SDK needed — just spawn a process and speak JSON over stdio. Works on any platform with Java |
| Zero external runtime dependencies | The only runtime dependency is the signal-cli binary (system-installed). No npm packages beyond `@koi/core` and L0u utilities. Minimal attack surface |
| Bun.spawn with `_spawn` injection | Tests run without a real signal-cli binary or Java runtime. No global mocks — just pass a `SpawnFn` that returns controllable streams |
| E.164 phone normalization | Signal uses phone numbers as identities. Normalizing to E.164 prevents duplicate threads from formatting differences (`+1 202 555 1234` vs `12025551234`). Applied to all inbound sources |
| Text-only outbound (no attachments) | Signal supports attachments, but the initial implementation renders images/files as text fallbacks (`[Image: alt]`, `[File: name]`). Sufficient for LLM-generated responses. Attachment sending planned for v2 |
| 4000-char text limit | Signal's actual limit varies by client. 4000 chars is a conservative safe maximum. Text is split via `splitText` from channel-base, preserving newline boundaries |
| `group.*` prefix detection for routing | signal-cli uses `group.` prefix for group identifiers. Simple string check avoids parsing overhead and works reliably for DM vs group routing |
| 500ms debounce window | Signal delivers messages individually (no batching). Users often send multiple short messages in quick succession. Debouncing via `createDebouncer` from channel-base merges these into one agent turn |
| Graceful shutdown: SIGTERM -> 5s -> SIGKILL | signal-cli needs time to flush pending messages and close the Signal session cleanly. 5-second grace period prevents data loss. SIGKILL is the last resort for hung processes |
| Receipts and typing events filtered | Delivery receipts and typing indicators are noise for the agent. The normalizer returns `null` for these, preventing unnecessary LLM invocations |
| Line-by-line stdout parsing | signal-cli emits one JSON object per line in JSON-RPC mode. Simple `\n`-split parsing with a buffer for partial reads. No streaming JSON parser dependency needed |
| Per-event-type normalizer | Single `createNormalizer()` function with a discriminated union switch on `SignalEvent.kind`. Clean, focused, pure function (~25 LOC) |

---

## Layer Compliance

```
L0  @koi/core ------------------------------------------------+
    ChannelAdapter, ContentBlock, InboundMessage,               |
    OutboundMessage, ChannelCapabilities, KoiError, Result      |
                                                                |
L0u @koi/channel-base ----------------------+                  |
    createChannelAdapter<SignalEvent>        |                  |
    createDebouncer, splitText, text         |                  |
                                             |                  |
L0u @koi/errors --------------------+       |                  |
    RETRYABLE_DEFAULTS              |       |                  |
                                     |       |                  |
L0u @koi/resolve ----------+        |       |                  |
    BrickDescriptor         |        |       |                  |
                             v        v       v                  v
L2  @koi/channel-signal <---+--------+-------+------------------+
    imports from L0 + L0u only
    x never imports @koi/engine (L1)
    x never imports peer L2 packages
    + signal-cli types stay internal (never leak to public API)
    + All interface properties readonly
    + No vendor types in public API surface
    + Zero external runtime dependencies
```
