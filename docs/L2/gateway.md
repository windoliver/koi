# @koi/gateway — WebSocket Control Plane

WebSocket gateway for Koi's multi-node architecture. Manages two distinct connection types through a single transport: **client sessions** (browsers, CLIs) exchanging `GatewayFrame` messages, and **compute nodes** (`@koi/node`) exchanging `NodeFrame` messages for tool routing, capacity reporting, and agent dispatch. Handles authentication, protocol negotiation, sequencing, backpressure, routing, webhook ingestion, scheduled dispatch, and cross-node tool execution.

---

## Why It Exists

Koi agents run on distributed compute nodes — a laptop running a Pi agent, a cloud VM exposing search tools, a Raspberry Pi with camera access. These nodes need a central coordination point that:

- **Routes tool calls** — Agent A on Node-1 calls `camera.capture`, which only Node-2 provides. The gateway discovers the target, forwards the call, tracks the response, and routes the result back.
- **Manages sessions** — Clients connect, authenticate, resume after disconnects, and receive ordered, deduplicated frames.
- **Tracks capacity** — Nodes report their load. The gateway selects the best target for each tool call (affinity > capacity > queue).
- **Handles backpressure** — Per-connection and global buffer monitoring prevents slow consumers from overwhelming the system.
- **Ingests webhooks** — External HTTP events (Slack, GitHub, Stripe) flow through the same routing pipeline as WebSocket frames.

Without this package, every agent would need direct knowledge of every other agent's location, tools, and availability.

---

## Architecture

`@koi/gateway` is an **L2 feature package** — it depends only on L0 (`@koi/core`) and L0-utility (`@koi/errors`).

```
┌──────────────────────────────────────────────────────────────┐
│  @koi/gateway  (L2)                                          │
│                                                              │
│  gateway.ts          ← factory: createGateway()              │
│  transport.ts        ← Bun.serve() WebSocket abstraction     │
│  auth.ts             ← handshake + heartbeat sweep           │
│  protocol.ts         ← frame parsing, negotiation, encoding  │
│  routing.ts          ← dispatch key + pattern binding        │
│  session-store.ts    ← pluggable session persistence         │
│  sequence-tracker.ts ← ordering + deduplication              │
│  backpressure.ts     ← per-conn + global buffer monitoring   │
│  node-handler.ts     ← node frame parsing + validation       │
│  node-connection.ts  ← node lifecycle + stale sweep          │
│  node-registry.ts    ← node registration + inverted index    │
│  tool-router.ts      ← cross-node tool call routing          │
│  scheduler.ts        ← periodic frame generation             │
│  webhook.ts          ← HTTP POST ingestion                   │
│  types.ts            ← config, frame, session types          │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  Dependencies                                                │
│                                                              │
│  @koi/core    (L0)   Result, KoiError, AdvertisedTool,       │
│                      CapacityReport, ToolCallPayload,         │
│                      isToolCallPayload                        │
│  @koi/errors  (L0u)  error factories                         │
│  Bun.serve()  (rt)   built-in WebSocket server               │
└──────────────────────────────────────────────────────────────┘
```

For the full architecture deep-dive (wire protocol, connection lifecycle, close codes), see [docs/architecture/Gateway.md](../architecture/Gateway.md).

---

## Two Connection Types

The gateway serves two kinds of peers over the same WebSocket port:

```
┌──────────────────┐                        ┌──────────────────┐
│  CLIENT           │                        │  COMPUTE NODE     │
│  (browser, CLI)   │                        │  (full or thin)   │
│                   │                        │                   │
│  Sends:           │                        │  Sends:           │
│  ConnectFrame     │                        │  node:handshake   │
│  GatewayFrame     │                        │  node:capabilities│
│                   │                        │  tool_call        │
│  Receives:        │                        │  tool_result      │
│  HandshakeAck     │                        │  node:heartbeat   │
│  GatewayFrame     │                        │                   │
└────────┬─────────┘                        └────────┬─────────┘
         │                                           │
         │        ┌───────────────────────┐          │
         └───────▶│      GATEWAY          │◀─────────┘
                  │                       │
                  │  First message peek   │
                  │  determines path:     │
                  │  "connect" → client   │
                  │  "node:*" → node      │
                  └───────────────────────┘
```

### Node Types

