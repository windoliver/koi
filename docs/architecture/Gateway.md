# Gateway: WebSocket Control Plane

## Overview

`@koi/gateway` is an L2 package that provides the WebSocket control plane for Koi. It manages two distinct connection types through a single transport:

- **Client sessions** — browsers, mobile apps, CLIs, and other frontends that send and receive `GatewayFrame` messages through authenticated sessions.
- **Compute nodes** — local device runtimes (`@koi/node`) that register tools and capacity, exchange `NodeFrame` messages, and optionally route tool calls between each other.

The gateway handles authentication, protocol negotiation, session lifecycle, message sequencing, backpressure, routing, webhook ingestion, scheduled dispatch, and opt-in tool routing between nodes. It depends only on `@koi/core` (L0) and `@koi/errors` (L0u).

---

## Architecture

```
                     ┌─────────────────────────┐
                     │      Transport (WS)      │
                     │  Bun.serve() WebSocket    │
                     └────────────┬────────────┘
                                  │ onOpen / onMessage / onClose / onDrain
                                  │
                     ┌────────────▼────────────┐
                     │     First-Message Router  │
                     │  peekFrameKind(data)      │
                     └──────┬──────────┬────────┘
                            │          │
               kind="connect"     kind="node:*"
                            │          │
               ┌────────────▼──┐  ┌────▼─────────────┐
               │  Client Path  │  │   Node Path       │
               │               │  │                    │
               │  Auth/Handshake│  │  Node Handshake    │
               │  Session Store │  │  Capabilities      │
               │  Seq Tracker  │  │  Registration Ack   │
               │  Backpressure │  │  Node Registry      │
               │  Routing      │  │  Heartbeat/Capacity │
               └───────────────┘  └─────────┬──────────┘
                                            │
                                  ┌─────────▼──────────┐
                                  │  Tool Router (opt-in)│
                                  │  Affinity / Capacity  │
                                  │  Queue / Timeout      │
                                  └───────────────────────┘
         ┌──────────────┐   ┌──────────────┐
         │ Webhook Server│   │  Scheduler   │
         │ HTTP POST     │   │  Periodic    │
         │ → dispatch()  │   │  → dispatch()│
         └──────────────┘   └──────────────┘
```

Both webhook and scheduler inject frames into the same `resolveAndDispatch` pipeline that client frames use, ensuring consistent routing regardless of ingestion source.

---

## Wire Protocol

The gateway uses two distinct frame formats: `GatewayFrame` for client connections and `NodeFrame` for compute-node connections.

### ConnectFrame (Client Handshake)

The first message a client sends must be a `ConnectFrame`:

```typescript
interface ConnectFrame {
  readonly kind: "connect";
  readonly minProtocol: number;     // minimum protocol version (positive integer)
  readonly maxProtocol: number;     // maximum protocol version (>= minProtocol)
  readonly auth: { readonly token: string };
  readonly client?: {               // optional client metadata
    readonly id?: string;
    readonly version?: string;
    readonly platform?: string;     // "web", "ios", "cli", "node"
  };
  readonly resume?: {               // session resume request
    readonly sessionId: string;
    readonly lastSeq: number;
  };
}
```

Legacy clients may send `protocol` (single integer) instead of the range format. The parser accepts both.

### GatewayFrame (Post-Handshake)

All subsequent client messages use `GatewayFrame`:

```typescript
interface GatewayFrame {
  readonly kind: GatewayFrameKind;
  readonly id: string;              // unique message ID (dedup key)
  readonly seq: number;             // monotonic sequence number
  readonly ref?: string;            // correlates response to originating request
  readonly payload: unknown;
  readonly timestamp: number;
}
```

| `GatewayFrameKind` | Direction | Purpose |
|---------------------|-----------|---------|
| `request` | client -> server | Client-initiated request |
| `response` | server -> client | Server response to a request |
| `event` | server -> client | Server-pushed event |
| `ack` | server -> client | Delivery acknowledgement |
| `error` | server -> client | Error response |

### NodeFrame (Compute Node)

Nodes use a separate frame format with different routing semantics:

```typescript
interface NodeFrame {
  readonly kind: NodeFrameKind;
  readonly nodeId: string;
  readonly agentId: string;
  readonly correlationId: string;
  readonly ttl?: number;            // optional per-frame TTL override
  readonly payload: unknown;
}
```

