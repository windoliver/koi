# @koi/gateway — WebSocket Gateway Core

Minimal WebSocket gateway for Koi v2. Manages client connections via a single transport: **client sessions** exchanging `GatewayFrame` messages. Handles authentication, protocol negotiation, session sequencing, backpressure, and routing.

**v2 scope** (Issue #1365): single-node, no Nexus/HA, no node registry, no tool routing. Those are future issues.

**Gateway contract (Issue #1639)**: implements the L0u `Gateway` interface from `@koi/gateway-types` so peer L2 packages (notably `@koi/gateway-http`) can drive ingress without depending on this package directly. The contract surface is `ingest(session, frame)` + `pauseIngress()` + `forceClose()` + `activeConnections()`. `pauseIngress()` blocks new ingress AND sends a graceful WS close (1001 SERVER_SHUTTING_DOWN) on every live connection so callers' shutdown drain can actually complete.

> **v1 reference**: The v1 implementation lived in `archive/v1/packages/net/gateway`. The v2 package is intentionally minimal — ~600 LOC vs ~4K LOC in v1. Features not yet ported are listed at the bottom of this doc.

---

## Why It Exists

Agents need a stable connection endpoint that:

- **Authenticates** — validates tokens and creates typed sessions
- **Orders and deduplicates** — sliding-window sequence tracker prevents replay and reordering
- **Manages backpressure** — per-connection and global buffer watermarks prevent OOM
- **Routes frames** — dispatches to registered handlers with routing context

---

## Architecture

`@koi/gateway` is an **L2 feature package** — depends only on L0 (`@koi/core`) and L0u (`@koi/errors`).

```
┌─────────────────────────────────────────────────┐
│  @koi/gateway  (L2)                             │
│                                                 │
│  gateway.ts          ← createGateway() factory  │
│  transport.ts        ← Bun.serve() WebSocket    │
│  auth.ts             ← handshake orchestration  │
│  protocol.ts         ← frame parsing/encoding   │
│  routing.ts          ← dispatch key + matching  │
│  session-store.ts    ← pluggable persistence    │
│  sequence-tracker.ts ← ordering + deduplication │
│  backpressure.ts     ← buffer watermark monitor │
│  close-codes.ts      ← WS close code constants  │
│  types.ts            ← all wire/config types    │
│                                                 │
├─────────────────────────────────────────────────┤
│  Dependencies                                   │
│  @koi/core    (L0)   Result, KoiError, notFound │
│  @koi/errors  (L0u)  swallowError               │
│  Bun.serve()  (rt)   built-in WebSocket server  │
└─────────────────────────────────────────────────┘
```

---

## Quick Start

```typescript
import { createBunTransport, createGateway } from "@koi/gateway";
import type { GatewayAuthenticator } from "@koi/gateway";

const auth: GatewayAuthenticator = {
  async authenticate(frame) {
    if (frame.auth.token !== "secret") {
      return { ok: false, code: "INVALID_TOKEN", message: "bad token" };
    }
    return { ok: true, sessionId: crypto.randomUUID(), agentId: "agent-1", metadata: {} };
  },
};

const transport = createBunTransport();
const gateway = createGateway({}, { transport, auth });

gateway.onFrame((session, frame) => {
  console.log(`[${session.id}] received:`, frame.kind, frame.seq);
});

gateway.onSessionEvent((ev) => {
  if (ev.kind === "created") console.log("session created:", ev.session.id);
  if (ev.kind === "destroyed") console.log("session destroyed:", ev.sessionId);
});

await gateway.start(8080);
```

---

## Gateway Interface

```typescript
interface Gateway {
  start(port: number): Promise<void>;
  stop(): Promise<void>;
  sessions(): SessionStore;
  onFrame(handler: (session: Session, frame: GatewayFrame) => void): () => void;
  send(sessionId: string, frame: GatewayFrame): Result<number, KoiError>;
  dispatch(session: Session, frame: GatewayFrame): void;
  destroySession(sessionId: string, reason?: string): Result<void, KoiError>;
  onSessionEvent(handler: (event: SessionEvent) => void): () => void;
}
```

| Method | Purpose |
|--------|---------|
| `start(port)` | Bind transport and start accepting connections |
| `stop()` | Stop transport; clears critical sweep timer |
| `sessions()` | Access the session store (read/write) |
| `onFrame(h)` | Subscribe to incoming frames; returns unsubscribe fn |
| `send(id, frame)` | Send a frame to a connected session |
| `dispatch(session, frame)` | Inject a synthetic frame into onFrame handlers |
| `destroySession(id, reason?)` | Force-close a session with ADMIN_CLOSED code |
| `onSessionEvent(h)` | Subscribe to session create/destroy events |

---

## Wire Protocol

### Handshake

Every connection starts with a `ConnectFrame`:

```json
{
  "kind": "connect",
  "minProtocol": 1,
  "maxProtocol": 1,
  "auth": { "token": "..." },
  "client": { "id": "cli-1", "version": "1.0.0", "platform": "cli" }
}
```

Server responds with an `ack` frame containing `HandshakeAckPayload`:

```json
{
  "kind": "ack",
  "seq": 0,
  "payload": {
    "sessionId": "sess-...",
    "protocol": 1,
    "capabilities": { "compression": false, "maxFrameBytes": 1048576 },
    "snapshot": { "serverTime": 1714000000000, "activeConnections": 42 }
  }
}
```

Legacy `"protocol": N` (single field) is also accepted for backward compatibility.

### Post-Handshake Frames

```typescript
interface GatewayFrame {
  kind: "request" | "response" | "event" | "ack" | "error";
  id: string;       // unique frame ID (dedup key)
  seq: number;      // monotonic sequence number
  ref?: string;     // correlates response to request
  payload: unknown;
  timestamp: number;
}
```

---

## Sequencing

Per-connection sliding-window sequence tracker (`createSequenceTracker(windowSize)`):

| Result | Meaning |
|--------|---------|
| `accepted` | In-order; frame dispatched immediately |
| `buffered` | Out-of-order but within window; waits for gap to fill |
| `duplicate` | Seen before (by seq or frame ID); sends ack, not dispatched |
| `out_of_window` | Beyond `nextExpected + windowSize`; sends ack, dropped |

Default window size: 128 frames (`dedupWindowSize` in config).

---

## Routing

Pure functional routing — no side effects, WeakMap-cached compiled patterns.

```typescript
// Dispatch key computed from scoping mode + routing context
computeDispatchKey("per-channel-peer", { channel: "payments", peer: "u42" })
// → "payments:u42"

// Pattern matching: *, ** wildcards
resolveBinding("acme:payments:u1", [
  { pattern: "acme:payments:*", agentId: "billing" },
  { pattern: "acme:**",         agentId: "fallback" },
])
// → "billing"
```

Scoping modes: `"main"`, `"per-peer"`, `"per-channel-peer"`, `"per-account-channel-peer"`.

---

## Backpressure

Per-connection buffer watermarks (configurable):

| State | Trigger |
|-------|---------|
| `normal` | `buffered < 80% of maxBufferBytesPerConnection` |
| `warning` | `buffered >= 80%` |
| `critical` | `buffered >= maxBufferBytesPerConnection` |

Critical connections that don't drain within `backpressureCriticalTimeoutMs` (default 30s) are force-closed with `BACKPRESSURE_TIMEOUT` (4009).

Global limit (`globalBufferLimitBytes`, default 500 MB): new connections rejected when exceeded.

---

## Session Store

Pluggable interface — in-memory default included:

```typescript
interface SessionStore {
  get(id: string): Result<Session, KoiError> | Promise<Result<Session, KoiError>>;
  set(session: Session): Result<void, KoiError> | Promise<Result<void, KoiError>>;
  delete(id: string): Result<boolean, KoiError> | Promise<Result<boolean, KoiError>>;
  has(id: string): Result<boolean, KoiError> | Promise<Result<boolean, KoiError>>;
  size(): number;
  entries(): IterableIterator<readonly [string, Session]>;
}
```

Provide a custom store via `createGateway({}, { transport, auth, store })`.

---

## Configuration

```typescript
interface GatewayConfig {
  minProtocolVersion: number;             // default: 1
  maxProtocolVersion: number;             // default: 1
  capabilities: GatewayCapabilities;     // default: { compression: false, maxFrameBytes: 1MB }
  includeSnapshot: boolean;              // default: true
  maxConnections: number;                // default: 10_000
  backpressureHighWatermark: number;     // default: 0.8 (80%)
  maxBufferBytesPerConnection: number;   // default: 1MB
  globalBufferLimitBytes: number;        // default: 500MB
  dedupWindowSize: number;               // default: 128
  authTimeoutMs: number;                 // default: 5_000
  backpressureCriticalTimeoutMs: number; // default: 30_000
  routing?: RoutingConfig;               // optional
}
```

Pass partial overrides to `createGateway`: `createGateway({ maxConnections: 100 }, deps)`.

---

## Close Codes

| Code | Name | Retryable | Meaning |
|------|------|-----------|---------|
| 1000 | NORMAL | ✗ | Clean closure |
| 1001 | SERVER_SHUTTING_DOWN | ✓ | Restart |
| 4001 | AUTH_TIMEOUT | ✗ | Handshake timed out |
| 4002 | INVALID_HANDSHAKE | ✗ | Malformed connect frame |
| 4003 | AUTH_FAILED | ✗ | Invalid/expired token |
| 4005 | MAX_CONNECTIONS | ✓ | Server at capacity |
| 4006 | BUFFER_LIMIT | ✓ | Global buffer limit |
| 4008 | SESSION_STORE_FAILURE | ✓ | Store unavailable |
| 4009 | BACKPRESSURE_TIMEOUT | ✓ | Slow consumer |
| 4010 | PROTOCOL_MISMATCH | ✗ | No protocol overlap |
| 4012 | ADMIN_CLOSED | ✗ | Force-destroyed |

---

## Layer Compliance

- Depends on `@koi/core` (L0) and `@koi/errors` (L0u) only
- No `@koi/engine` (L1) or peer L2 imports
- All interface properties `readonly`
- No vendor-specific types in public API
- `SessionStore` methods return `T | Promise<T>` — sync or async implementations supported

---

## What's Not Included (Future Issues)

| Feature | Issue |
|---------|-------|
| Node registry + tool routing | gateway-2 |
| Session resume TTL + pending frame buffer | gateway-3 |
| Heartbeat re-validation sweep | gateway-3 |
| Channel runtime binding | gateway-4 |
| Scheduler (periodic frame dispatch) | gateway-5 |