| | Full Node | Thin Node |
|---|-----------|-----------|
| Agents | Runs Pi/Loop engines | None |
| Tools | Optional local tools | Exposes local tools |
| Tool calls | Dispatches `tool_call` frames | Executes `tool_call` frames |
| Use case | Laptop running an agent | Raspberry Pi with camera |

A full node's agent calls a tool. If the tool isn't local, the gateway routes it to a thin node that has it.

---

## Node Registry

The registry tracks connected nodes, their tools, and their capacity. An **inverted tool index** provides O(1) tool-to-nodes lookup.

```
┌─────────────────────────────────────────────────────────────┐
│  Node Registry                                               │
│                                                              │
│  Nodes:                  Inverted Index:                     │
│  ┌───────────────────┐   ┌──────────────────────────────┐   │
│  │ node-laptop        │   │ "search"     → {node-laptop} │   │
│  │  mode: full        │   │ "camera.*"   → {node-pi}     │   │
│  │  tools: [search]   │   │ "fetch_url"  → {node-laptop, │   │
│  │  cap: 8/10         │   │                node-cloud}   │   │
│  ├───────────────────┤   └──────────────────────────────┘   │
│  │ node-pi            │                                      │
│  │  mode: thin        │   Events:                            │
│  │  tools: [camera.*] │   ├ registered                       │
│  │  cap: 2/4          │   ├ deregistered                     │
│  ├───────────────────┤   ├ heartbeat                         │
│  │ node-cloud         │   ├ capacity_updated                 │
│  │  mode: thin        │   ├ tools_added                      │
│  │  tools: [fetch_url]│   └ tools_removed                    │
│  │  cap: 50/100       │                                      │
│  └───────────────────┘                                       │
└─────────────────────────────────────────────────────────────┘
```

### Registration Flow

```
Node                           Gateway
  │                              │
  │── node:handshake ──────────▶│  validate nodeId, version, capacity
  │── node:capabilities ───────▶│  validate tools + nodeType
  │                              │  register in NodeRegistry
  │                              │  build inverted tool index
  │◀── node:registered ────────│  ack with timestamp
```

### Dynamic Tool Re-advertisement

Nodes can update their tool set at runtime without disconnecting:

```
Node                           Gateway
  │                              │
  │── node:tools_updated ──────▶│  payload: {
  │   {                          │    added: [{ name: "deploy" }],
  │     added: [deploy],         │    removed: ["search"]
  │     removed: [search]        │  }
  │   }                          │
  │                              │  registry.updateTools():
  │                              │    add "deploy" to inverted index
  │                              │    remove "search" from index
  │                              │    emit tools_added event
  │                              │    emit tools_removed event
  │                              │
  │                              │  toolRouter.handleToolsUpdated():
  │                              │    drain queued calls matching "deploy"
```

This enables hot-plugging: a node starts with a base tool set and advertises new capabilities as plugins load.

---

## Tool Routing

Cross-node tool execution with a 5-priority decision tree. Entirely opt-in — disabled by default.

### Routing Algorithm

```
tool_call arrives from Node-A
          │
          ▼
1. isToolCallPayload(payload)?  ──no──▶ VALIDATION error
          │ yes
          ▼
2. pending.size < maxPendingCalls?  ──no──▶ RATE_LIMIT error
          │ yes
          ▼
3. registry.findByTool(toolName)
          │
          ├── no candidates ──▶ queue (if space) or NOT_FOUND error
          │
          ▼
4. exclude source node (Node-A)
          │
          ├── no remote candidates ──▶ queue or NOT_FOUND error
          │
          ▼
5a. affinity match?  ──yes──▶ route to preferred node
          │ no
          ▼
5b. O(N) capacity scan ──▶ route to highest-available node
```

### Error Codes

All tool routing errors use typed constants:

```typescript
const TOOL_ROUTING_ERROR_CODES = {
  NOT_FOUND: "not_found",       // no node available for tool
  TIMEOUT: "timeout",           // routed call exceeded TTL
  RATE_LIMIT: "rate_limit",     // maxPendingCalls reached
  VALIDATION: "validation",     // malformed tool_call payload
} as const;
```

### Cross-Node Round Trip

```
Full Node (Agent)              Gateway                  Thin Node (Tools)
     │                            │                            │
     │── tool_call ──────────────▶│                            │
     │   corr: "abc"              │  resolve → thin-node       │
     │                            │  track: "route-abc-{ts}"   │
     │                            │── tool_call ──────────────▶│
     │                            │   corr: "route-abc-{ts}"   │
     │                            │                            │
     │                            │                            │ execute tool
     │                            │                            │
     │                            │◀── tool_result ───────────│
     │                            │   corr: "route-abc-{ts}"   │
     │                            │                            │
     │                            │  lookup pending → restore  │
     │◀── tool_result ───────────│                            │
     │   corr: "abc"  (restored)  │                            │
```

