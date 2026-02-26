# @koi/agui — AG-UI Channel Adapter

Bridges Koi agents to CopilotKit-compatible web frontends via the [AG-UI open protocol](https://docs.ag-ui.com/) (HTTP POST + Server-Sent Events). A single POST from the browser triggers an agent run; the response is a live SSE stream of token deltas, tool calls, reasoning traces, and lifecycle events — everything a React frontend needs to render an agent in real time.

---

## Why It Exists

CopilotKit and AG-UI define a standard wire format for agentic UIs: the frontend POSTs a `RunAgentInput` and receives an SSE stream of typed events. Without `@koi/agui`, connecting a Koi agent to that frontend means hand-writing SSE plumbing, event encoding, backpressure management, and run lifecycle bookkeeping.

This package eliminates that glue. Drop in a channel + middleware pair and your Koi agent speaks AG-UI natively.

---

## Architecture

`@koi/agui` is an **L2 feature package** — it depends only on L0 (`@koi/core`) and L0-utility packages (`@koi/channel-base`, `@koi/errors`), plus the AG-UI SDK for protocol types and encoding.

```
┌─────────────────────────────────────────────────────┐
│  @koi/agui  (L2)                                    │
│                                                     │
│  agui-channel.ts    ← HTTP + SSE lifecycle          │
│  agui-middleware.ts ← real-time stream interception  │
│  event-map.ts       ← ContentBlock → AG-UI events   │
│  normalize.ts       ← RunAgentInput → InboundMessage │
│  run-context-store.ts ← per-run writer registry     │
│  index.ts           ← public API surface            │
│                                                     │
├─────────────────────────────────────────────────────┤
│  Dependencies                                       │
│                                                     │
│  @koi/core          (L0)   contracts + types        │
│  @koi/channel-base  (L0u)  createChannelAdapter()   │
│  @koi/errors        (L0u)  error types              │
│  @ag-ui/core        (ext)  EventType, schemas       │
│  @ag-ui/encoder     (ext)  SSE frame encoding       │
└─────────────────────────────────────────────────────┘
```

---

## AG-UI Protocol vs Plain SSE

| Concern | Plain SSE | AG-UI Protocol |
|---------|-----------|----------------|
| Event schema | Ad-hoc JSON blobs | Typed `BaseEvent` with `EventType` discriminator |
| Run lifecycle | Roll your own start/finish | `RUN_STARTED` → `RUN_FINISHED` / `RUN_ERROR` |
| Text streaming | Raw text chunks | `TEXT_MESSAGE_START` → `_CONTENT` → `_END` |
| Tool visibility | Not standardized | `TOOL_CALL_START` → `_ARGS` → `_END` → `_RESULT` |
| Reasoning traces | Not standardized | `REASONING_MESSAGE_START` → `_CONTENT` → `_END` |
| State sync | Custom | `STATE_SNAPSHOT` + `STATE_DELTA` |
| Frontend SDK | Build from scratch | CopilotKit renders events automatically |

---

## SSE Event Timeline

A typical agent run produces this SSE event sequence:

```
Browser                         @koi/agui                          Koi Engine
  │                                │                                    │
  │  POST /agent                   │                                    │
  │  { threadId, runId, messages } │                                    │
  │ ──────────────────────────────>│                                    │
  │                                │                                    │
  │  SSE: RUN_STARTED              │                                    │
  │ <──────────────────────────────│                                    │
  │  SSE: STATE_SNAPSHOT({})       │                                    │
  │ <──────────────────────────────│                                    │
  │                                │  dispatch(InboundMessage)          │
  │                                │ ──────────────────────────────────>│
  │                                │                                    │
  │                                │        middleware intercepts       │
  │                                │        model stream chunks         │
  │                                │                                    │
  │  SSE: STEP_STARTED             │<── wrapModelStream begins ────────│
  │ <──────────────────────────────│                                    │
  │  SSE: TEXT_MESSAGE_START       │                                    │
  │ <──────────────────────────────│                                    │
  │  SSE: TEXT_MESSAGE_CONTENT     │<── text_delta chunk ──────────────│
  │ <──────────────────────────────│                                    │
  │  SSE: TEXT_MESSAGE_CONTENT     │<── text_delta chunk ──────────────│
  │ <──────────────────────────────│                                    │
  │  SSE: TEXT_MESSAGE_END         │                                    │
  │ <──────────────────────────────│                                    │
  │  SSE: STEP_FINISHED            │<── done chunk ────────────────────│
  │ <──────────────────────────────│                                    │
  │                                │                                    │
  │  SSE: RUN_FINISHED             │<── engine completes ──────────────│
  │ <──────────────────────────────│                                    │
  │          stream closed         │                                    │
```

---

## Tool Call Event Flow

When the model invokes a tool during streaming:

```
Browser                         @koi/agui                          Koi Engine
  │                                │                                    │
  │  ... text streaming ...        │                                    │
  │                                │                                    │
  │  SSE: TEXT_MESSAGE_END         │<── tool_call_start chunk ─────────│
  │ <──────────────────────────────│    (closes open text message)      │
  │  SSE: TOOL_CALL_START          │                                    │
  │ <──────────────────────────────│                                    │
  │  SSE: TOOL_CALL_ARGS           │<── tool_call_delta chunks ────────│
  │ <──────────────────────────────│    (JSON argument fragments)       │
  │  SSE: TOOL_CALL_END            │<── tool_call_end chunk ───────────│
  │ <──────────────────────────────│                                    │
  │                                │        wrapToolCall executes       │
  │  SSE: TOOL_CALL_RESULT         │<── tool returns result ───────────│
  │ <──────────────────────────────│                                    │
  │                                │                                    │
  │  ... next text or tool ...     │                                    │
```

---

## Extended Thinking (Reasoning Traces)

When the model emits thinking/reasoning tokens:

```
  SSE: REASONING_MESSAGE_START
  SSE: REASONING_MESSAGE_CONTENT  ← thinking_delta chunk
  SSE: REASONING_MESSAGE_CONTENT  ← thinking_delta chunk
  SSE: REASONING_MESSAGE_END
```

Reasoning events are interleaved with text and tool events — the middleware tracks open message IDs independently for each stream type.

---

## Two Integration Modes

### Standalone — owns its own Bun HTTP server

```
┌──────────────┐      POST /agent       ┌─────────────────────┐
│              │ ─────────────────────> │                     │
│   Browser    │                        │   createAguiChannel │
│  (CopilotKit)│ <───────────────────── │   Bun.serve(:3000)  │
│              │      SSE stream        │                     │
└──────────────┘                        └────────┬────────────┘
                                                 │
                                                 │ channel + middleware
                                                 ▼
                                        ┌─────────────────────┐
                                        │     Koi Agent       │
                                        │   (engine loop)     │
                                        └─────────────────────┘
```

```typescript
import { createAguiChannel } from "@koi/agui";

const { channel, middleware } = createAguiChannel({ port: 3000 });

// Wire into your Koi agent assembly:
// channels: [channel], middleware: [middleware]
```

### Embedded — plugs into an existing Bun.serve

```
┌──────────────┐      POST /api/agent   ┌─────────────────────┐
│              │ ─────────────────────> │                     │
│   Browser    │                        │  Your Bun.serve()   │
│  (CopilotKit)│ <───────────────────── │                     │
│              │      SSE stream        │  ┌───────────────┐  │
└──────────────┘                        │  │ aguiHandler()  │  │
                                        │  └───────┬───────┘  │
                                        │          │          │
┌──────────────┐      GET /app          │  ┌───────┴───────┐  │
│   Browser    │ ─────────────────────> │  │ appHandler()   │  │
│   (app UI)   │ <───────────────────── │  └───────────────┘  │
└──────────────┘      HTML/JS           └─────────────────────┘
```

```typescript
import { createAguiHandler } from "@koi/agui";

const { handler, middleware, onMessage } = createAguiHandler({
  path: "/api/agent",
});

// Register the Koi engine dispatch:
onMessage(async (msg) => {
  await engine.dispatch(msg);
});

// Wire into your server:
Bun.serve({
  fetch: async (req) =>
    (await handler(req)) ?? new Response("Not Found", { status: 404 }),
});
```

---

## ContentBlock → AG-UI Event Mapping

When the channel's `send()` emits an `OutboundMessage`, its `ContentBlock[]` array is converted to AG-UI events:

| ContentBlock kind | AG-UI Event(s) | Payload |
|-------------------|----------------|---------|
| `text` | `TEXT_MESSAGE_START` → `_CONTENT` → `_END` | `{ delta: block.text }` |
| `image` | `CUSTOM` name=`koi:image` | `{ url, alt }` |
| `file` | `CUSTOM` name=`koi:file` | `{ url, mimeType, name }` |
| `button` | `CUSTOM` name=`koi:button` | `{ label, action, payload }` |
| `custom` | `CUSTOM` name=`block.type` | `block.data` |
| `custom` (type=`"koi:state"`) | `CUSTOM` + `STATE_DELTA` | CopilotKit shared state delta |

Non-text blocks are emitted as `CUSTOM` events so CopilotKit frontends can render them with custom React components. The switch is exhaustive — new `ContentBlock` variants produce compile errors until mapped.

**Special case:** Custom blocks with `type: "koi:state"` are treated as CopilotKit shared state updates. In addition to the standard `CUSTOM` event from `mapBlocksToAguiEvents`, the channel's `send()` emits a `STATE_DELTA` event so the frontend's state stays in sync.

**Note:** If the companion middleware has already streamed text via `wrapModelStream`, the channel's `send()` skips re-emitting text events (checked via `hasTextStreamed`). This prevents duplicate text in the SSE stream.

---

## RunContextStore

The `RunContextStore` is the shared state between the channel and middleware. It maps each `runId` to an SSE writer so both can write to the same response stream.

```
                    ┌────────────────────────────┐
                    │     RunContextStore         │
                    │                             │
                    │  Map<runId, RunEntry>        │
                    │  ┌────────────────────────┐ │
  channel           │  │ "run-abc"              │ │      middleware
  register() ──────>│  │   writer: SseWriter    │ │<───── get()
  deregister() ────>│  │   textStreamed: bool    │ │<───── markTextStreamed()
  get() ───────────>│  └────────────────────────┘ │<───── hasTextStreamed()
                    │  ┌────────────────────────┐ │
                    │  │ "run-xyz"              │ │
                    │  │   writer: SseWriter    │ │
                    │  │   textStreamed: bool    │ │
                    │  └────────────────────────┘ │
                    │                             │
                    └────────────────────────────┘

  Lifecycle:
    POST arrives  →  register(runId, writer, signal)
    stream chunks →  get(runId) returns writer
    middleware    →  markTextStreamed(runId)
    channel send  →  hasTextStreamed(runId) ? skip text : emit text
    run ends      →  deregister(runId) + writer.close()
    client drops  →  AbortSignal fires → auto deregister(runId)
```

Duplicate `runId` registration throws — two concurrent requests with the same `runId` are a protocol error. The `size` property exposes the number of active runs for observability.

---

## Normalization Modes

`RunAgentInput` from the AG-UI frontend is normalized into a Koi `InboundMessage` before dispatch. Two modes control how conversation history is handled:

| Mode | Behavior | Use when |
|------|----------|----------|
| `"stateful"` (default) | Only the **last user message** becomes the `InboundMessage` content | Koi engine has memory middleware maintaining conversation history |
| `"stateless"` | All messages flattened into labeled `TextBlock`s (`[user]: ...`, `[assistant]: ...`) | No memory middleware — engine needs full history per request |

In both modes:
- `threadId` → `InboundMessage.threadId`
- `runId` → `metadata.runId` (used for SSE routing)
- `state` → `metadata.aguiState` (CopilotKit shared state)

---

## API Reference

### Factory Functions

#### `createAguiChannel(config?)`

Creates a standalone AG-UI channel with its own Bun HTTP server.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `config.port` | `number` | `3000` | TCP port to listen on |
| `config.path` | `string` | `"/agent"` | URL path for AG-UI POST requests |
| `config.mode` | `NormalizationMode` | `"stateful"` | History normalization mode |
| `config.onHandlerError` | `(err, msg) => void` | `console.error` | Error callback |

**Returns:** `AguiChannelResult`
- `channel: ChannelAdapter` — register in your Koi agent
- `middleware: KoiMiddleware` — include in your middleware stack
- `store: RunContextStore` — shared state (exposed for testing)

#### `createAguiHandler(config?)`

Creates an embedded AG-UI handler for use inside an existing `Bun.serve`.

Accepts the same `AguiChannelConfig` as `createAguiChannel`. `port` is ignored (no server created). `onHandlerError` is also unused — in embedded mode, handler errors propagate as rejections from the dispatch function.

**Returns:** `AguiHandlerResult`
- `handler: (req: Request) => Promise<Response | null>` — returns `null` for non-matching paths
- `middleware: KoiMiddleware` — include in your middleware stack
- `store: RunContextStore` — shared state (exposed for testing)
- `onMessage: (handler: MessageHandler) => () => void` — register engine dispatch

#### `createAguiStreamMiddleware(config)`

Creates the companion middleware that intercepts model streams and tool calls to emit AG-UI SSE events in real time.

| Parameter | Type | Description |
|-----------|------|-------------|
| `config.store` | `RunContextStore` | The store from `createAguiChannel()` or `createAguiHandler()` |

**Returns:** `KoiMiddleware` with `wrapModelStream` and `wrapToolCall` hooks.

**Priority:** `200` — runs after outer governance/pay middleware, before context hydration.

#### `createRunContextStore()`

Creates a per-run SSE writer registry. Normally you don't need to call this directly — `createAguiChannel()` and `createAguiHandler()` create one internally.

### Utility Functions

#### `handleAguiRequest(req, store, mode, dispatch)`

Core request handler used by both standalone and embedded modes. Exported for custom integration scenarios.

#### `mapBlocksToAguiEvents(blocks, messageId)`

Converts a `ContentBlock[]` array into an ordered sequence of AG-UI `BaseEvent`s.

#### `normalizeRunAgentInput(input, mode)`

Normalizes a `RunAgentInput` into a Koi `InboundMessage`. Returns `null` if there are no processable messages.

#### `extractMessageText(content)`

Extracts plain text from an AG-UI message content field (handles both `string` and content-block array formats).

#### `captureAguiEvents(handler, input, path?)`

Test helper — sends a `RunAgentInput` to the handler and collects all emitted AG-UI events. Reads the SSE stream until `RUN_FINISHED` or `RUN_ERROR`.

### Types

| Type | Description |
|------|-------------|
| `AguiChannelConfig` | Configuration for both standalone and embedded modes |
| `AguiChannelResult` | Return type of `createAguiChannel()` |
| `AguiHandlerResult` | Return type of `createAguiHandler()` |
| `AguiStreamMiddlewareConfig` | Configuration for `createAguiStreamMiddleware()` |
| `NormalizationMode` | `"stateful" \| "stateless"` |
| `RunContextStore` | Per-run SSE writer registry interface |
| `SseWriter` | `WritableStreamDefaultWriter<Uint8Array>` alias |

---

## Examples

### Minimal Standalone Server

```typescript
import { createAguiChannel } from "@koi/agui";

const { channel, middleware } = createAguiChannel({
  port: 3000,
  path: "/agent",
  mode: "stateful",
});

// Register both in your Koi agent assembly:
const agent = await createKoi({
  manifest,
  channels: [channel],
  middleware: [middleware],
});
```

### Embedded in Existing Server

```typescript
import { createAguiHandler } from "@koi/agui";

const { handler, middleware, onMessage } = createAguiHandler({
  path: "/api/agent",
  mode: "stateless", // no memory middleware in stack
});

onMessage(async (msg) => {
  await engine.dispatch(msg);
});

Bun.serve({
  port: 8080,
  fetch: async (req) => {
    // AG-UI requests handled here
    const aguiResponse = await handler(req);
    if (aguiResponse !== null) return aguiResponse;

    // Other routes
    return new Response("Not Found", { status: 404 });
  },
});
```

### With Additional Middleware

```typescript
import { createAguiChannel } from "@koi/agui";
import { createAuditMiddleware } from "@koi/audit";
import { createPayMiddleware } from "@koi/pay";

const { channel, middleware: aguiMiddleware } = createAguiChannel({
  port: 3000,
});

const agent = await createKoi({
  manifest,
  channels: [channel],
  middleware: [
    createPayMiddleware({ ... }),      // priority: 100
    aguiMiddleware,                    // priority: 200
    createAuditMiddleware({ ... }),    // priority: 300
  ],
});
```

---

## Layer Compliance

```
L0  @koi/core ─────────────────────────────────────────────┐
    types + contracts only, zero deps                       │
                                                            │
L0u @koi/channel-base ─────────────────────────┐           │
    createChannelAdapter() factory              │           │
                                                │           │
L0u @koi/errors ──────────────────────┐        │           │
    error types                       │        │           │
                                      ▼        ▼           ▼
L2  @koi/agui ◄───────────────────────┴────────┴───────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✓ @ag-ui/core and @ag-ui/encoder are external protocol deps
```

**Dev-only dependencies** (`@koi/engine`, `@koi/engine-pi`, `@koi/test-utils`) are used in tests but are not runtime imports — the package remains a clean L2 citizen.
