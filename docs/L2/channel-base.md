# @koi/channel-base — Channel Adapter Factory

Provides `createChannelAdapter<E>()`, a generic factory that builds complete `ChannelAdapter` implementations from platform-specific callbacks. Handles all shared channel behavior so concrete channels (CLI, Telegram, Slack, voice) only implement platform-specific mechanics.

---

## Why It Exists

Every channel needs the same plumbing: idempotent connect/disconnect, handler registration, parallel dispatch with error isolation, capability-aware rendering, and optional status delivery. Without this package, every channel reimplements 250+ lines of identical logic.

`@koi/channel-base` extracts that shared skeleton. A new channel adapter is ~100 lines of platform-specific code instead of ~400+.

---

## What This Enables

### Before vs After

```
WITHOUT channel-base: every channel reimplements shared plumbing
═══════════════════════════════════════════════════════════════

  @koi/channel-cli          @koi/channel-telegram      @koi/channel-slack
  ┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
  │ connect/disconnect│      │ connect/disconnect│      │ connect/disconnect│
  │ handler registry  │      │ handler registry  │      │ handler registry  │
  │ error isolation   │      │ error isolation   │      │ error isolation   │
  │ capability render │      │ capability render │      │ capability render │
  │ queue buffering   │      │ queue buffering   │      │ queue buffering   │
  │─────────────────  │      │─────────────────  │      │─────────────────  │
  │ readline I/O      │      │ grammY bot API    │      │ Bolt SDK          │
  └──────────────────┘      └──────────────────┘      └──────────────────┘
       ▲ duplicated              ▲ duplicated              ▲ duplicated


WITH channel-base: shared skeleton, platform-only implementations
═════════════════════════════════════════════════════════════════

                    @koi/channel-base
                ┌─────────────────────────┐
                │  createChannelAdapter()  │
                │  ● connect/disconnect    │
                │  ● handler registry      │
                │  ● error isolation       │
                │  ● capability rendering  │
                │  ● queue buffering       │
                └────────┬────────────────┘
           ┌─────────────┼─────────────┐
           ▼             ▼             ▼
  ┌─────────────┐ ┌────────────┐ ┌────────────┐
  │  CLI ~80 LOC│ │ Telegram   │ │ Slack      │
  │  readline   │ │ ~120 LOC   │ │ ~100 LOC   │
  │  stdin/out  │ │ grammY     │ │ Bolt SDK   │
  └─────────────┘ └────────────┘ └────────────┘
    platform-only   platform-only  platform-only
```

### Multi-Channel Agent — Same Message, Different Rendering

```
Agent sends a rich message with mixed content:
╔══════════════════════════════════════════════════════╗
║  OutboundMessage.content = [                         ║
║    TextBlock("Here's the report"),                   ║
║    ImageBlock(url: "chart.png", alt: "Q4 chart"),    ║
║    FileBlock(url: "report.pdf", name: "Q4.pdf"),     ║
║    ButtonBlock(label: "Approve", action: "approve"), ║
║  ]                                                   ║
╚══════════════════════════════════════════════════════╝
                         │
                    renderBlocks()
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
   Telegram Channel   CLI Channel    Voice Channel
   caps: ALL TRUE     caps: text     caps: text
   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
   │ "Here's the  │   │ "Here's the  │   │ "Here's the  │
   │  report"     │   │  report"     │   │  report"     │
   │  (photo)     │   │ [Image: Q4   │   │ [Image: Q4   │
   │  (document)  │   │  chart]      │   │  chart]      │
   │ [Approve]    │   │ [File: Q4.   │   │ [File: Q4.   │
   │  (button)    │   │  pdf]        │   │  pdf]        │
   └──────────────┘   │ [Approve]    │   │ [Approve]    │
    rich rendering    └──────────────┘   └──────────────┘
                       text fallback      text fallback

     Same OutboundMessage → different rendering per capability
     All powered by channel-base's renderBlocks()
```

---

## Architecture