The gateway generates a routing correlation ID to track forwarded calls. When the result returns, it restores the original caller's correlation ID — the calling agent sees a transparent tool invocation.

### Affinity

Static tool-to-node preferences via glob patterns:

```typescript
const config: ToolRoutingConfig = {
  defaultTimeoutMs: 30_000,
  maxPendingCalls: 10_000,
  maxQueuedCalls: 1_000,
  queueTimeoutMs: 60_000,
  affinities: [
    { pattern: "camera.*", nodeId: "node-pi" },
    { pattern: "db_*", nodeId: "node-cloud" },
  ],
};
```

Patterns are compiled to `RegExp` at construction time. Affinity is a preference — if the preferred node is offline, the router falls back to capacity-based selection.

### Queue and Drain

When no node is available, tool calls are queued with a TTL:

```
t=0  tool_call("deploy") arrives
     → no node has "deploy" → QUEUED (TTL: 60s)

     Queue: [ deploy (TTL: 60s) ]

t=5  Node-3 connects, advertises: [deploy]
     → handleNodeRegistered("node-3")
     → scan queue → match "deploy" → DRAIN

     Queue: [ ] (empty)

     tool_call forwarded to Node-3 → result back to caller
```

Queue drain also triggers on `node:tools_updated` — when an existing node adds a tool that matches queued calls.

---

## API Reference

### Factory Functions

#### `createGateway(config, deps)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `config` | `Partial<GatewayConfig>` | Merged with `DEFAULT_GATEWAY_CONFIG` |
| `deps.transport` | `Transport` | WebSocket server (use `createBunTransport()`) |
| `deps.auth` | `GatewayAuthenticator` | Authentication provider |
| `deps.store` | `SessionStore?` | Session persistence (defaults to in-memory) |
| `deps.webhookAuth` | `WebhookAuthenticator?` | Webhook HMAC verification |

Returns `Gateway`.

#### `createBunTransport()`

Returns `BunTransport` wrapping `Bun.serve()` with WebSocket upgrade.

#### `createInMemorySessionStore()`

Returns `SessionStore`. Map-based. Process-lifetime only.

#### `createInMemoryNodeRegistry()`

Returns `NodeRegistry` with inverted tool index.

#### `createToolRouter(config, deps)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `config` | `ToolRoutingConfig` | Timeouts, limits, affinities |
| `deps.registry` | `NodeRegistry` | Node lookup |
| `deps.sendToNode` | `(nodeId, frame) => Result<number, KoiError>` | Frame delivery |

Returns `ToolRouter`.

#### `createBackpressureMonitor(config)`

Returns `BackpressureMonitor` with per-connection and global tracking.

#### `createSequenceTracker(windowSize)`

Returns `SequenceTracker` for ordering and deduplication.

#### `createScheduler(defs, dispatcher)`

Returns `GatewayScheduler` for periodic frame generation.

#### `createWebhookServer(config, dispatcher, auth?)`

Returns `WebhookServer` for HTTP POST ingestion.

### Pure Functions

| Function | Purpose |
|----------|---------|
| `parseFrame(raw)` | Parse JSON string to `GatewayFrame` |
| `parseConnectFrame(data)` | Parse connect handshake |
| `encodeFrame(frame)` | Serialize `GatewayFrame` to JSON |
| `parseNodeFrame(data)` | Parse JSON string to `NodeFrame` |
| `encodeNodeFrame(frame)` | Serialize `NodeFrame` to JSON |
| `peekFrameKind(data)` | Extract frame kind without full parse |
| `negotiateProtocol(cMin, cMax, sMin, sMax)` | Highest mutual version |
| `handleHandshake(conn, auth, timeout, opts, onMsg)` | Client handshake orchestration |
| `startHeartbeatSweep(store, auth, interval, sweep, onExpired)` | Periodic session validation |
| `computeDispatchKey(scopingMode, routing)` | Generate dispatch key |
| `validateBindingPattern(pattern)` | Validate route pattern |
| `resolveBinding(dispatchKey, bindings)` | Match pattern to agent |
| `resolveRoute(config, ctx, agentId, channelMap)` | Full route resolution |
| `resolveTargetNode(tool, source, registry, affinities)` | Tool routing resolution |
| `compileAffinities(affinities)` | Pre-compile glob patterns |
| `matchAffinity(toolName, compiled)` | Match tool against affinities |
| `validateHandshakePayload(p)` | Validate node handshake |
| `validateCapabilitiesPayload(p)` | Validate node capabilities |
| `validateCapacityPayload(p)` | Validate capacity report |

