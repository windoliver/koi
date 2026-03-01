# @koi/acp-protocol — Shared ACP Protocol Primitives

Provides shared ACP (Agent Client Protocol) primitives used by both `@koi/acp` (server) and `@koi/engine-acp` (client). Includes Zod schemas, JSON-RPC parsing, async queues, transport interface, and bidirectional content/event mappers.

---

## Why It Exists

Both the ACP server (`@koi/acp`) and ACP client (`@koi/engine-acp`) need the same protocol plumbing: ACP schema validation, JSON-RPC message parsing, async queues, and content mapping. Without this package, both sides duplicate 1000+ lines of identical protocol code.

`@koi/acp-protocol` extracts the shared primitives into an L0u package that both L2 packages depend on.

---

## What This Enables

```
WITHOUT acp-protocol: duplicated protocol code in both directions
═══════════════════════════════════════════════════════════════════

  @koi/engine-acp (client)              @koi/acp (server)
  ┌─────────────────────────┐           ┌─────────────────────────┐
  │ ACP schemas (725 LOC)   │           │ ACP schemas (725 LOC)   │
  │ JSON-RPC parser (208)   │           │ JSON-RPC parser (208)   │
  │ Async queue (105)       │           │ Async queue (105)       │
  │ Event mapper            │           │ Event mapper (reverse)  │
  │ Content mapper          │           │ Content mapper (reverse)│
  │─────────────────────────│           │─────────────────────────│
  │ Adapter logic           │           │ Channel logic           │
  └─────────────────────────┘           └─────────────────────────┘
       ▲ duplicated                          ▲ duplicated


WITH acp-protocol: single source of truth
══════════════════════════════════════════

              @koi/acp-protocol (L0u)
          ┌────────────────────────────────┐
          │  ACP schemas      (725 LOC)    │
          │  JSON-RPC parser  (208 LOC)    │
          │  Async queue      (105 LOC)    │
          │  Content mappers  (bidirectional)│
          │  Event mappers    (bidirectional)│
          │  Transport interface            │
          └───────────┬────────────────────┘
               ┌──────┴──────┐
               ▼             ▼
      ┌──────────────┐  ┌──────────────┐
      │@koi/engine-acp│  │  @koi/acp   │
      │  (client)    │  │  (server)    │
      │  ~600 LOC    │  │  ~800 LOC   │
      └──────────────┘  └──────────────┘
```

---

## Architecture

**Layer**: L0u (utility package)
**Depends on**: `@koi/core` (L0), `zod`
**Depended on by**: `@koi/engine-acp` (L2), `@koi/acp` (L2)

### Module Map

```
@koi/acp-protocol/src/
├── acp-schema.ts        # Zod schemas for all ACP types (725 LOC)
├── json-rpc-parser.ts   # Line parser, message discriminator, serializers
├── async-queue.ts       # Push-to-pull bridge (AsyncIterable from push)
├── transport.ts         # AcpTransport interface (send/receive/close)
├── content-map.ts       # Bidirectional Koi ContentBlock <-> ACP ContentBlock
├── event-map.ts         # Bidirectional EngineEvent <-> ACP SessionUpdate
└── index.ts             # Public exports
```

---

## Key APIs

### Transport Interface

```typescript
interface AcpTransport {
  readonly send: (messageJson: string) => void;
  readonly receive: () => AsyncIterable<RpcMessage>;
  readonly close: () => void;
}
```

### Content Mapping (Bidirectional)

```
Koi ContentBlock          Direction          ACP ContentBlock
─────────────────         ─────────          ────────────────
TextBlock            ──── ↔ ────────         TextContent
FileBlock            ──── ↔ ────────         ResourceLinkContent
ImageBlock           ──── → ────────         text placeholder (lossy)
ImageContent         ◀─── ← ────────         data: URI → ImageBlock
ButtonBlock          ──── → ────────         (skipped, no ACP equiv)
EmbeddedResource     ◀─── ← ────────         CustomBlock wrapper
```

### Event Mapping (Koi → ACP)

```
EngineEvent                     ACP session/update
───────────────                 ──────────────────
text_delta           ────────▶  agent_message_chunk
tool_call_start      ────────▶  tool_call (pending)
tool_call_delta      ────────▶  tool_call_update (in_progress)
tool_call_end        ────────▶  tool_call_update (completed)
custom (acp:*)       ────────▶  mapped to update kind
turn_start/end       ────────▶  (no ACP equivalent, skipped)
done                 ────────▶  (handled at protocol level)
```

### JSON-RPC Utilities

| Function | Purpose |
|----------|---------|
| `createLineParser()` | Newline-delimited JSON-RPC stream parser |
| `buildRequest(method, params)` | Build outbound JSON-RPC request with auto-incrementing ID |
| `buildResponse(id, result)` | Build success response |
| `buildErrorResponse(id, code, message)` | Build error response |
| `buildNotification(method, params)` | Build notification (no ID) |
| `createAsyncQueue(label)` | Push-to-pull async iterable bridge |

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Package layer | L0u (not L2) | Both client and server L2 packages need it |
| Schema library | Zod | Already used by engine-acp, validates ACP wire format |
| Content mapping | Lossy for images | ACP uses base64, Koi uses URLs — no lossless roundtrip |
| Event mapping | 1:1 (no coalescing) | Simplicity; IDE handles rendering cadence |
| Async queue | High-watermark warning at 500 | Detect backpressure issues in development |

---

## Layer Compliance

- [x] Imports only from `@koi/core` and `zod`
- [x] No L1 (`@koi/engine`) imports
- [x] No peer L2 imports
- [x] All interface properties are `readonly`
- [x] No vendor-specific types
