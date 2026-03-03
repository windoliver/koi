# @koi/engine-pi — Pi Agent Core Engine Adapter

Wraps `@mariozechner/pi-agent-core` as a Koi `EngineAdapter`. Provides multi-turn LLM reasoning with tool use, steering, and follow-up — all routed through Koi's middleware chain.

---

## Why It Exists

Koi needs a high-level agent loop that handles multi-turn conversations, tool calling, and context management. `pi-agent-core` provides this out of the box — but its message format, event model, and tool interface are different from Koi's contracts.

`@koi/engine-pi` bridges the gap:

1. **Message mapping** — bidirectional conversion between Koi `InboundMessage` and pi `Message` types
2. **Event bridging** — pi agent events → Koi `EngineEvent` stream
3. **Tool bridging** — Koi `ToolDescriptor` → pi `AgentTool`, execution routed through middleware
4. **Model terminal** — model calls flow through Koi's middleware chain before reaching the API

---

## Content Block Handling

### EngineCapabilities

Each engine adapter declares what content types it can natively handle via `EngineCapabilities`:

```typescript
// PI_CAPABILITIES — declared in message-map.ts
{
  text: true,    // text blocks pass through
  images: true,  // image blocks pass through (pi-ai supports ImageContent)
  files: true,   // file blocks mapped to Anthropic document blocks
  audio: false,  // no audio support yet
}
```

### File Block Passthrough

File blocks (PDFs, CSVs, etc.) are mapped to Anthropic's native `document` content blocks and passed through the pi-ai SDK to the model API. The agent sees the real file content — no lossy downgrade to text placeholders.

```
Koi FileBlock                    Anthropic document block
┌──────────────────┐             ┌─────────────────────────────────────┐
│ kind: "file"     │             │ type: "document"                    │
│ url: "data:..."  │  ────────►  │ source:                             │
│ mimeType: "..."  │             │   type: "base64"                    │
│ name: "doc.pdf"  │             │   media_type: "application/pdf"     │
└──────────────────┘             │   data: "JVBERi0xLjQK..."          │
                                 └─────────────────────────────────────┘

Koi FileBlock (URL)              Anthropic document block (URL)
┌──────────────────────────┐     ┌─────────────────────────────────────┐
│ kind: "file"             │     │ type: "document"                    │
│ url: "https://example/…" │ ──► │ source:                             │
│ mimeType: "..."          │     │   type: "url"                       │
└──────────────────────────┘     │   url: "https://example/…"          │
                                 └─────────────────────────────────────┘
```

**Why this works:** The pi-ai SDK's TypeScript types only declare `TextContent | ImageContent`, but the runtime passes content arrays through to the Anthropic API without type validation. Document blocks reach the model and are processed natively. Two `@ts-expect-error` annotations mark the type boundary — they're self-cleaning and will fail when pi-ai adds document support.

### Graceful Downgrade (other engines)

Engines that don't support files (hypothetical text-only engines) use `mapContentBlocksForEngine()` from `@koi/core` to downgrade:

```
FileBlock { name: "report.pdf" }  →  TextBlock { text: "[File: report.pdf]" }
```

The Pi adapter doesn't need this downgrade since `files: true`.

---

## Architecture

```
L2 package — imports from @koi/core (L0) and L0u only.

┌──────────────────────────────────────────────────────┐
│                   @koi/engine-pi                      │
│                                                      │
│  adapter.ts          Factory: createPiAdapter()      │
│  message-map.ts      Bidirectional message conversion│
│  event-bridge.ts     Pi events → Koi EngineEvent     │
│  stream-bridge.ts    Model calls through middleware   │
│  tool-bridge.ts      Koi tools → pi AgentTool        │
│  model-terminal.ts   Terminal handlers for L1         │
│  metrics.ts          Token/cost accumulation          │
└──────────────────────────────────────────────────────┘
         │                           │
         ▼                           ▼
   @koi/core (L0)          @mariozechner/pi-ai
   @koi/core/engine         @mariozechner/pi-agent-core
   @koi/core/message
```

---

## Usage

```yaml
# In a Koi agent manifest
engine:
  name: pi
  options:
    model: "anthropic:claude-sonnet-4-5-20250929"
    systemPrompt: "You are a helpful assistant."
    thinkingLevel: "minimal"   # minimal | medium | high | off
    steeringMode: "all"        # all | none
```

```typescript
import { createPiAdapter } from "@koi/engine-pi";

const adapter = createPiAdapter({
  model: "anthropic:claude-sonnet-4-5-20250929",
  systemPrompt: "You are a helpful assistant.",
});

// adapter.capabilities = { text: true, images: true, files: true, audio: false }
// adapter.engineId = "pi-agent-core"
```

---

## Key Design Decisions

1. **Fresh agent per stream() call** — no mutable shared state between runs. Each `stream()` creates a new `PiAgent` instance.

2. **Cooperating mode required** — the adapter requires `callHandlers` (provided by L1) so all model/tool calls flow through the middleware chain.

3. **File passthrough via type bypass** — pi-ai SDK types are narrower than the runtime. Document blocks are constructed with `PiContentPart` (local type) and pass through `@ts-expect-error` boundaries at the SDK interface. This is intentional and self-cleaning.

4. **No vendor types in public API** — `DocumentSource` and `PiContentPart` are file-local, not exported. The adapter's public surface uses only L0 types (`EngineAdapter`, `EngineCapabilities`, etc.).