### Types

| Type | Description |
|------|-------------|
| `Gateway` | Main gateway interface (start, stop, send, dispatch, routing) |
| `GatewayDeps` | Dependencies for `createGateway` |
| `GatewayConfig` | Full configuration (see architecture doc for all fields) |
| `GatewayFrame` | Client frame (kind, id, seq, ref, payload, timestamp) |
| `NodeFrame` | Compute node frame (kind, nodeId, agentId, correlationId, payload) |
| `Session` | Client session state |
| `SessionStore` | Pluggable persistence interface |
| `SessionEvent` | Session lifecycle event |
| `RegisteredNode` | Registered compute node |
| `NodeRegistry` | Node management + inverted tool index |
| `NodeRegistryEvent` | Node lifecycle event |
| `ToolRouter` | Cross-node tool call router |
| `ToolRoutingConfig` | Router configuration |
| `ToolAffinity` | Pattern-to-node preference |
| `RouteResult` | Routing resolution outcome |
| `Transport` | WebSocket server abstraction |
| `TransportConnection` | Individual connection handle |
| `BackpressureMonitor` | Buffer tracking per connection |
| `SequenceTracker` | Ordering + deduplication |
| `AcceptResult` | Frame accept outcome |
| `GatewayScheduler` | Timer-based frame generator |
| `WebhookServer` | HTTP POST ingestion server |

### Constants

| Constant | Value |
|----------|-------|
| `DEFAULT_GATEWAY_CONFIG` | Full config defaults (see architecture doc) |
| `DEFAULT_TOOL_ROUTING_CONFIG` | `{ defaultTimeoutMs: 30_000, maxPendingCalls: 10_000, maxQueuedCalls: 1_000, queueTimeoutMs: 60_000 }` |
| `TOOL_ROUTING_ERROR_CODES` | `{ NOT_FOUND, TIMEOUT, RATE_LIMIT, VALIDATION }` |

---

## Examples

### Minimal Gateway

```typescript
import { createGateway, createBunTransport } from "@koi/gateway";
import type { GatewayAuthenticator, ConnectFrame, AuthResult } from "@koi/gateway";

const auth: GatewayAuthenticator = {
  authenticate: async (frame: ConnectFrame): Promise<AuthResult> => ({
    ok: true,
    sessionId: `session-${Date.now()}`,
    agentId: "default-agent",
    metadata: {},
  }),
  validate: async (_sessionId: string): Promise<boolean> => true,
};

const gateway = createGateway({}, {
  transport: createBunTransport(),
  auth,
});

await gateway.start(8080);
```

### Gateway with Tool Routing

```typescript
import { createGateway, createBunTransport } from "@koi/gateway";

const gateway = createGateway(
  {
    toolRouting: {
      defaultTimeoutMs: 30_000,
      maxPendingCalls: 10_000,
      maxQueuedCalls: 1_000,
      queueTimeoutMs: 60_000,
      affinities: [
        { pattern: "camera.*", nodeId: "node-pi" },
        { pattern: "search_*", nodeId: "node-cloud" },
      ],
    },
  },
  { transport: createBunTransport(), auth },
);

// Subscribe to node lifecycle events
const unsub = gateway.onNodeEvent((event) => {
  switch (event.kind) {
    case "registered":
      console.log(`Node ${event.nodeId} connected`);
      break;
    case "tools_added":
      console.log(`Node ${event.nodeId} added tools: ${event.tools.map((t) => t.name)}`);
      break;
    case "tools_removed":
      console.log(`Node ${event.nodeId} removed tools: ${event.toolNames}`);
      break;
  }
});

await gateway.start(8080);
```

### Direct Tool Routing (Unit-Level)

