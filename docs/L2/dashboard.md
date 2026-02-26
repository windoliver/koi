# @koi/dashboard — Web UI for Managing Agents, Skills, and Channels

Live web dashboard at `localhost:<port>/dashboard` for non-developer users to monitor and manage Koi agents without touching YAML or CLI. Ships as three packages: `@koi/dashboard-types` (shared contracts), `@koi/dashboard-api` (HTTP + SSE server), and `@koi/dashboard-ui` (React SPA). Embeds into any `Bun.serve()` via a single `createDashboardHandler()` call — no separate process needed.

---

## Why It Exists

Koi has 90+ backend packages but zero frontend. Operators managing agents today must use the CLI or edit YAML manifests directly. This works for developers but blocks non-technical users — product managers, support teams, or anyone who wants to see "what are my agents doing right now?" without opening a terminal.

The dashboard provides a real-time agent status grid with SSE-based live updates, REST endpoints for agent data, and a React UI that renders agent state as visual cards. It is the foundation for Phase 2-4 features: chat interaction, cost tracking, scheduling, and full agent lifecycle management.

---

## Architecture

### Three Packages

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  @koi/dashboard-types  (L0u)                                     │
│  Shared contracts: event types, data source interface, config    │
│  Depends on: @koi/core only                                     │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  @koi/dashboard-api  (L2)                                        │
│  HTTP handler: REST routes, SSE producer, static file serving   │
│  Depends on: @koi/core, @koi/dashboard-types                    │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  @koi/dashboard-ui  (L2)                                         │
│  React SPA: agent grid, SSE client, Zustand stores              │
│  Depends on: @koi/dashboard-types only                           │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

Key constraint: `dashboard-api` does NOT import `dashboard-ui`. The built SPA assets are served from a directory path injected via `assetsDir` config at application level.

### Layer Position

```
L0  @koi/core ──────────────────────────────────────────────┐
    types + contracts only, zero deps                        │
                                                             │
L0u @koi/dashboard-types ────────────────────────┐          │
    event unions, DashboardDataSource interface   │          │
                                                  ▼          ▼
L2  @koi/dashboard-api ◄─────────────────────────┴──────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages

L2  @koi/dashboard-ui ◄──────────────────────────┘
    imports from @koi/dashboard-types only
    ✗ no @koi/core, no @koi/engine, no peer L2
```

### Internal Module Map

```
packages/dashboard-types/src/
  index.ts              ← barrel exports
  events.ts             ← DashboardEvent discriminated union + type guards
  data-source.ts        ← DashboardDataSource adapter interface
  rest-types.ts         ← ApiResult<T> response envelope
  config.ts             ← DashboardConfig + DEFAULT_DASHBOARD_CONFIG

packages/dashboard-api/src/
  index.ts              ← public API surface
  handler.ts            ← createDashboardHandler() factory
  router.ts             ← URL pattern matching + method dispatch
  static-serve.ts       ← content-hashed asset serving
  middleware/
    cors.ts             ← CORS header injection
    error-handler.ts    ← catch-all JSON error envelope (no stack leaks)
  routes/
    health.ts           ← GET /api/health
    agents.ts           ← GET /api/agents, GET /api/agents/:id, POST /terminate
    channels.ts         ← GET /api/channels
    skills.ts           ← GET /api/skills
    metrics.ts          ← GET /api/metrics
  sse/
    encoder.ts          ← SSE wire format: data frames, keepalives, ID frames
    producer.ts         ← createSseProducer(): connection pool + 100ms batching

packages/dashboard-ui/src/
  main.tsx              ← React root mount
  app.tsx               ← Router + QueryClientProvider + layout
  lib/
    api-client.ts       ← typed fetch wrapper for REST endpoints
    sse-client.ts       ← EventSource wrapper + auto-reconnect
    format.ts           ← duration/bytes/date formatters
  stores/
    agents-store.ts     ← Zustand: agent state map + per-agent selectors
    connection-store.ts ← Zustand: SSE connection status
  hooks/
    use-agents.ts       ← TanStack Query: REST fetch + SSE invalidation
    use-sse.ts          ← EventSource → Zustand dispatch bridge
  pages/
    agents-page.tsx     ← responsive agent card grid
  components/
    layout/             ← sidebar, header, page shell
    agents/             ← agent-card, agent-status-badge
    shared/             ← loading skeleton, error boundary, empty state
```

---

## Data Flow