| `NodeFrameKind` | Direction | Purpose |
|------------------|-----------|---------|
| `node:handshake` | node -> gw | Initial registration request |
| `node:capabilities` | node -> gw | Tool list + node type declaration |
| `node:registered` | gw -> node | Registration acknowledgement |
| `node:heartbeat` | node -> gw | Keep-alive signal |
| `node:capacity` | node -> gw | Updated capacity report |
| `node:error` | gw -> node | Error response |
| `agent:dispatch` | gw -> node | Dispatch work to an agent on the node |
| `agent:message` | node -> gw | Agent output message |
| `agent:status` | node -> gw | Agent lifecycle status update |
| `agent:terminate` | gw -> node | Request agent termination |
| `tool_call` | node -> gw | Cross-node tool invocation request |
| `tool_result` | gw -> node | Tool call result (routed back) |
| `tool_error` | gw -> node | Tool call error (routed back) |

---

## Connection Lifecycle

When a WebSocket connection opens, the gateway does not immediately know whether the peer is a client or a compute node. The first message determines the path:

```
  connection opens
       │
       ▼
  start auth timer (authTimeoutMs)
       │
       ▼
  receive first message
       │
       ├── peekFrameKind → "connect"  ──→  Client handshake path
       │
       ├── peekFrameKind → "node:*"   ──→  Node handshake path
       │
       └── other / timeout            ──→  Close(4001 or 4002)
```

Before routing, the gateway checks:
1. `maxConnections` — rejects if at capacity (close code 4005)
2. Global buffer limit — rejects if global backpressure exceeded (close code 4006)

The auth timer fires if no first message arrives within `authTimeoutMs` (default: 5000ms), closing the connection with code 4001.

---

## Authentication and Handshake

The client handshake follows this sequence:

```
  Client                          Gateway
    │                               │
    │──── ConnectFrame ────────────→│
    │                               │ parse + validate
    │                               │ negotiate protocol version
    │                               │ authenticate(connectFrame)
    │                               │
    │←──── HandshakeAck ───────────│  (on success)
    │  or                           │
    │←──── Error + Close ──────────│  (on failure)
```

**Protocol negotiation** computes the highest mutually supported version from the overlap of `[clientMin, clientMax]` and `[serverMin, serverMax]`. If no overlap exists, the connection is closed with code 4010.

**HandshakeAckPayload** returned on success:

```typescript
interface HandshakeAckPayload {
  readonly sessionId: string;
  readonly protocol: number;          // negotiated version
  readonly capabilities: {
    readonly compression: boolean;
    readonly resumption: boolean;      // true when sessionTtlMs > 0
    readonly maxFrameBytes: number;
  };
  readonly snapshot?: {
    readonly serverTime: number;       // enables clock-skew detection
    readonly activeConnections: number; // coarse load signal
  };
}
```

**Auth failure codes**: `INVALID_TOKEN`, `EXPIRED`, `FORBIDDEN`. Each results in a close code of 4003.

The `GatewayAuthenticator` interface that callers must implement:

```typescript
interface GatewayAuthenticator {
  readonly authenticate: (frame: ConnectFrame) => Promise<AuthResult>;
  readonly validate: (sessionId: string) => Promise<boolean>;
}
```

`validate` is called during periodic heartbeat sweeps to re-check session validity. The sweep is sharded (10 shards) and batched (50 concurrent validations) to avoid thundering herd on the auth service. On auth service failure, the sweep fails open — the session stays alive and retries next sweep.

---

## Sessions

A session is created after successful authentication and represents a client's logical connection to the gateway.

```typescript
interface Session {
  readonly id: string;
  readonly agentId: string;
  readonly connectedAt: number;
  readonly lastHeartbeat: number;
  readonly seq: number;            // local outbound sequence counter
  readonly remoteSeq: number;      // last accepted inbound sequence
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly routing?: RoutingContext;
}
```

**SessionStore** is pluggable — the default `createInMemorySessionStore` uses a `Map`. All methods return `Result<T, KoiError> | Promise<Result<T, KoiError>>` so implementations can be sync (in-memory) or async (database-backed).

### Session Events

Subscribers receive lifecycle events via `gateway.onSessionEvent()`:

| Event kind | When emitted |
|------------|-------------|
| `created` | New session established after handshake |
| `resumed` | Disconnected session reconnected within TTL |
| `destroyed` | Session force-destroyed via `destroySession()` |
| `expired` | Disconnected session TTL elapsed without reconnect |

