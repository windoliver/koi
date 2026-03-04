# @koi/gateway-stack — Full Gateway Bundle

Convenience package that wires `@koi/gateway` + `@koi/gateway-canvas` + `@koi/gateway-webhook` into a single `createGatewayStack()` call with unified start/stop lifecycle.

---

## Why It Exists

After splitting the gateway into focused packages (#718), consumers who want the full gateway experience need three imports and manual wiring. This L3 bundle provides:

- **One-call setup** — `createGatewayStack()` creates and connects all subsystems
- **Unified lifecycle** — `start()` boots gateway + canvas + webhook; `stop()` tears them all down
- **Optional subsystems** — Omit `canvas` or `webhook` from config to disable them
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
│  @koi/gateway-types  (L0u) shared types              │
│  @koi/core           (L0)  Result, KoiError          │
└──────────────────────────────────────────────────────┘
```

---

## Quick Start

```typescript
import { createGatewayStack } from "@koi/gateway-stack";

const stack = createGatewayStack(
  {
    gateway: { maxConnections: 5_000 },
    canvas: { port: 8081 },    // omit to disable canvas
    webhook: { port: 8082 },   // omit to disable webhook
  },
  { transport, auth, canvasAuth, webhookAuth },
);

await stack.start(8080);

// Access subsystems directly
stack.gateway.onFrame((session, frame) => { /* ... */ });
stack.canvas?.store.get("my-surface");
stack.webhook?.port();

await stack.stop();
```

---

## Key Types

| Type | Purpose |
|------|---------|
| `GatewayStackConfig` | Combined config: gateway + optional canvas + optional webhook |
| `GatewayStackDeps` | Core gateway deps + optional canvas/webhook authenticators |
| `GatewayStack` | Return type — gateway + canvas + webhook + start/stop |