### Full Pipeline

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser: localhost:3000/dashboard                                │
│                                                                  │
│  React UI                                                        │
│  ┌────────────┐   ┌────────────┐   ┌──────────────────────────┐ │
│  │ Zustand    │◄──│ use-sse.ts │◄──│ EventSource /api/events  │ │
│  │ agents     │   │ hook       │   │ (auto-reconnect)         │ │
│  │ store      │   └────────────┘   └──────────────────────────┘ │
│  │            │                                                  │
│  │            │◄── TanStack Query ◄── fetch /api/agents          │
│  └─────┬──────┘   (30s fallback poll)                            │
│        │                                                         │
│  ┌─────▼──────┐                                                  │
│  │ Agent Grid │  ← re-renders only changed cards via selectors   │
│  └────────────┘                                                  │
└──────────────────────────────────────────────────────────────────┘
         │                          ▲
         │ REST requests            │ SSE stream (100ms batches)
         ▼                          │
┌──────────────────────────────────────────────────────────────────┐
│  Bun.serve()                                                     │
│                                                                  │
│  createDashboardHandler(dataSource, config)                      │
│  ┌────────────┐  ┌────────────┐  ┌──────────────────────────┐  │
│  │ REST routes │  │ SSE        │  │ Static file server       │  │
│  │ /api/*     │  │ producer   │  │ /dashboard/*             │  │
│  └──────┬─────┘  └─────┬──────┘  └──────────────────────────┘  │
│         │              │                                         │
│         └──────┬───────┘                                         │
│                │                                                 │
│         DashboardDataSource (adapter interface)                  │
│                │                                                 │
└────────────────┼─────────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────────┐
│  Your Application                                                │
│                                                                  │
│  AgentHost / custom backend                                      │
│  ┌────────┐  ┌────────┐  ┌────────┐                            │
│  │Agent A │  │Agent B │  │Agent C │                            │
│  └────┬───┘  └────┬───┘  └────┬───┘                            │
│       └───────────┼───────────┘                                  │
│                   ▼                                              │
│            Anthropic / OpenAI API                                 │
└──────────────────────────────────────────────────────────────────┘
```

### SSE Event Timeline

A typical SSE session:

```
Browser                          Dashboard API                    Application
  │                                 │                                │
  │  GET /api/events                │                                │
  │ ───────────────────────────────>│                                │
  │                                 │                                │
  │  :keepalive                     │   (initial flush to unblock)   │
  │ <───────────────────────────────│                                │
  │                                 │                                │
  │                                 │   subscribe(listener)          │
  │                                 │ <──────────────────────────────│
  │                                 │                                │
  │                                 │   event: agent dispatched      │
  │                                 │ <──────────────────────────────│
  │                                 │   (buffered for ≤100ms)        │
  │                                 │                                │
  │  id: 1                          │                                │
  │  data: {"events":[...],"seq":1} │   batch flush                  │
  │ <───────────────────────────────│                                │
  │                                 │                                │
  │  :keepalive                     │   (every 15s if idle)          │
  │ <───────────────────────────────│                                │
  │                                 │                                │
  │       (client disconnects)      │                                │
  │ ─── AbortSignal fires ────────>│   auto-cleanup connection      │
```

---

## REST API

All endpoints return `ApiResult<T>`:

```typescript
type ApiResult<T> =
  | { readonly ok: true;  readonly data: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };
```

| Method | Path | Description | Response data |
|--------|------|-------------|---------------|
| GET | `/dashboard/api/health` | Liveness check | `{ status: "ok", uptimeMs }` |
| GET | `/dashboard/api/agents` | List all agents | `DashboardAgentSummary[]` |
| GET | `/dashboard/api/agents/:id` | Agent detail | `DashboardAgentDetail` |
| POST | `/dashboard/api/agents/:id/terminate` | Terminate agent | `void` |
| GET | `/dashboard/api/channels` | List channels | `DashboardChannelSummary[]` |
| GET | `/dashboard/api/skills` | List skills | `DashboardSkillSummary[]` |
| GET | `/dashboard/api/metrics` | System metrics | `DashboardSystemMetrics` |
| GET | `/dashboard/api/events` | SSE stream | `text/event-stream` |

Error responses never leak stack traces — all unhandled errors return generic `"Internal server error"`.

---

## DashboardEvent Schema

Events use namespaced discriminated unions with `kind` + `subKind`:

```
DashboardEvent
├── AgentDashboardEvent     (kind: "agent")
│   ├── status_changed      { from: ProcessState, to: ProcessState }
│   ├── dispatched          { name, agentType }
│   ├── terminated          { reason? }
│   └── metrics_updated     { turns, tokenCount }
│
├── SkillDashboardEvent     (kind: "skill")
│   ├── installed           { name }
│   └── removed             { name }
│
├── ChannelDashboardEvent   (kind: "channel")
│   ├── connected           { channelId, channelType }
│   ├── disconnected        { channelId }
│   └── message_received    { channelId, agentId }
│
└── SystemDashboardEvent    (kind: "system")
    ├── memory_warning      { heapUsedMb, heapLimitMb }
    ├── error               { message }
    └── activity            { message }
```

Events are batched into `DashboardEventBatch`:

```typescript
interface DashboardEventBatch {
  readonly events: readonly DashboardEvent[];
  readonly seq: number;       // monotonic — detect gaps on reconnect
  readonly timestamp: number;
}
```

---

## DashboardDataSource

The adapter interface that bridges your application to the dashboard. All methods return `T | Promise<T>` for sync or async implementations:

```typescript
interface DashboardDataSource {
  readonly listAgents:      () => readonly DashboardAgentSummary[] | Promise<...>;
  readonly getAgent:        (agentId: AgentId) => DashboardAgentDetail | undefined | Promise<...>;
  readonly terminateAgent:  (agentId: AgentId) => Result<void, KoiError> | Promise<...>;
  readonly listChannels:    () => readonly DashboardChannelSummary[] | Promise<...>;
  readonly listSkills:      () => readonly DashboardSkillSummary[] | Promise<...>;
  readonly getSystemMetrics:() => DashboardSystemMetrics | Promise<...>;
  readonly subscribe:       (listener: (event: DashboardEvent) => void) => () => void;
}
```

You implement this interface to bridge whatever manages your agents (e.g., `AgentHost` from `@koi/node`) to dashboard types. The dashboard never imports your application code — it only sees this interface.

---

## SSE Producer Design

```
┌────────────────────────────────────────────────────────┐
│  createSseProducer(dataSource, config)                  │
│                                                        │
│  dataSource.subscribe() ──► event buffer (in-memory)   │
│                               │                        │
│                    ┌──────────┼──────────┐             │
│                    │  100ms   │  flush   │             │
│                    │  timer   ▼  timer   │             │
│                    │   DashboardEventBatch              │
│                    │   { events, seq, timestamp }       │
│                    └──────────┬──────────┘             │
│                               │                        │
│                    ┌──────────▼──────────┐             │
│                    │  broadcast to all   │             │
│                    │  connected writers  │             │
│                    └─────────────────────┘             │
│                                                        │
│  Connections: Map<writer, signal>                       │
│  - Max enforced (503 when full)                        │
│  - Auto-pruned on AbortSignal                          │
│  - Keepalive every 15s                                 │
│  - Buffer skipped when 0 connections                   │
│  - Initial keepalive on connect (unblocks fetch())     │
└────────────────────────────────────────────────────────┘
```

---

## Static Asset Serving

```
Request: GET /dashboard/assets/index-a1b2c3.js
                    │
                    ▼
        ┌───────────────────────┐
        │ Has hash in filename? │
        │ (regex: -[a-f0-9]+)  │
        └───────┬───────┬───────┘
               yes      no
                │        │
                ▼        ▼
  Cache-Control:    Cache-Control:
  max-age=31536000  no-cache
  immutable         (SPA fallback
                     for index.html)
```

Content-type detected by file extension. Missing files return 404. `Bun.file()` used for efficient zero-copy serving.

---

## Quick Start

### Embedding in Your Server

```typescript
import { createDashboardHandler } from "@koi/dashboard-api";
import { resolve } from "node:path";

// 1. Create your DashboardDataSource adapter
const dataSource = createYourAdapter(agentHost);

// 2. Create the dashboard handler
const { handler, dispose } = createDashboardHandler(dataSource, {
  basePath: "/dashboard",
  apiPath: "/dashboard/api",
  assetsDir: resolve(import.meta.dir, "../../dashboard-ui/dist"),
  sseBatchIntervalMs: 100,
  maxSseConnections: 50,
});

// 3. Mount in Bun.serve
Bun.serve({
  port: 3000,
  fetch: async (req) =>
    (await handler(req)) ?? new Response("Not found", { status: 404 }),
});

// 4. Cleanup on shutdown
process.on("SIGINT", dispose);
```

### Implementing DashboardDataSource

```typescript
import type { DashboardDataSource, DashboardEvent } from "@koi/dashboard-types";

function createMyAdapter(host: AgentHost): DashboardDataSource {
  let listeners: ((event: DashboardEvent) => void)[] = [];

  return {
    listAgents: () => host.list().map(mapToSummary),
    getAgent: (id) => {
      const agent = host.get(id);
      return agent !== undefined ? mapToDetail(agent) : undefined;
    },
    terminateAgent: (id) => host.terminate(id),
    listChannels: () => [],
    listSkills: () => [],
    getSystemMetrics: () => ({
      uptimeMs: Date.now() - startMs,
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      activeAgents: host.capacity().current,
      totalAgents: host.capacity().current,
      activeChannels: 0,
    }),
    subscribe: (listener) => {
      listeners = [...listeners, listener];
      return () => { listeners = listeners.filter((l) => l !== listener); };
    },
  };
}
```

---

## Configuration

```typescript
interface DashboardConfig {
  readonly basePath?: string;           // default: "/dashboard"
  readonly apiPath?: string;            // default: "/dashboard/api"
  readonly assetsDir?: string;          // path to built dashboard-ui dist/
  readonly sseBatchIntervalMs?: number; // default: 100
  readonly maxSseConnections?: number;  // default: 50
  readonly cors?: boolean;              // default: false
}
```

---

## UI State Architecture

```
┌─────────────────────────────────────────────────┐
│  React Component Tree                            │
│                                                  │
│  App                                             │
│  ├── QueryClientProvider (TanStack Query)         │
│  │   └── AgentsPage                              │
│  │       └── AgentCard[] ◄── useAgentById(id)    │
│  │                           (Zustand selector)  │
│  └── useSSE() hook                               │
│      │                                           │
│      ├── EventSource → parse DashboardEventBatch │
│      ├── agent events → agentsStore.updateAgent() │
│      └── any event → queryClient.invalidate()    │
└─────────────────────────────────────────────────┘

Data sources:
  Primary:   SSE stream → Zustand store (real-time, <200ms)
  Fallback:  TanStack Query polling every 30s (catches missed events)
  Initial:   REST fetch on mount → populates both store + cache
```

---

## What the Dashboard Looks Like (Phase 1)

```
┌──────────────────────────────────────────────────────────────────┐
│  Koi Dashboard                                            ● Live │
│                                                                  │
│  ┌──────────┐  ┌──────────────────────────────────────────────┐  │
│  │ Sidebar   │  │  Agents                                     │  │
│  │           │  │                                              │  │
│  │ > Agents  │  │  ┌──────────────┐ ┌──────────────┐          │  │
│  │   Channels│  │  │ research-bot │ │ code-writer  │          │  │
│  │   Skills  │  │  │ ● running    │ │ ● running    │          │  │
│  │   Metrics │  │  │ copilot      │ │ worker       │          │  │
│  │           │  │  │ haiku-4.5    │ │ sonnet-4.5   │          │  │
│  │           │  │  │ 12 turns     │ │ 3 turns      │          │  │
│  │           │  │  │ 2m ago       │ │ just now     │          │  │
│  │           │  │  │ [Terminate]  │ │ [Terminate]  │          │  │
│  │           │  │  └──────────────┘ └──────────────┘          │  │
│  │           │  │                                              │  │
│  │           │  │  System: 2 agents │ 42MB heap │ up 1h 23m   │  │
│  └──────────┘  └──────────────────────────────────────────────┘  │
│  ● Connected (SSE)                                               │
└──────────────────────────────────────────────────────────────────┘
```

---

## Phase Roadmap

| Phase | Status | Scope |
|-------|--------|-------|
| **1** | Done | Agent status grid, SSE streaming, REST API, static serving |
| **2** | [#429](https://github.com/windoliver/koi/issues/429) | Agent creation, chat interaction, authentication |
| **3** | [#430](https://github.com/windoliver/koi/issues/430) | Cost tracking, log streaming, conversation history |
| **4** | [#431](https://github.com/windoliver/koi/issues/431) | Cron UI, config editing, approvals, skills management |

---

## Comparison with Alternatives

| Aspect | Koi Dashboard | OpenClaw Control UI | NanoClaw |
|--------|--------------|--------------------|----|
| Framework | React 19 + shadcn | Vite + Lit | None |
| Transport | SSE (100ms batch) | WebSocket RPC | N/A |
| Serving | Embedded handler | Embedded in Gateway | No dashboard |
| Data access | Injected adapter | Hardwired to Gateway | "Ask Claude" |
| Type safety | Discriminated unions | Runtime validation | N/A |

---

## Security Notes

- Error responses never leak stack traces or internal messages
- SSE events contain no secrets (agent IDs, names, states only)
- No authentication in Phase 1 — planned for Phase 2 (#429)
- `DashboardDataSource` is the security boundary — it controls what data the dashboard can access
- CORS disabled by default (`cors: false`)