### Session Resume

When `sessionTtlMs > 0`, a disconnecting client's session is kept alive:

1. On disconnect, the session's `SequenceTracker` is preserved and a TTL timer starts.
2. Frames sent to the session during the TTL window are buffered (up to 1,000 frames).
3. The client reconnects with `resume: { sessionId, lastSeq }` in the `ConnectFrame`.
4. On successful resume, buffered frames are flushed to the client immediately.
5. If the TTL expires without reconnection, the session is deleted and an `expired` event fires.

The handshake ack advertises `capabilities.resumption = true` when `sessionTtlMs > 0`.

### Force Destroy

`gateway.destroySession(sessionId, reason?)` works for both connected and disconnected sessions. Connected sessions are closed with code 4012. Disconnected sessions have their TTL timer cancelled and state cleaned up.

---

## Sequencing and Deduplication

Each client session has a `SequenceTracker` that enforces ordering and prevents duplicate processing.

**Sliding window**: Frames are accepted within a window of `[nextExpected, nextExpected + windowSize)`. The window size is controlled by `dedupWindowSize` (default: 128).

**Accept outcomes**:

| Result | Condition | Gateway response |
|--------|-----------|-----------------|
| `accepted` | `seq === nextExpected` | Ack frame, dispatch to handlers |
| `buffered` | `seq` within window but ahead of `nextExpected` | Buffered, released when gap fills |
| `duplicate` | `seq < nextExpected` or ID already seen | Ack frame (idempotent) |
| `out_of_window` | `seq >= nextExpected + windowSize` | Error frame |

When a gap fills, all buffered frames up to the new contiguous frontier are flushed in sequence order. Seen IDs are pruned as the window advances.

---

## Routing

Routing determines which `agentId` handles a frame based on the session's `RoutingContext` (channel, account, peer).

### Scoping Modes

The `ScopingMode` controls how dispatch keys are computed:

| Mode | Dispatch key | Use case |
|------|-------------|----------|
| `main` | `"main"` | Single agent handles everything |
| `per-peer` | `"{peer}"` | Per-user agent instance |
| `per-channel-peer` | `"{channel}:{peer}"` | Per-user per-channel |
| `per-account-channel-peer` | `"{account}:{channel}:{peer}"` | Multi-tenant |

Missing segments default to `"_"`.

### Route Bindings

Pattern-based agent selection. Patterns are `:` delimited with support for `*` (single segment) and `**` (terminal wildcard):

```typescript
interface RouteBinding {
  readonly pattern: string;    // e.g. "slack:*", "**"
  readonly agentId: string;
}
```

Bindings are compiled and cached (via `WeakMap`) for hot-path performance. First match wins.

### Channel Bindings

Direct channel-to-agent mapping with the highest priority in route resolution:

- **Static**: declared in `GatewayConfig.channelBindings`, loaded at startup.
- **Runtime**: `gateway.bindChannel(name, agentId)` / `gateway.unbindChannel(name)`.

### Resolution Order

```
1. Channel binding (channelName → agentId)     highest priority
2. Pattern binding (dispatchKey → agentId)
3. Fallback (session.agentId)                   lowest priority
```

---

## Node Registry

The node registry tracks connected compute nodes, their tools, and capacity. It maintains an inverted tool index for O(1) tool-to-nodes lookups.

### Registration Flow

```
  Node                             Gateway
    │                                │
    │── node:handshake ────────────→│  validate payload (nodeId, version, capacity)
    │                                │  evict stale connection if same nodeId
    │── node:capabilities ─────────→│  validate tools + nodeType
    │                                │  register in NodeRegistry
    │                                │  build inverted tool index
    │←── node:registered ──────────│  ack with registeredAt timestamp
    │                                │  emit "registered" NodeRegistryEvent
```

Two-step handshake: the first message provides identity and capacity, the second provides tool capabilities and node type (`"full"` or `"thin"`).

### RegisteredNode

```typescript
interface RegisteredNode {
  readonly nodeId: string;
  readonly mode: "full" | "thin";
  readonly tools: readonly AdvertisedTool[];
  readonly capacity: CapacityReport;   // { current, max, available }
  readonly connectedAt: number;
  readonly lastHeartbeat: number;
  readonly connId: string;
}
```

### Inverted Tool Index

`toolName -> Set<nodeId>` mapping built at registration time. `registry.findByTool(name)` returns all nodes advertising a given tool in O(1) lookup time. The index is incrementally maintained — entries are added on register and removed on deregister.

