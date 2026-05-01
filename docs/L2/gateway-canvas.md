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

All operations are authenticated and tenant-scoped — surfaces are private to
the agent that created them. Non-owner access (read, write, subscribe) returns
404 (not 403) so existence is not leaked across tenants.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/:surfaceId` | Required | Create surface, stamps `ownerId` from auth, returns 201 + ETag |
| `GET` | `/:surfaceId` | Owner | Read surface, supports If-None-Match (304); 404 to non-owners |
| `PATCH` | `/:surfaceId` | Owner | Update surface; `If-Match` is **required** (428 if missing, 412 if stale) |
| `DELETE` | `/:surfaceId` | Owner | Delete surface, returns 204 |
| `GET` | `/:surfaceId/events` | Owner | SSE stream for real-time updates; 404 to non-owners |

Status semantics:
- `401` — caller missing/invalid credentials.
- `404` — surface does not exist OR caller is not its owner (no existence leak).
- `412` — `If-Match` mismatch (stale ETag).
- `428` — `If-Match` required but absent (PATCH must fence against a specific generation).
- `503` — retryable failure: store at capacity (`Retry-After: 30`), SSE saturated (`Retry-After: 5`), or auth backend unavailable (`Retry-After: 5`).