```typescript
import {
  createInMemoryNodeRegistry,
  createToolRouter,
  resolveTargetNode,
  compileAffinities,
  DEFAULT_TOOL_ROUTING_CONFIG,
} from "@koi/gateway";
import type { AdvertisedTool, CapacityReport } from "@koi/core";

const registry = createInMemoryNodeRegistry();

// Register two thin nodes with different tools
registry.register({
  nodeId: "node-pi",
  mode: "thin",
  tools: [{ name: "camera.capture" }, { name: "camera.zoom" }],
  capacity: { current: 1, max: 4, available: 3 },
  connectedAt: Date.now(),
  lastHeartbeat: Date.now(),
  connId: "conn-1",
});

registry.register({
  nodeId: "node-cloud",
  mode: "thin",
  tools: [{ name: "search" }, { name: "fetch_url" }],
  capacity: { current: 10, max: 100, available: 90 },
  connectedAt: Date.now(),
  lastHeartbeat: Date.now(),
  connId: "conn-2",
});

// Resolve routing with affinity
const affinities = compileAffinities([
  { pattern: "camera.*", nodeId: "node-pi" },
]);

const result = resolveTargetNode("camera.capture", "node-agent", registry, affinities);
// result = { kind: "routed", targetNodeId: "node-pi" }
```

### Dynamic Tool Updates

```typescript
import { createInMemoryNodeRegistry } from "@koi/gateway";

const registry = createInMemoryNodeRegistry();

// Node starts with search only
registry.register({
  nodeId: "node-a",
  mode: "thin",
  tools: [{ name: "search" }],
  capacity: { current: 0, max: 10, available: 10 },
  connectedAt: Date.now(),
  lastHeartbeat: Date.now(),
  connId: "conn-1",
});

// Later: node loads a plugin, adds "deploy" tool
const result = registry.updateTools(
  "node-a",
  [{ name: "deploy", description: "Deploy to staging" }],  // added
  ["search"],                                                // removed
);
// result.ok === true

// Registry now reflects the change
const deployers = registry.findByTool("deploy");
// deployers = [{ nodeId: "node-a", tools: [deploy], ... }]

const searchers = registry.findByTool("search");
// searchers = [] (removed)
```

### Webhook + Scheduler

```typescript
const gateway = createGateway(
  {
    webhookPort: 9090,
    webhookPath: "/hook",
    schedulers: [
      {
        id: "health-check",
        intervalMs: 60_000,
        agentId: "monitor-agent",
        payload: { type: "health_check" },
      },
    ],
  },
  { transport: createBunTransport(), auth },
);

// Webhooks POST to http://localhost:9090/hook/{channel}/{account}
// Scheduler ticks every 60s, dispatched as GatewayFrame events
```

---

## Backpressure

Three-state model per connection with global limits:

```
normal ──▶ warning ──▶ critical ──▶ force-close
          (80% buffer)  (100% buffer)  (30s timeout)
```

| State | Threshold | Behavior |
|-------|-----------|----------|
| `normal` | `< 80% of maxBuffer` | All frames processed |
| `warning` | `>= 80% of maxBuffer` | Signal only (observable) |
| `critical` | `>= maxBufferBytesPerConnection` | Frames dropped; timeout starts |

Global limit: 500MB across all connections. New connections rejected when exceeded.

---

## Session Lifecycle

```
connect ──▶ authenticate ──▶ session created
                                   │
                              disconnect
                                   │
               ┌───────────────────┼───────────────────┐
               ▼                   ▼                   ▼
          sessionTtlMs=0    sessionTtlMs>0       destroySession()
               │                   │                   │
               ▼                   ▼                   ▼
           destroyed          kept alive           destroyed
                               (buffering)
                                   │
                    ┌──────────────┼──────────────┐
                    ▼                             ▼
              reconnect within TTL          TTL expires
                    │                             │
                    ▼                             ▼
              session resumed               session expired
              (flush buffer)
```

---

## Layer Compliance

```
L0  @koi/core ───────────────────────────────────────┐
    Result, KoiError, AdvertisedTool, CapacityReport,  │
    ToolCallPayload, isToolCallPayload                 │
                                                       │
L0u @koi/errors ────────────────────┐                 │
    error factories                 │                 │
                                    ▼                 ▼
L2  @koi/gateway ◀─────────────────┴─────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages (@koi/node, @koi/forge, etc.)
    ✓ Bun.serve() is a runtime built-in
```

Shared wire types (`AdvertisedTool`, `CapacityReport`, `ToolCallPayload`) live in `@koi/core` (L0) — both `@koi/gateway` and `@koi/node` import from the same source, eliminating duplication between L2 peers.