`@koi/channel-base` is an **L0-utility (L0u) package** — it imports from `@koi/core` (L0) and `@koi/errors` (L0u) only. Zero external dependencies.

```
┌─────────────────────────────────────────────────────┐
│  @koi/channel-base  (L0u)                           │
│                                                     │
│  channel-adapter-factory.ts ← createChannelAdapter  │
│  content-block-builders.ts  ← text, image, file...  │
│  render-blocks.ts           ← capability downgrade   │
│  format-error.ts            ← user-facing errors     │
│  index.ts                   ← public API surface     │
│                                                     │
├─────────────────────────────────────────────────────┤
│  Dependencies                                       │
│                                                     │
│  @koi/core    (L0)   ChannelAdapter, ContentBlock,  │
│                       InboundMessage, OutboundMessage│
│  @koi/errors  (L0u)  swallowError()                │
└─────────────────────────────────────────────────────┘
```

### Layer Position

```
L0  @koi/core ──────────────────────────────────────────┐
    ChannelAdapter, ChannelCapabilities (types only)      │
                                                          │
L0u @koi/errors ──────────────────────┐                  │
    swallowError()                    │                  │
                                      ▼                  ▼
L0u @koi/channel-base ◄──────────────┴──────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✓ zero external dependencies
                │
    ┌───────────┼───────────────┐──────────────┐
    ▼           ▼               ▼              ▼
L2 channel-cli  channel-tg  channel-voice   agui
   (uses base)  (uses base) (uses base)  (uses base)
```

---

## How createChannelAdapter Works

### You Provide vs You Get Free

```
╔═══════════════════════════════════════════════════════════════╗
║  createChannelAdapter<E>(config)                             ║
║                                                              ║
║  YOU PROVIDE (platform-specific):    YOU GET FREE (generic): ║
║  ────────────────────────────────    ────────────────────── ║
║  ● name: "telegram"                 ● Idempotent connect()  ║
║  ● capabilities: { text, images..}  ● Idempotent disconnect ║
║  ● platformConnect()                ● Handler registry       ║
║  ● platformDisconnect()             ● Parallel dispatch      ║
║  ● platformSend(rendered msg)       ● Error isolation        ║
║  ● onPlatformEvent(handler)         ● Block rendering        ║
║  ● normalize(raw → InboundMessage)  ● Capability downgrade   ║
║  ○ platformSendStatus? (optional)   ● Queue-on-disconnect    ║
║  ○ onHandlerError? (optional)       ● Observability hooks    ║
║  ○ onIgnoredEvent? (optional)       ● Full ChannelAdapter    ║
║  ○ queueWhenDisconnected? (opt)     │  contract compliance   ║
║                                     │                        ║
║  ~80–150 lines of code              │  ~270 lines you DON'T  ║
║                                     │  have to write         ║
╚═══════════════════════════════════════════════════════════════╝
```

### Connection Lifecycle

```
            ┌───────────────────────┐
            │    DISCONNECTED       │◀──────────────────┐
            │  (initial state)      │                    │
            └───────────┬───────────┘                    │
                        │ connect()                      │
                        ▼                                │
            ┌───────────────────────┐           disconnect()
            │    CONNECTED          │                    │
            │  ● handlers active    │────────────────────┘
            │  ● send() works       │
            └───────────────────────┘

            connect() again? → idempotent, no-op
            disconnect() again? → safe, no-op
```

### Handler Dispatch & Error Isolation

```
Platform Event (e.g., user types "hello")
          │
          ▼
    normalize(event)
          │
     ┌────┴────┐
     │ null?   │──yes──▶ onIgnoredEvent()
     └────┬────┘         (typing indicator, read receipt — silently dropped)
          │ no
          ▼
    InboundMessage
          │
    ┌─────┼───────────┐─────────────┐
    ▼     ▼           ▼             ▼
  handler₁  handler₂  handler₃  handler₄     ◀── Promise.allSettled()
    ✓        ✗ throws    ✓        ✓           (parallel, isolated)
    │        │           │        │
    │   onHandlerError() │        │           ◀── failure logged, NOT propagated
    │        │           │        │
    └────────┴───────────┴────────┘
              │
         All settled — other handlers unaffected
         by handler₂'s failure
```

