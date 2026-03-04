# @koi/gateway-canvas — Canvas HTTP Server & SSE

Real-time surface rendering subsystem for Koi agents. Provides HTTP REST endpoints for creating, reading, updating, and deleting surfaces (HTML/JSON content), plus Server-Sent Events (SSE) for live update streaming. ETag-based CAS prevents stale overwrites.

---

## Why It Exists

Koi agents generate visual content (HTML dashboards, reports, live status pages). This content needs to be:

- **Stored** — Agents POST content to named surfaces via REST API
- **Read** — Clients GET surfaces by ID, with If-None-Match caching
- **Updated atomically** — ETag-based CAS prevents lost updates when multiple agents write
- **Streamed in real-time** — SSE delivers update/delete events to subscribed clients
- **Independently deployable** — Canvas can run on a different port or be disabled entirely

Previously embedded in `@koi/gateway`, it was tightly coupled to the core gateway lifecycle. Extracting it enables independent development, testing, and optional deployment.

---

## Architecture

`@koi/gateway-canvas` is an **L2 feature package** — depends only on `@koi/core` (L0).

```
┌──────────────────────────────────────────────────┐
│  @koi/gateway-canvas  (L2)                       │
│                                                  │
│  canvas.ts          ← factory: createCanvas()    │
│  canvas-routes.ts   ← HTTP server + REST routes  │
│  canvas-sse.ts      ← SSE manager + keep-alive   │
│  canvas-store.ts    ← in-memory surface store    │
│  http-helpers.ts    ← JSON response, body parse  │
│  index.ts           ← public API surface         │
│                                                  │
├──────────────────────────────────────────────────┤
│  Dependencies                                    │
│                                                  │
│  @koi/core (L0)   Result, KoiError               │
└──────────────────────────────────────────────────┘
```

---

## Quick Start

```typescript
import { createCanvas } from "@koi/gateway-canvas";
import type { CanvasAuthenticator } from "@koi/gateway-canvas";

// Optional: authenticate write requests
const auth: CanvasAuthenticator = async (req) => {
  const token = req.headers.get("Authorization");
  if (!token) return { ok: false, error: { code: "PERMISSION", message: "Unauthorized", retryable: false } };
  return { ok: true, value: { agentId: "my-agent" } };
};

const canvas = createCanvas({ port: 8081 }, auth);
await canvas.server.start();

// POST /gateway/canvas/:surfaceId  — create surface
// GET  /gateway/canvas/:surfaceId  — read surface
// PATCH /gateway/canvas/:surfaceId — update (supports If-Match CAS)
// DELETE /gateway/canvas/:surfaceId — delete
// GET /gateway/canvas/:surfaceId/events — SSE stream
```

---

## Key Types

| Type | Purpose |
|------|---------|
| `CanvasConfig` | Port, path prefix, max surfaces, SSE limits |
| `CanvasWiring` | Return type of `createCanvas()` — server + sse + store |
| `CanvasServer` | HTTP server with start/stop/port |
| `CanvasSseManager` | Manages SSE subscriptions per surface |
| `SurfaceStore` | In-memory surface storage with hash-based ETags |

---

## REST API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/:surfaceId` | Required | Create surface, returns 201 + ETag |
| `GET` | `/:surfaceId` | Public | Read surface, supports If-None-Match (304) |
| `PATCH` | `/:surfaceId` | Required | Update surface, supports If-Match CAS (412 on conflict) |
| `DELETE` | `/:surfaceId` | Required | Delete surface, returns 204 |
| `GET` | `/:surfaceId/events` | Public | SSE stream for real-time updates |