### Heartbeat and Capacity

- **Heartbeat**: nodes send `node:heartbeat` frames periodically. The gateway updates `lastHeartbeat` on the registered node.
- **Capacity**: nodes send `node:capacity` frames when their load changes. The gateway updates the `CapacityReport`.
- **Stale sweep**: a periodic timer (every `sweepIntervalMs`) checks all nodes. Any node whose `lastHeartbeat` is older than `nodeHeartbeatTimeoutMs` (default: 90s, 3x the heartbeat interval) is evicted.

### Reconnect

When a node reconnects with the same `nodeId`, the gateway evicts the old connection (close code 4014 "Replaced by reconnecting node"), cleans up all state, then processes the new handshake normally. This prevents ghost connections from holding registry slots.

### Node Events

Subscribers receive events via `gateway.onNodeEvent()`:

| Event kind | When emitted |
|------------|-------------|
| `registered` | Node completed handshake and capability exchange |
| `deregistered` | Node disconnected or evicted |
| `heartbeat` | Node sent heartbeat |
| `capacity_updated` | Node reported new capacity |

---

## Tool Routing

Tool routing enables nodes to invoke tools hosted on other nodes through the gateway. It is entirely opt-in — disabled by default, enabled by setting `GatewayConfig.toolRouting`.

### Why tool routing exists

In a multi-node deployment, Node-A may need to call a tool that only Node-B provides. Without tool routing, the calling node would need direct knowledge of peer nodes. Tool routing lets the gateway act as a transparent broker: nodes only communicate with the gateway, and the gateway handles discovery, forwarding, correlation, and error propagation.

### Routing Algorithm

When a `tool_call` frame arrives, the router applies a 5-priority decision tree:

```
1. Validate payload (toolName, callerAgentId present)
2. Check pending limit (maxPendingCalls)
3. Resolve target node:
   a. Find all nodes advertising the tool (inverted index)
   b. Exclude the source node (it already tried locally)
   c. Check affinity rules (glob pattern → preferred node)
   d. Pick highest available capacity among remaining candidates
4. If no candidate: queue with TTL (if queue not full)
5. If queue full or disabled: return tool_error to source
```

### Cross-Node Flow

```
  Node-A                    Gateway                     Node-B
    │                          │                           │
    │── tool_call ───────────→│                           │
    │   correlationId: "abc"   │ resolve target            │
    │                          │ generate routing ID       │
    │                          │   "route-abc-{ts}"        │
    │                          │── tool_call ─────────────→│
    │                          │   correlationId:           │
    │                          │     "route-abc-{ts}"       │
    │                          │                           │
    │                          │←── tool_result ──────────│
    │                          │   correlationId:           │
    │                          │     "route-abc-{ts}"       │
    │                          │ lookup pending entry       │
    │                          │ restore original corr ID   │
    │←── tool_result ─────────│                           │
    │   correlationId: "abc"   │                           │
```

The gateway generates a routing correlation ID (`route-{original}-{timestamp}`) to track the forwarded call. When the result returns, the gateway maps it back to the original caller's correlation ID.

### Affinity

Affinity rules provide static preferences for routing specific tools to specific nodes:

```typescript
interface ToolAffinity {
  readonly pattern: string;    // glob pattern, e.g. "search_*", "db.*"
  readonly nodeId: string;     // preferred target node
}
```

Glob patterns are compiled to `RegExp` at construction time (`*` becomes `.*`). Affinity is a preference, not a requirement — if the preferred node is offline or is the source node, the router falls back to capacity-based selection.

### Queue

When no node is available for a tool call, it is queued in memory:

- **Max size**: `maxQueuedCalls` (default: 1,000)
- **TTL**: `queueTimeoutMs` (default: 60,000ms)
- **Dequeue**: when a new node registers, the router checks if any queued calls match the node's tools and dispatches them immediately.
- **Expiry**: a TTL timer fires `tool_error` back to the source if no node becomes available.

### Timeout

Each routed call has a timeout:

- **Default**: `defaultTimeoutMs` (default: 30,000ms)
- **Per-call override**: if the `NodeFrame.ttl` field is set, it overrides the default.
- On timeout, the pending entry is cleaned up and a `tool_error` with code `"timeout"` is sent to the source node.

### Disconnect Handling

