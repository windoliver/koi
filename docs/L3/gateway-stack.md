# @koi/gateway-stack — Full Gateway Bundle

Convenience package that wires `@koi/gateway` + `@koi/gateway-canvas` + `@koi/gateway-webhook` into a single `createGatewayStack()` call with unified start/stop lifecycle.

---

## Why It Exists

After splitting the gateway into focused packages (#718), consumers who want the full gateway experience need three imports and manual wiring. This L3 bundle provides:

- **One-call setup** — `createGatewayStack()` creates and connects all subsystems
- **Unified lifecycle** — `start()` boots gateway + canvas + webhook; `stop()` tears them all down
- **Optional subsystems** — Omit `canvas` or `webhook` from config to disable them
- **HA via Nexus** — Add `nexus` config to persist state across instances with automatic failover
- **Direct access** — All subsystem handles remain accessible for advanced use

---

## Architecture

`@koi/gateway-stack` is an **L3 meta-package** — it composes L2 packages with zero new logic.

```
┌──────────────────────────────────────────────────────┐
│  @koi/gateway-stack  (L3)                            │
│                                                      │
│  types.ts                ← GatewayStackConfig/Deps   │
│  create-gateway-stack.ts ← main factory              │
│  index.ts                ← public API surface        │
│                                                      │
├──────────────────────────────────────────────────────┤
│  Dependencies                                        │
│                                                      │
│  @koi/gateway        (L2)  core gateway              │
│  @koi/gateway-canvas (L2)  canvas subsystem          │
│  @koi/gateway-webhook(L2)  webhook subsystem         │
│  @koi/gateway-nexus  (L2)  Nexus HA state (optional) │
│  @koi/gateway-types  (L0u) shared types              │
│  @koi/nexus-client   (L0u) Nexus JSON-RPC client     │
│  @koi/core           (L0)  Result, KoiError          │
└──────────────────────────────────────────────────────┘
```

---

## Quick Start

```typescript
import { createGatewayStack } from "@koi/gateway-stack";
import { createHttpTransport } from "@koi/nexus-client";

const stack = createGatewayStack(
  {
    gateway: { maxConnections: 5_000 },
    canvas: { port: 8081 },                // omit to disable canvas
    webhook: { port: 8082, pathPrefix: "/webhook" }, // omit to disable webhook
    nexus: { instanceId: "gateway-1" },    // omit for in-memory (single instance)
  },
  {
    transport,
    auth,
    canvasAuth,
    webhookDispatcher,
    nexusTransport: createHttpTransport({ url: "http://nexus:3100" }),
  },
);

await stack.start(8080);

// Aggregated health
const h = await stack.health();   // { status, gateway, nexus, components }

// Access subsystems directly
stack.gateway.onFrame("my-agent", (session, frame) => { /* ... */ });
stack.canvas?.store.get("my-surface");

await stack.stop();
```

### Health endpoint

`stack.healthHandler(req)` returns a `Response` you can wire into any HTTP route. The handler reports:

- `status: "ok" | "degraded"` — `degraded` if Nexus is configured and currently in degraded mode
- `gateway.activeConnections` — live transport-attached sessions
- `nexus.mode` — `"healthy" | "degraded" | undefined` (omitted when Nexus is not configured)
- `components` — per-subsystem (`gateway`, `canvas`, `webhook`, `nexus`) start state

---

## Key Types

| Type | Purpose |
|------|---------|
| `GatewayStackConfig` | Combined config: gateway + optional canvas + webhook + nexus |
| `GatewayStackDeps` | Core gateway deps + optional canvas auth + webhook dispatcher + nexus transport |
| `GatewayStack` | Return type — gateway + canvas + webhook + nexus handle + start/stop + health |
| `GatewayStackHealth` | Aggregated health: status, gateway, nexus, per-component |
