# @koi/node-stack — Full Node Bundle

Convenience package that wires `@koi/node` + `@koi/agent-discovery` + `@koi/agent-procfs` + `@koi/debug` + `@koi/tracing` into a single `createNodeStack()` call with unified start/stop lifecycle.

---

## Why It Exists

The node side of Koi has five observability packages under `packages/observability/` plus the core `@koi/node` runtime. Wiring these together manually requires importing each factory, connecting the agent mounter to the registry, and coordinating startup/shutdown order. This L3 bundle provides:

- **One-call setup** — `createNodeStack()` creates and connects all subsystems
- **Unified lifecycle** — `start()` boots the node; `stop()` disposes the agent mounter then shuts down
- **Optional subsystems** — Omit `discovery`, `procfs`, or `tracing` from config to disable them
- **Mode-guarded wiring** — Agent mounter only activates for full-mode nodes with a registry
- **Direct access** — All subsystem handles remain accessible for advanced use
- **Debug re-export** — `@koi/debug` functions re-exported for convenience (operates per-agent at runtime, not stack construction)

---

## What This Feature Enables

### For operators deploying Koi nodes

Previously, standing up a fully observable node required importing and wiring 5+ packages manually. Now it's a single function call with a config object. Enable as much or as little observability as needed:

- **Agent discovery** — Automatically detect external coding agents (Claude, Copilot, etc.) via PATH scanning, filesystem registry, and MCP servers. Discovered agents become available as components on dispatched entities.
- **Agent procfs** — Virtual filesystem for agent introspection. Read agent state, metrics, and configuration at runtime via a `/proc`-like API. Combined with the agent mounter, entries are automatically created/removed as agents join/leave the registry.
- **Distributed tracing** — OpenTelemetry middleware emitting spans for sessions, turns, model calls, and tool calls. Zero-cost when no TracerProvider is registered.
- **Debug** — Runtime breakpoints, step/pause, and inspection (re-exported for convenience; attach per-agent at runtime).

### For gateway operators

`@koi/gateway-stack` now optionally wraps outbound Nexus HTTP calls with W3C trace context propagation. When `tracing` config is provided, all Nexus RPC calls carry `traceparent`/`tracestate` headers, enabling end-to-end distributed traces across gateway → Nexus → node.

---

## Architecture

`@koi/node-stack` is an **L3 meta-package** — it composes L2 packages with zero new logic.

```
┌──────────────────────────────────────────────────────┐
│  @koi/node-stack  (L3)                               │
│                                                      │
│  types.ts              ← NodeStackConfig/Deps        │
│  create-node-stack.ts  ← main factory                │
│  index.ts              ← public API surface          │
│                                                      │
├──────────────────────────────────────────────────────┤
│  Dependencies                                        │
│                                                      │
│  @koi/node             (L2)  core node runtime       │
│  @koi/agent-discovery  (L2)  external agent scanning │
│  @koi/agent-procfs     (L2)  virtual /proc fs        │
│  @koi/tracing          (L2)  OTel middleware          │
│  @koi/debug            (L2)  runtime debugging       │
│  @koi/core             (L0)  Result, KoiError        │
└──────────────────────────────────────────────────────┘
```

### Wiring sequence

1. `createNode(config.node, deps)` — validates and creates the node
2. If `config.discovery` — `createDiscoveryProvider()` → `ComponentProvider`
3. If `config.procfs` — `createProcFs()` → `ProcFs`
   - If also `deps.registry` AND `node.mode === "full"` → `createAgentMounter()` (auto-mount/unmount agents)
4. If `config.tracing` — `createTracingMiddleware()` → `KoiMiddleware`
5. Return `NodeStack` with unified `start()`/`stop()`

---

## Quick Start

```typescript
import { createNodeStack } from "@koi/node-stack";

const stack = createNodeStack(
  {
    node: { gateway: "ws://gateway:8080", mode: "full" },
    discovery: { cacheTtlMs: 30_000 },    // omit to disable
    procfs: { cacheTtlMs: 1_000 },         // omit to disable
    tracing: { serviceName: "koi-node" },  // omit to disable
  },
  { registry },  // optional — enables agent mounter when procfs is configured
);

await stack.start();

// Access subsystems directly
stack.node;               // KoiNode — dispatch agents, resolve tools
stack.discoveryProvider;  // ComponentProvider | undefined
stack.procFs;             // ProcFs | undefined — read("/agents/foo/state")
stack.tracingMiddleware;  // KoiMiddleware | undefined — attach to engine

// Debug is used per-agent, not per-stack
import { createDebugAttach } from "@koi/node-stack";
const debug = createDebugAttach({ agent, session });

await stack.stop();  // disposes mounter, then stops node
```

### Gateway-side tracing

```typescript
import { createGatewayStack } from "@koi/gateway-stack";

const stack = createGatewayStack(
  {
    gateway: {},
    nexus: { nexusUrl: "http://nexus:2026", apiKey: "key" },
    tracing: {},  // enables traced fetch on Nexus HTTP calls
  },
  deps,
);
```

---

## Key Types

| Type | Purpose |
|------|---------|
| `NodeStackConfig` | Combined config: node + optional discovery + procfs + tracing |
| `NodeStackDeps` | Core node deps + optional registry for agent mounting |
| `NodeStack` | Return type — node + subsystem handles + start/stop |

---

## Re-exports

All public APIs from bundled packages are re-exported for single-import convenience:

| Package | Re-exported |
|---------|-------------|
| `@koi/node` | `KoiNode`, `FullKoiNode`, `ThinKoiNode`, `NodeDeps` types |
| `@koi/agent-discovery` | `DiscoveryProviderConfig` type, `createDiscoveryProvider` |
| `@koi/agent-procfs` | `ProcFsConfig`, `AgentMounterConfig` types, `createProcFs`, `createAgentMounter` |
| `@koi/debug` | `DebugAttachConfig`, `DebugAttachResult` types, `createDebugAttach`, `createDebugObserve`, `clearAllDebugSessions`, `hasDebugSession` |
| `@koi/tracing` | `TracingConfig` type, `createTracingMiddleware`, `createTracedFetch` |