**Target node disconnects**: all pending calls targeting that node receive `tool_error` with `"not_found"` code. The source node can retry or handle the failure.

**Source node disconnects**: pending calls from that node are silently cleaned up (no one to receive the result). Queued calls from that node are also removed.

### ToolRouter Interface

```typescript
interface ToolRouter {
  readonly handleToolCall: (frame: NodeFrame) => void;
  readonly handleToolResult: (frame: NodeFrame) => void;
  readonly handleToolError: (frame: NodeFrame) => void;
  readonly handleNodeDisconnect: (nodeId: string) => void;
  readonly handleNodeRegistered: (nodeId: string) => void;
  readonly pendingCount: () => number;
  readonly queuedCount: () => number;
  readonly dispose: () => void;
}
```

The tool router is wired into the node connection handler via callback — `tool_call`, `tool_result`, and `tool_error` frame kinds are intercepted and forwarded to the router. The router also subscribes to node registry events to handle disconnect cleanup and queue drain on registration.

---

## Backpressure

The backpressure monitor tracks per-connection and global buffer usage, transitioning through three states:

```
  normal ──→ warning ──→ critical ──→ force-close
           (watermark)  (max buffer)  (timeout)
```

| State | Condition | Behavior |
|-------|-----------|----------|
| `normal` | `buffered < warningThreshold` | All frames processed |
| `warning` | `buffered >= maxBuffer * highWatermark` | Frames still processed (signal only) |
| `critical` | `buffered >= maxBufferBytesPerConnection` | Frames dropped; timeout starts |

- **Warning threshold**: `maxBufferBytesPerConnection * backpressureHighWatermark` (default: 80% of 1MB = ~819KB)
- **Critical timeout**: if a connection remains in critical state for `backpressureCriticalTimeoutMs` (default: 30s), it is force-closed (code 4009).
- **Global limit**: `globalBufferLimitBytes` (default: 500MB). New connections are rejected when the global buffer is exceeded (code 4006).
- **Drain recovery**: when the transport reports a drain event, buffered bytes are decremented and the state may recover to warning or normal.

---

## Webhooks

The webhook server provides HTTP POST ingestion that converts requests into `GatewayFrame` events dispatched through the same routing pipeline as WebSocket frames.

- **Activation**: set `GatewayConfig.webhookPort` to enable (undefined = disabled).
- **Path routing**: requests must match `{webhookPath}/{channel?}/{account?}`. Default path prefix: `/webhook`.
- **Peer identification**: `X-Webhook-Peer` header (defaults to `"webhook"`).
- **Authentication**: optional `WebhookAuthenticator` receives the raw request and body (for HMAC signature verification).
- **Body limits**: 1MB default max body size with streaming enforcement (no Content-Length required).
- **Virtual session**: each webhook creates a transient session with `id: "webhook-{frameId}"` that passes through `resolveAndDispatch`.

---

## Scheduler

The scheduler generates periodic `GatewayFrame` events at fixed intervals, useful for cron-like agent dispatch.

```typescript
interface SchedulerDef {
  readonly id: string;
  readonly intervalMs: number;    // minimum: 100ms
  readonly agentId: string;
  readonly payload?: unknown;
}
```

Each scheduler definition produces:
- A virtual session with `id: "scheduler-{def.id}"` and `agentId` from the definition.
- An event frame with the configured payload (or `{ schedulerId, type: "tick" }` by default).

Frames are dispatched through `resolveAndDispatch`, so routing rules apply. The minimum interval is 100ms to prevent accidental self-DoS.

---

## Configuration Reference

### GatewayConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `minProtocolVersion` | `number` | `1` | Minimum protocol version the server supports |
| `maxProtocolVersion` | `number` | `1` | Maximum protocol version the server supports |
| `capabilities` | `GatewayCapabilities` | `{ compression: false, resumption: false, maxFrameBytes: 1_048_576 }` | Capabilities advertised during handshake |
| `includeSnapshot` | `boolean` | `true` | Whether to include runtime snapshot in handshake ack |
| `maxConnections` | `number` | `10_000` | Maximum concurrent connections |
| `backpressureHighWatermark` | `number` | `0.8` | Buffer utilization ratio that triggers warning state |
| `maxBufferBytesPerConnection` | `number` | `1_048_576` (1MB) | Maximum buffered bytes per connection |
| `globalBufferLimitBytes` | `number` | `524_288_000` (500MB) | Global buffer limit across all connections |
| `dedupWindowSize` | `number` | `128` | Sliding window size for deduplication |
| `heartbeatIntervalMs` | `number` | `30_000` | Heartbeat interval for session validation |
| `authTimeoutMs` | `number` | `5_000` | Auth handshake timeout |
| `backpressureCriticalTimeoutMs` | `number` | `30_000` | Time before force-closing a critical connection |
| `sweepIntervalMs` | `number` | `10_000` | Timer sweep interval for heartbeat/stale checks |
| `nodeHeartbeatTimeoutMs` | `number` | `90_000` | Node heartbeat timeout (3x heartbeat interval) |
| `sessionTtlMs` | `number` | `0` | Session TTL after disconnect (0 = immediate cleanup) |
| `routing` | `RoutingConfig?` | `undefined` | Routing configuration for session dispatch |
| `channelBindings` | `ChannelBinding[]?` | `undefined` | Static channel-to-agent bindings |
| `webhookPort` | `number?` | `undefined` | Port for webhook HTTP server (undefined = disabled) |
| `webhookPath` | `string?` | `"/webhook"` | URL path prefix for webhook endpoints |
| `schedulers` | `SchedulerDef[]?` | `undefined` | Scheduler definitions for periodic dispatch |
| `toolRouting` | `Partial<ToolRoutingConfig>?` | `undefined` | Tool routing config (undefined = disabled) |

### ToolRoutingConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `defaultTimeoutMs` | `number` | `30_000` | Default timeout for routed tool calls |
| `maxPendingCalls` | `number` | `10_000` | Maximum concurrently pending routed calls |
| `maxQueuedCalls` | `number` | `1_000` | Maximum tool calls queued waiting for a node |
| `queueTimeoutMs` | `number` | `60_000` | TTL for queued tool calls |
| `affinities` | `ToolAffinity[]?` | `undefined` | Static tool-to-node routing preferences |

---

## Gateway Public API

The `createGateway(config, deps)` factory returns a `Gateway` object:

```typescript
interface Gateway {
  readonly start: (port: number) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly sessions: () => SessionStore;
  readonly onFrame: (handler: (session: Session, frame: GatewayFrame) => void) => () => void;
  readonly send: (sessionId: string, frame: GatewayFrame) => Result<number, KoiError>;
  readonly dispatch: (session: Session, frame: GatewayFrame) => void;
  readonly webhookPort: () => number | undefined;
  readonly nodeRegistry: () => NodeRegistry;
  readonly onNodeEvent: (handler: (event: NodeRegistryEvent) => void) => () => void;
  readonly destroySession: (sessionId: string, reason?: string) => Result<void, KoiError>;
  readonly onSessionEvent: (handler: (event: SessionEvent) => void) => () => void;
  readonly bindChannel: (channelName: string, agentId: string) => void;
  readonly unbindChannel: (channelName: string) => boolean;
  readonly channelBindings: () => ReadonlyMap<string, string>;
  readonly sendToNode: (nodeId: string, frame: NodeFrame) => Result<number, KoiError>;
}
```

**Dependencies** (`GatewayDeps`):

| Dep | Required | Purpose |
|-----|----------|---------|
| `transport` | yes | WebSocket transport (use `createBunTransport()`) |
| `auth` | yes | Authentication provider (must implement `GatewayAuthenticator`) |
| `store` | no | Session persistence (defaults to in-memory) |
| `webhookAuth` | no | Webhook request authenticator (for HMAC verification) |

---

## Close Codes

| Code | Meaning |
|------|---------|
| 1001 | Server shutting down (graceful) |
| 4001 | Auth timeout — no first message within `authTimeoutMs` |
| 4002 | Invalid first message (parse error, wrong kind, bad handshake) |
| 4003 | Authentication failed (`INVALID_TOKEN`, `EXPIRED`, `FORBIDDEN`) |
| 4004 | Session expired (heartbeat sweep) |
| 4005 | Max connections exceeded |
| 4006 | Global buffer limit exceeded |
| 4007 | No session (post-handshake message without session) |
| 4008 | Session store failure |
| 4009 | Backpressure timeout (critical state exceeded threshold) |
| 4010 | Protocol version mismatch |
| 4011 | Session expired (resume attempt for expired session) |
| 4012 | Session destroyed (via `destroySession()`) |
| 4013 | Node heartbeat expired |
| 4014 | Replaced by reconnecting node (same nodeId) |