### Queue-on-Disconnect

```
  CONNECTED              DISCONNECTED            RECONNECTED
  ┌──────────┐          ┌──────────────┐        ┌──────────────┐
  │ send(m1) │──direct──▶ platform     │        │              │
  │ send(m2) │──direct──▶ platform     │        │              │
  └──────────┘          └──────────────┘        │              │
       ║                                        │              │
    network                                     │              │
     drops                                      │              │
       ║                                        │              │
  ┌──────────┐          ┌──────────────┐        │              │
  │ send(m3) │──queue──▶│ [m3]         │        │              │
  │ send(m4) │──queue──▶│ [m3, m4]     │        │              │
  │ send(m5) │──queue──▶│ [m3, m4, m5] │        │              │
  └──────────┘          └──────────────┘        │              │
       ║                                        │              │
    reconnect                                   │              │
       ║                                        │              │
  ┌──────────┐                                  │ drain queue  │
  │connect() │─────────────────────────────────▶│ m3 → platform│
  │          │                                  │ m4 → platform│
  │          │                                  │ m5 → platform│
  └──────────┘                                  └──────────────┘

  Drain errors are logged but don't fail connect() — the platform
  connected successfully; messages just failed to send.
```

---

## Capability-Aware Rendering

`renderBlocks(blocks, capabilities)` downgrades blocks the channel cannot render:

```
Block Type      Channel Supports?    Result
──────────      ─────────────────    ──────
ImageBlock      capabilities.images  ✓ pass through / ✗ → TextBlock "[Image: alt]"
FileBlock       capabilities.files   ✓ pass through / ✗ → TextBlock "[File: name]"
ButtonBlock     capabilities.buttons ✓ pass through / ✗ → TextBlock "[label]"
TextBlock       (always)             always pass through
CustomBlock     (no flag)            always pass through
```

**Fast path:** when `images && files && buttons` are all `true`, returns the original array reference unchanged — zero allocation.

Automatically called by `send()` before `platformSend()`, so implementers never see unsupported blocks.

---

## ContentBlock Builders

Typed factory functions for building message content:

```typescript
import { text, image, file, button, custom } from "@koi/channel-base";

text("Hello")                          // → { kind: "text", text: "Hello" }
image("pic.png", "A photo")            // → { kind: "image", url: "pic.png", alt: "A photo" }
file("doc.pdf", "application/pdf")     // → { kind: "file", url: "doc.pdf", mimeType: "..." }
button("Approve", "approve")           // → { kind: "button", label: "Approve", action: "approve" }
custom("koi:state", { dark: true })    // → { kind: "custom", type: "koi:state", data: {...} }
```

All builders handle `exactOptionalPropertyTypes` compliance — optional fields are omitted (not set to `undefined`).

---

## Error Formatting

`formatErrorForChannel(error, options?)` converts `KoiError` to safe, user-friendly strings:

```
KoiErrorCode     Default Message                              Verbose
────────────     ───────────                                  ───────
VALIDATION       "Invalid input: {message}"                   same
NOT_FOUND        "The requested resource was not found."      + "(message)"
PERMISSION       "You don't have permission..."               + "(message)"
CONFLICT         "A conflict occurred..."                     + "(message)"
RATE_LIMIT       "Too many requests..."                       + "(retry after Xms)"
TIMEOUT          "The operation timed out..."                 + "(message)"
EXTERNAL         "An external service is unavailable..."      + "(message)"
INTERNAL         "Something went wrong..."                    + "(message)"
STALE_REF        "The referenced element is no longer valid." + "(message)"
```

Never leaks `error.cause`, `error.context`, or stack traces. Verbose mode is for developer-facing channels (CLI).

---

## API Reference

### Factory Functions

| Function | Returns | Purpose |
|----------|---------|---------|
| `createChannelAdapter<E>(config)` | `ChannelAdapter` | Build a complete adapter from platform callbacks |

### ContentBlock Builders

| Function | Returns | Purpose |
|----------|---------|---------|
| `text(content)` | `TextBlock` | Plain text content |
| `image(url, alt?)` | `ImageBlock` | Image with optional alt text |
| `file(url, mimeType, name?)` | `FileBlock` | File attachment |
| `button(label, action, payload?)` | `ButtonBlock` | Interactive button |
| `custom(type, data)` | `CustomBlock` | Extensible custom block |

### Rendering & Formatting

| Function | Returns | Purpose |
|----------|---------|---------|
| `renderBlocks(blocks, capabilities)` | `readonly ContentBlock[]` | Downgrade unsupported blocks to text |
| `formatErrorForChannel(error, options?)` | `string` | Safe user-facing error message |

### Types

| Type | Description |
|------|-------------|
| `ChannelAdapterConfig<E>` | Configuration for `createChannelAdapter()` |
| `MessageNormalizer<E>` | `(event: E) => InboundMessage \| null \| Promise<InboundMessage \| null>` |
| `ContentBlock` | Re-exported union from `@koi/core` |
| `FormatErrorOptions` | `{ verbose?: boolean }` |

---

## Examples

### Minimal CLI Channel

```typescript
import { createChannelAdapter, text } from "@koi/channel-base";
import * as readline from "node:readline";

export function createCliChannel(): ChannelAdapter {
  let rl: readline.Interface | undefined;

  return createChannelAdapter<string>({
    name: "cli",
    capabilities: { text: true, images: false, files: false,
                    buttons: false, audio: false, video: false, threads: false },
    platformConnect: async () => {
      rl = readline.createInterface({ input: process.stdin });
    },
    platformDisconnect: async () => {
      rl?.close();
    },
    platformSend: async (msg) => {
      for (const block of msg.content) {
        if (block.kind === "text") process.stdout.write(block.text + "\n");
      }
    },
    onPlatformEvent: (handler) => {
      const listener = (line: string) => handler(line);
      rl?.on("line", listener);
      return () => rl?.off("line", listener);
    },
    normalize: (line) => ({
      content: [text(line)],
      senderId: "user",
      timestamp: Date.now(),
    }),
  });
}
```

### Channel with Queue-on-Disconnect

```typescript
const adapter = createChannelAdapter({
  // ... platform callbacks ...
  queueWhenDisconnected: true,
});

await adapter.send(msg);    // buffers while disconnected
await adapter.connect();    // flushes queue in order
```

### Channel with Status Support

```typescript
const adapter = createChannelAdapter({
  // ... platform callbacks ...
  platformSendStatus: async (status) => {
    if (status.kind === "processing") {
      await bot.api.sendChatAction(chatId, "typing");
    }
  },
});

// Consumers detect support:
if (adapter.sendStatus !== undefined) {
  await adapter.sendStatus({ kind: "processing" });
}
```

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Parallel dispatch via `Promise.allSettled()` | Handlers are independent; one failure must not block others |
| `renderBlocks()` fast path | Returns same reference when all capabilities match — zero allocation |
| `normalize` returns `null` to ignore | Cleaner than throwing for system events (typing, read receipts) |
| `sendStatus` conditionally omitted | Not all platforms support status; absence enables feature detection |
| Queue on disconnect (opt-in) | Resilience for network hiccups without surprising default behavior |
| `swallowError` for drain failures | Platform connected successfully; failed message sends are logged, not fatal |

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────┐
    ChannelAdapter, ContentBlock, KoiError — types only   │
                                                          │
L0u @koi/errors ──────────────────────┐                  │
    swallowError()                    │                  │
                                      ▼                  ▼
L0u @koi/channel-base ◄──────────────┴──────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✓ zero external dependencies
```

**Dev-only:** `@koi/test-utils` used in tests but not a runtime import.
