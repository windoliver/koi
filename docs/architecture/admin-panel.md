# Koi Admin Panel — Implementation Plan (v2)

> **Core principle:** The admin panel IS a Nexus browser with typed viewers.
> Every domain (agents, forge, sessions, memory, events) is a path projection over the Nexus namespace — not a separate backend.
> Reference: [nexi-lab/nexus-frontend](https://github.com/nexi-lab/nexus-frontend).

---

## Table of Contents

1. [Architecture Shift: Why v2](#1-architecture-shift-why-v2)
2. [Prerequisite: Freeze Namespace Contract](#2-prerequisite-freeze-namespace-contract)
3. [Core Architecture](#3-core-architecture)
4. [The Nexus Browser](#4-the-nexus-browser)
5. [Typed Viewers](#5-typed-viewers)
6. [Saved Views (Path Projections)](#6-saved-views-path-projections)
7. [Non-File Controls (Commands)](#7-non-file-controls-commands)
8. [Orchestration Overlay](#8-orchestration-overlay)
9. [Data Layer](#9-data-layer)
10. [SSE Events](#10-sse-events)
11. [Component Library](#11-component-library)
12. [Package Structure](#12-package-structure)
13. [Implementation Phases](#13-implementation-phases)
14. [Embed Mode Constraints](#14-embed-mode-constraints)
15. [Open Questions](#15-open-questions)

---

## 1. Architecture Shift: Why v2

v1 of this plan (reviewed by Codex) had a structural flaw: it treated the Nexus namespace as one page (`/nexus`) among ten independent pages, each with its own backend data source. Codex identified five issues:

| # | Issue | Fix |
|---|-------|-----|
| 1 | Nexus is not just one page — "everything is a file" means the namespace IS the UI | Make the Nexus browser the shell, not a feature |
| 2 | /agents, /forge, /sessions, /memory should be typed projections over namespace paths | Saved views = filtered tree + typed viewer, not separate backends |
| 3 | Namespace contract mismatch between PACKAGES.md, paths.ts, and namespace.ts | Freeze contract first (section 2) |
| 4 | Use `@koi/filesystem-nexus` (read/write/edit/list/search/delete/rename + boundary checks), not raw `@koi/nexus-client` | filesystem-nexus is the data layer |
| 5 | Agent lifecycle controls (suspend/resume/terminate) are imperative, not file-backed | Keep as command endpoints, don't fake as namespace writes |

**The shift:** Instead of 10 pages with 12 data source interfaces, the admin panel is:

```
┌─ Nexus Browser (the shell) ─────────────────────────────────┐
│                                                              │
│  File Tree  +  Typed Viewer Router  +  Saved Views           │
│  (all paths)   (path → component)     (filtered projections) │
│                                                              │
│  + Command Bar (non-file operations)                         │
│  + Orchestration Overlay (Temporal/Scheduler/Harness/DAG)    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Prerequisite: Freeze Namespace Contract

**Before any UI work**, reconcile the three sources of truth:

### Current Mismatch

| Domain | PACKAGES.md (doc) | paths.ts (client) | namespace.ts (provisioning) |
|--------|-------------------|--------------------|-----------------------------|
| Forge | `/agents/{id}/bricks/` | `agents/{id}/bricks/{brickId}.json` | `/agents/{id}/forge/bricks` |
| Session | `/agents/{id}/session/record.json` | `agents/{id}/session/record.json` | `/agents/{id}/sessions` |
| Events | `/agents/{id}/events/` | `agents/{id}/events/{streamId}/...` | `/agents/{id}/events` |
| Memory | `/agents/{id}/memory/entities/` | `agents/{id}/memory/entities/{slug}.json` | `/agents/{id}/memory` |
| Snapshots | `/agents/{id}/snapshots/` | `agents/{id}/snapshots/{chainId}/...` | `/agents/{id}/snapshots` |
| Workspace | (not in doc) | (not in paths.ts) | `/agents/{id}/workspace` |
| Mailbox | `/agents/{id}/mailbox/` | (not in paths.ts) | `/agents/{id}/mailbox` |

### Conflicts to Resolve

1. **Forge path prefix**: `paths.ts` uses `agents/{id}/bricks/` (flat). `namespace.ts` uses `/agents/{id}/forge/bricks` (nested under `forge/`). The typed store (`nexus-store/forge.ts`) takes a configurable `basePath` — either works, but they must agree.

2. **Session singular vs plural**: `paths.ts` uses `session/record.json` (singular). `namespace.ts` uses `sessions` (plural). The typed store (`nexus-store/session.ts`) uses `{basePath}/records/{sessionId}.json`.

3. **Workspace and mailbox**: Present in `namespace.ts` but missing from both `PACKAGES.md` and `paths.ts`.

### Resolution Steps

- [ ] Pick canonical paths — recommend aligning `namespace.ts` to `paths.ts` since `paths.ts` is the L0u client contract that all backends import
- [ ] Update `namespace.ts` to use canonical paths
- [ ] Update `PACKAGES.md` section (lines 901-957) to match
- [ ] Add workspace and mailbox to `paths.ts`
- [ ] Run `namespace.test.ts` to verify provisioning produces the canonical paths
- [ ] Update any typed stores (`nexus-store/*.ts`) whose `basePath` defaults conflict

### Proposed Canonical Namespace

> **Important:** This namespace must match what the typed stores (`nexus-store/*.ts`)
> actually produce today. The paths below reflect the CURRENT store implementations,
> not an idealized schema. Any changes require migrating stored data.

```
/agents/{agentId}/
├── bricks/{brickId}.json              ← forge artifacts (ForgeStore basePath)
├── events/
│   ├── streams/{streamId}/            ← NOTE: "streams/" prefix per EventBackend
│   │   ├── meta.json                  ← StreamMeta {maxSequence, eventCount}
│   │   └── events/{seq:10}.json       ← individual events (zero-padded 10-digit)
│   ├── subscriptions/{name}.json      ← subscription position tracking
│   └── dead-letters/{entryId}.json    ← undeliverable events (EventBackend DLQ)
├── session/
│   ├── records/{sessionId}.json       ← NOTE: per-sessionId, NOT single record.json
│   └── pending/{sessionId}/{frameId}.json  ← NOTE: nested under sessionId
├── memory/
│   └── entities/{slug}.json           ← memory entities
├── snapshots/
│   ├── {chainId}/
│   │   ├── meta.json                  ← chain metadata (headNodeId, nodeIds[])
│   │   └── {nodeId}.json              ← snapshot nodes
├── workspace/                         ← agent-scoped filesystem
│   └── ...                            ← user files
└── mailbox/                           ← IPC message queue (NOT file-backed, see below)

/global/
├── bricks/{brickId}.json              ← shared brick artifacts
└── gateway/
    ├── sessions/{id}.json             ← gateway session state
    ├── nodes/{id}.json                ← registered gateway nodes
    └── surfaces/{id}.json             ← gateway surfaces

/groups/{groupId}/
└── scratch/{path}                     ← multi-agent scratchpad
```

**Mailbox caveat:** `/agents/{id}/mailbox/` is provisioned as a directory by
`ensureNamespace()`, but `createNexusMailbox()` is a REST + SSE/polling adapter
with `send()`, `onMessage()`, and `list()` semantics — NOT a filesystem of
`*.json` files. The admin panel must query the mailbox via its adapter API
(or a view endpoint), not via filesystem reads.

---

## 3. Core Architecture

```
┌─ Browser ───────────────────────────────────────────────────────────┐
│                                                                      │
│  Nexus Browser Shell (React 19 SPA)                                  │
│  ├── File Tree (left panel) — all Nexus paths                       │
│  ├── Typed Viewer Router (right panel) — path pattern → component   │
│  ├── Saved Views (sidebar nav) — filtered tree projections           │
│  ├── Command Bar (top) — non-file operations                        │
│  └── Orchestration Overlay (drawer) — Temporal/Scheduler/DAG        │
│                                                                      │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
                 ┌──────────┴──────────┐
                 │ REST + SSE          │ file operations
                 │                     │ command endpoints
                 ▼                     ▼
┌────────────────────────────────────────────────────────────────────┐
│  @koi/dashboard-api (extended)                                      │
│                                                                      │
│  File operations (via @koi/filesystem-nexus):                       │
│    GET  /api/fs/list?path=     → list directory                     │
│    GET  /api/fs/read?path=     → read file content                  │
│    GET  /api/fs/search?q=&p=  → full-text search within path       │
│    DEL  /api/fs/file?path=     → delete file                       │
│                                                                      │
│  Commands (imperative, non-file):                                    │
│    POST /api/cmd/agents/:id/suspend                                  │
│    POST /api/cmd/agents/:id/resume                                   │
│    POST /api/cmd/agents/:id/terminate                                │
│    POST /api/cmd/temporal/workflows/:id/signal                       │
│    POST /api/cmd/temporal/workflows/:id/terminate                    │
│    POST /api/cmd/scheduler/schedules/:id/pause                       │
│    POST /api/cmd/scheduler/schedules/:id/resume                      │
│    POST /api/cmd/scheduler/dlq/:id/retry   (scheduler DLQ)           │
│    POST /api/cmd/events/dlq/:id/retry      (event DLQ — different!)  │
│    POST /api/cmd/mailbox/:agentId/list     (mailbox query via adapter│
│                                                                      │
│  Read-only aggregates (computed, not file-backed):                   │
│    GET  /api/view/agents/tree    → process tree (from engine)       │
│    GET  /api/view/agents/:id/procfs → /proc virtual data            │
│    GET  /api/view/temporal/health → Temporal server status          │
│    GET  /api/view/temporal/workflows → workflow list (Temporal API) │
│    GET  /api/view/scheduler/stats → queue stats (in-memory)         │
│    GET  /api/view/scheduler/tasks → task list (SQLite/heap)         │
│    GET  /api/view/taskboard      → DAG snapshot (in-memory)         │
│    GET  /api/view/harness/status → harness state (in-memory)        │
│    GET  /api/view/gateway/topology → channel connections            │
│    GET  /api/view/middleware/:agentId → middleware chain             │
│    GET  /api/view/system/metrics → heap, uptime, agent counts       │
│                                                                      │
│  SSE: /api/events → real-time event stream (existing)               │
│  Static: /dashboard/* → SPA assets (existing)                       │
│                                                                      │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
                 ┌──────────┴──────────┐
                 │  @koi/filesystem-   │  boundary-checked
                 │  nexus              │  read/write/list/
                 │                     │  search/delete/rename
                 ▼                     ▼
┌────────────────────────────────────────────────────────────────────┐
│  Nexus (JSON-RPC 2.0)                                               │
│  ├── /agents/{id}/ — per-agent namespace (typed stores)             │
│  ├── /global/ — shared resources                                    │
│  └── /groups/{id}/ — multi-agent scratchpad                         │
└────────────────────────────────────────────────────────────────────┘
```

**Three endpoint categories:**

| Category | Purpose | Backed by | Examples |
|----------|---------|-----------|---------|
| **File ops** (`/api/fs/`) | CRUD on Nexus namespace | `@koi/filesystem-nexus` | list, read, search, delete |
| **Commands** (`/api/cmd/`) | Imperative actions not representable as files | Engine registry, Temporal client, Scheduler | suspend, terminate, signal, retry |
| **Views** (`/api/view/`) | Read-only aggregates computed from runtime state | Engine, Temporal, Scheduler, Gateway | process tree, workflow list, queue stats |

---

## 4. The Nexus Browser

The browser is the admin panel shell. Every other "page" is a saved view over this browser.

### Layout

```
┌─── Sidebar ────────┐ ┌─── Breadcrumb + Actions ──────────────────────────┐
│                     │ │ / agents / agent-1 / bricks / search-v3.json     │
│  Saved Views:       │ │ [Refresh] [Search] [Delete]                      │
│  ◆ All Files        │ ├──────────────────────────────────────────────────┤
│  ◆ Agents           │ │                                                  │
│  ◆ Forge            │ │                                                  │
│  ◆ Events           │ │          Typed Viewer                            │
│  ◆ Sessions         │ │          (selected by path pattern)              │
│  ◆ Memory           │ │                                                  │
│  ◆ Workspaces       │ │                                                  │
│  ────────────────── │ │                                                  │
│  ◆ Orchestration    │ │                                                  │
│  ◆ Gateway          │ │                                                  │
│                     │ │                                                  │
│  ┌─ File Tree ────┐ │ │                                                  │
│  │ ▼ /agents/     │ │ │                                                  │
│  │   ▼ agent-1/   │ │ │                                                  │
│  │     ▼ bricks/  │ │ │                                                  │
│  │       search.. │ │ │                                                  │
│  │       parse-.. │ │ │                                                  │
│  │     ▶ events/  │ │ │                                                  │
│  │     ▶ session/ │ │ │                                                  │
│  │     ▶ memory/  │ │ │                                                  │
│  │     ▶ mailbox/ │ │ │                                                  │
│  │   ▶ agent-2/   │ │ │                                                  │
│  │ ▶ /global/     │ │ │                                                  │
│  │ ▶ /groups/     │ │ │                                                  │
│  └────────────────┘ │ │                                                  │
└─────────────────────┘ └──────────────────────────────────────────────────┘

┌─── Status Bar ───────────────────────────────────────────────────────────┐
│ SSE: ● connected │ Agents: 3 running │ Temporal: healthy │ Mode: embed  │
└──────────────────────────────────────────────────────────────────────────┘
```

### File Tree

- Backed by `GET /api/fs/list?path={path}` → filesystem-nexus `list()`
- Lazy-load children on expand (TanStack Query, `staleTime: 30s`)
- Icons by namespace domain:

| Path prefix | Icon | Color |
|-------------|------|-------|
| `/agents/{id}/` (root) | User | colored by ProcessState (green/yellow/orange/red) |
| `bricks/` | Puzzle | purple |
| `events/` | Activity | blue |
| `session/` | Clock | gray |
| `memory/` | Brain | pink |
| `snapshots/` | GitBranch | teal |
| `workspace/` | Folder | default |
| `mailbox/` | Mail | orange |
| `/global/` | Globe | blue |
| `/groups/` | Users | green |

- Right-click context menu via Radix: Open, Copy path, Refresh, Delete (with confirm)
- Keyboard navigation: arrow keys, Enter to expand/open
- Search tab: `GET /api/fs/search?q={query}&path={scopePath}`

### Breadcrumb

- Each segment is clickable → navigates tree to that directory
- Shows full Nexus path
- Action buttons contextual to selected item

---

## 5. Typed Viewers

When a file or directory is selected in the tree, the viewer router selects a component based on path pattern matching. Falls back to raw JSON/text viewer.

### Viewer Router

```typescript
// Path pattern → viewer component mapping
const VIEWER_ROUTES: readonly ViewerRoute[] = [
  // Agent root — show agent overview card
  { pattern: /^\/agents\/([^/]+)\/?$/, viewer: AgentOverviewViewer },

  // Forge bricks
  { pattern: /^\/agents\/[^/]+\/bricks\/[^/]+\.json$/, viewer: BrickViewer },
  { pattern: /^\/agents\/[^/]+\/bricks\/?$/, viewer: BrickListViewer },
  { pattern: /^\/global\/bricks\/[^/]+\.json$/, viewer: BrickViewer },
  { pattern: /^\/global\/bricks\/?$/, viewer: BrickListViewer },

  // Event streams (note: "streams/" prefix per EventBackend contract)
  { pattern: /^\/agents\/[^/]+\/events\/streams\/[^/]+\/meta\.json$/, viewer: EventStreamViewer },
  { pattern: /^\/agents\/[^/]+\/events\/streams\/[^/]+\/events\/\d+\.json$/, viewer: EventDetailViewer },
  { pattern: /^\/agents\/[^/]+\/events\/streams\/?$/, viewer: EventStreamsOverview },
  { pattern: /^\/agents\/[^/]+\/events\/dead-letters\/?$/, viewer: DeadLetterListViewer },
  { pattern: /^\/agents\/[^/]+\/events\/dead-letters\/[^/]+\.json$/, viewer: DeadLetterViewer },
  { pattern: /^\/agents\/[^/]+\/events\/subscriptions\/?$/, viewer: SubscriptionListViewer },
  { pattern: /^\/agents\/[^/]+\/events\/?$/, viewer: EventsOverview },

  // Session (note: per-sessionId records, NOT single record.json)
  { pattern: /^\/agents\/[^/]+\/session\/records\/[^/]+\.json$/, viewer: SessionRecordViewer },
  { pattern: /^\/agents\/[^/]+\/session\/records\/?$/, viewer: SessionListViewer },
  { pattern: /^\/agents\/[^/]+\/session\/pending\/[^/]+\/?$/, viewer: PendingFramesViewer },
  { pattern: /^\/agents\/[^/]+\/session\/?$/, viewer: SessionOverview },

  // Memory
  { pattern: /^\/agents\/[^/]+\/memory\/entities\/[^/]+\.json$/, viewer: MemoryEntityViewer },
  { pattern: /^\/agents\/[^/]+\/memory\/?$/, viewer: MemoryOverview },

  // Snapshots
  { pattern: /^\/agents\/[^/]+\/snapshots\/[^/]+\/meta\.json$/, viewer: SnapshotChainViewer },
  { pattern: /^\/agents\/[^/]+\/snapshots\/[^/]+\/[^/]+\.json$/, viewer: SnapshotNodeViewer },
  { pattern: /^\/agents\/[^/]+\/snapshots\/?$/, viewer: SnapshotChainsOverview },

  // Workspace
  { pattern: /^\/agents\/[^/]+\/workspace\//, viewer: WorkspaceFileViewer },

  // Mailbox (NOT file-backed — uses adapter API via /api/cmd/mailbox/:agentId/list)
  { pattern: /^\/agents\/[^/]+\/mailbox\/?$/, viewer: MailboxViewer },

  // Group scratchpad
  { pattern: /^\/groups\/[^/]+\/scratch\//, viewer: ScratchpadViewer },

  // Gateway
  { pattern: /^\/global\/gateway\/sessions\/[^/]+\.json$/, viewer: GatewaySessionViewer },
  { pattern: /^\/global\/gateway\/nodes\/[^/]+\.json$/, viewer: GatewayNodeViewer },
  { pattern: /^\/global\/gateway\/?$/, viewer: GatewayOverview },

  // Fallbacks
  { pattern: /\.json$/, viewer: JsonViewer },
  { pattern: /\.md$/, viewer: MarkdownViewer },
  { pattern: /.*/, viewer: RawContentViewer },
] as const;
```

### Viewer Specifications

#### AgentOverviewViewer

Shown when selecting `/agents/{id}/` root directory. Combines file data with runtime view data.

```
┌─ Agent: agent-1 ──────────────────────────────────────────────────┐
│                                                                    │
│  State: ● running          Model: claude-sonnet-4-5-20250514              │
│  PID: agent_01HXYZ...      Engine: engine-pi                      │
│  Uptime: 2h 34m            Type: copilot                          │
│  Turns: 47                 Tokens: 124,567 (in: 98k, out: 26k)   │
│                                                                    │
│  ┌─ Namespace Contents ──────────────────────────────────────────┐│
│  │ bricks/    3 files     events/    2 streams                   ││
│  │ session/   1 record    memory/    12 entities                 ││
│  │ snapshots/ 2 chains    workspace/ 8 files                     ││
│  │ mailbox/   0 queued                                           ││
│  └───────────────────────────────────────────────────────────────┘│
│                                                                    │
│  ┌─ Channels ────────────────────────────────────────────────────┐│
│  │ cli (connected)  slack (connected)                            ││
│  └───────────────────────────────────────────────────────────────┘│
│                                                                    │
│  ┌─ Middleware Chain ────────────────────────────────────────────┐│
│  │ permissions(100) → exec-approvals(110) → pay(200) → audit(300││
│  └───────────────────────────────────────────────────────────────┘│
│                                                                    │
│  ┌─ Children ────────────────────────────────────────────────────┐│
│  │ ● worker-1 (running)  ● worker-2 (running)                   ││
│  └───────────────────────────────────────────────────────────────┘│
│                                                                    │
│  [Suspend] [Resume] [Terminate] [View Process Tree]               │
└────────────────────────────────────────────────────────────────────┘
```

Data sources:
- Namespace contents: `GET /api/fs/list?path=/agents/{id}/` (file-backed)
- Runtime state: `GET /api/view/agents/:id/procfs` (computed, not file-backed)
- Middleware chain: `GET /api/view/middleware/:id` (computed)
- Actions: `POST /api/cmd/agents/:id/{action}` (imperative commands)

#### BrickViewer

Shown for any `bricks/{brickId}.json` file. Reads the JSON, renders structured view.

```
┌─ Brick: search-code-v3 ──────────────────────────────────────────┐
│                                                                    │
│  ID: brick_01HXYZ...        Stage: ✅ promoted                    │
│  Created: 3d ago            Author: agent-1                       │
│  Type: tool                 Trust: verified                       │
│                                                                    │
│  ┌─ Verification ──────────────────────────────────────────────┐  │
│  │ Stage 1: syntax      ✅ pass                                │  │
│  │ Stage 2: sandbox     ✅ pass                                │  │
│  │ Stage 3: adversary   ✅ pass                                │  │
│  │ Stage 4: integrity   ✅ SLSA v1.0 attestation               │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌─ Source ────────────────────────────────────────────────────┐   │
│  │ [CodeMirror: TypeScript, read-only, collapsible]           │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                    │
│  ┌─ Raw JSON ─────────────────────────────────────────────────┐   │
│  │ [Toggle: Structured ↔ Raw JSON]                            │   │
│  └─────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
```

Data source: `GET /api/fs/read?path=/agents/{id}/bricks/{brickId}.json` → parse JSON → render. Pure file read, no separate backend needed.

#### EventStreamViewer

Shown for `events/streams/{streamId}/meta.json`. Lists events in the stream chronologically.

```
┌─ Event Stream: stream-001 ─────────────────────────────────────────┐
│                                                                     │
│  Events: 247         Max Sequence: 0000000247                      │
│  Subscriptions: 2    Dead Letters: 1                               │
│                                                                     │
│  ┌─ Event Timeline (newest first) ──────────────────────────────┐  │
│  │ #247  tool_call_end    tool: search_code   2m ago   [expand] │  │
│  │ #246  tool_call_start  tool: search_code   2m ago   [expand] │  │
│  │ #245  text_delta       "Looking at..."     2m ago   [expand] │  │
│  │ #244  model_call       claude-sonnet-4-5-20250514      3m ago   [expand] │  │
│  │ ...                                                           │  │
│  │ [Load more]                                                   │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  Path: /agents/{id}/events/streams/stream-001/events/*.json        │
│  Each event loaded on expand via GET /api/fs/read                  │
└─────────────────────────────────────────────────────────────────────┘
```

Data source: List `events/streams/{streamId}/events/` directory → read individual event files on expand. No separate API needed.

#### DeadLetterListViewer

```
┌─ Dead-Letter Queue (Event DLQ) ────────────────────────────────────┐
│                                                                     │
│  Entry              Error                        Age     [Action]  │
│  dl_abc123.json     "subscriber timeout"         1h ago  [Retry]   │
│  dl_def456.json     "handler threw"              3h ago  [Retry]   │
│                                                                     │
│  Files: /agents/{id}/events/dead-letters/*.json                    │
│  [Retry] = POST /api/cmd/events/dlq/:id/retry                     │
│                                                                     │
│  NOTE: This is the EVENT dead-letter queue (EventBackend.           │
│  retryDeadLetter()), NOT the scheduler DLQ. The scheduler has      │
│  its own DLQ surfaced in the Orchestration overlay.                │
└─────────────────────────────────────────────────────────────────────┘
```

Data source: file list + read. Retry button calls `EventBackend.retryDeadLetter()` via `/api/cmd/events/dlq/:id/retry`.

#### SessionRecordViewer

```
┌─ Session Record ───────────────────────────────────────────────────┐
│                                                                     │
│  Session: session_abc123     Started: 2h ago                       │
│  Turns: 47                   Tokens: 124,567                       │
│  Status: active              Pending Frames: 0                     │
│                                                                     │
│  ┌─ Checkpoint History ─────────────────────────────────────────┐  │
│  │ ──●────────●────────────●──────────●──→                      │  │
│  │   soft     soft         hard       soft                      │  │
│  │   turn 5   turn 10     turn 15    turn 20                    │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─ Raw Record ─────────────────────────────────────────────────┐  │
│  │ [Collapsible JSON viewer]                                    │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

Data source: `GET /api/fs/read?path=/agents/{id}/session/records/{sessionId}.json`
Pending frames: `GET /api/fs/list?path=/agents/{id}/session/pending/{sessionId}/`

#### MemoryEntityViewer

```
┌─ Memory Entity: user-preferences ──────────────────────────────────┐
│                                                                     │
│  Category: preference       Score: 0.92                            │
│  Last Accessed: 2m ago      Tokens: 45                             │
│                                                                     │
│  Content:                                                          │
│  "User prefers TypeScript with strict mode. Uses Result<T,E>       │
│   pattern for error handling. Avoids classes."                     │
│                                                                     │
│  ┌─ Raw JSON ──────────────────────────────────────────────────┐   │
│  │ [Collapsible]                                               │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

Data source: `GET /api/fs/read?path=/agents/{id}/memory/entities/{slug}.json`

#### SnapshotChainViewer

Shown for `snapshots/{chainId}/meta.json`. Renders the chain as a DAG.

```
┌─ Snapshot Chain: chain-001 ────────────────────────────────────────┐
│                                                                     │
│  Head: node_xyz789          Nodes: 5                               │
│                                                                     │
│  ┌─ Version DAG (React Flow) ──────────────────────────────────┐  │
│  │                                                              │  │
│  │  [node_1] ──→ [node_2] ──→ [node_3] ──→ [node_4]           │  │
│  │                    └──→ [node_5 (fork)] ──→ [node_xyz (HEAD)]│  │
│  │                                                              │  │
│  │  Click node → shows snapshot content below                   │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─ Selected Node: node_xyz789 ─────────────────────────────────┐  │
│  │ [JSON content of the snapshot]                                │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

Data source: Read `meta.json` for chain structure → read individual node files on click. Pure file ops.

#### MailboxViewer

**Not file-backed.** `createNexusMailbox()` is a REST + SSE/polling adapter with
`send()`, `onMessage()`, and `list()` semantics. The `/agents/{id}/mailbox/`
directory is provisioned by `ensureNamespace()` but the data is accessed through
the mailbox adapter's IPC API, not filesystem reads.

```
┌─ Mailbox: agent-1 ─────────────────────────────────────────────────┐
│                                                                     │
│  Queued: 2 messages                                                │
│                                                                     │
│  From           Subject/Preview              Received   [Action]   │
│  worker-1       "task completed: impl-1"     30s ago    [View]     │
│  orchestrator   "new task assignment"         2m ago     [View]    │
│                                                                     │
│  Data: POST /api/cmd/mailbox/:agentId/list (adapter API, NOT fs)  │
└─────────────────────────────────────────────────────────────────────┘
```

#### GatewayOverview

Shown for `/global/gateway/`. Combines file data with runtime topology.

```
┌─ Gateway ──────────────────────────────────────────────────────────┐
│                                                                     │
│  ┌─ File-Backed State ─────────────────────────────────────────┐  │
│  │ Sessions: 3 files    Nodes: 2 files    Surfaces: 1 file     │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─ Live Topology (from /api/view/gateway/topology) ───────────┐  │
│  │                                                              │  │
│  │  [Slack]──┐       ┌──────────┐       ┌──[MCP Bridge]        │  │
│  │  [CLI]────┼──────→│ GATEWAY  │←──────┼──[ACP]               │  │
│  │  [Email]──┘       └────┬─────┘       └──[Webhook]           │  │
│  │                   ┌────┼────┐                                │  │
│  │               [agent-1] [agent-2] [agent-3]                  │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

Combines file reads (`/global/gateway/*.json`) with computed view (`/api/view/gateway/topology`).

#### JsonViewer (fallback)

CodeMirror with JSON syntax highlighting, collapsible sections, line numbers. Used for any `.json` file that doesn't match a typed viewer pattern.

#### MarkdownViewer (fallback)

react-markdown with remark-gfm. Used for `.md` files (skill descriptions, docs).

#### RawContentViewer (fallback)

Plain text content viewer for anything else.

---

## 6. Saved Views (Path Projections)

Saved views are **not separate pages with separate backends**. They are filtered projections over the Nexus browser:

| View | Tree root filter | Typed viewer context | Extra data |
|------|-----------------|----------------------|------------|
| **All Files** | `/` | All viewers active | None |
| **Agents** | `/agents/` | AgentOverviewViewer at each agent root | Process tree from `/api/view/agents/tree` |
| **Forge** | `/agents/*/bricks/` + `/global/bricks/` | BrickViewer, BrickListViewer | None (all file-backed) |
| **Events** | `/agents/*/events/` | EventStreamViewer, DeadLetterViewer | None (all file-backed) |
| **Sessions** | `/agents/*/session/` | SessionRecordViewer, PendingFramesViewer | None (all file-backed) |
| **Memory** | `/agents/*/memory/` | MemoryEntityViewer, MemoryOverview | Context budget from `/api/view/` |
| **Workspaces** | `/agents/*/workspace/` | WorkspaceFileViewer | None (all file-backed) |
| **Orchestration** | (overlay, not tree-based) | TaskDAG, SchedulerBoard, HarnessStatus | Temporal/Scheduler/Harness from `/api/view/` |
| **Gateway** | `/global/gateway/` | GatewaySessionViewer, GatewayNodeViewer | Topology from `/api/view/gateway/topology` |

### How Saved Views Work

Selecting a saved view:
1. Sets the file tree root filter (only shows matching paths)
2. Optionally adds a summary panel above the tree (e.g., Agents view shows process tree)
3. All viewer components remain the same — the viewer router doesn't change per view

```typescript
interface SavedView {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly treeFilter: {
    readonly rootPaths: readonly string[];     // paths to show in tree
    readonly globPattern?: string;              // optional glob filter
  };
  readonly summaryComponent?: React.ComponentType; // optional panel above tree
  readonly extraViewEndpoint?: string;             // optional /api/view/ data
}

const SAVED_VIEWS: readonly SavedView[] = [
  {
    id: "all",
    label: "All Files",
    icon: "FolderTree",
    treeFilter: { rootPaths: ["/"] },
  },
  {
    id: "agents",
    label: "Agents",
    icon: "Users",
    treeFilter: { rootPaths: ["/agents/"] },
    summaryComponent: ProcessTreeSummary,
    extraViewEndpoint: "/api/view/agents/tree",
  },
  {
    id: "forge",
    label: "Forge",
    icon: "Puzzle",
    treeFilter: { rootPaths: ["/agents/"], globPattern: "**/bricks/*.json" },
  },
  {
    id: "events",
    label: "Events",
    icon: "Activity",
    treeFilter: { rootPaths: ["/agents/"], globPattern: "**/events/**" },
  },
  {
    id: "sessions",
    label: "Sessions",
    icon: "Clock",
    treeFilter: { rootPaths: ["/agents/"], globPattern: "**/session/**" },
  },
  {
    id: "memory",
    label: "Memory",
    icon: "Brain",
    treeFilter: { rootPaths: ["/agents/"], globPattern: "**/memory/**" },
    summaryComponent: ContextBudgetSummary,
  },
  {
    id: "workspaces",
    label: "Workspaces",
    icon: "Folder",
    treeFilter: { rootPaths: ["/agents/"], globPattern: "**/workspace/**" },
  },
  {
    id: "gateway",
    label: "Gateway",
    icon: "Network",
    treeFilter: { rootPaths: ["/global/gateway/"] },
    summaryComponent: TopologyDiagram,
    extraViewEndpoint: "/api/view/gateway/topology",
  },
] as const;
```

---

## 7. Non-File Controls (Commands)

Not everything is file-backed. Agent lifecycle transitions, Temporal signals, and scheduler controls are imperative operations. These are exposed as **command endpoints** (`/api/cmd/`), rendered as action buttons in viewers, never pretending to be namespace writes.

### Agent Commands

| Command | Endpoint | Trigger in UI |
|---------|----------|---------------|
| Suspend agent | `POST /api/cmd/agents/:id/suspend` | Button in AgentOverviewViewer |
| Resume agent | `POST /api/cmd/agents/:id/resume` | Button in AgentOverviewViewer |
| Terminate agent | `POST /api/cmd/agents/:id/terminate` | Button in AgentOverviewViewer (with confirm) |

Source: Engine registry CAS transitions (`child-handle.ts`, `group-operations.ts`).

### Temporal Commands

| Command | Endpoint | Trigger in UI |
|---------|----------|---------------|
| Signal workflow | `POST /api/cmd/temporal/workflows/:id/signal` | Button in OrchestrationOverlay |
| Terminate workflow | `POST /api/cmd/temporal/workflows/:id/terminate` | Button in OrchestrationOverlay |

Source: Temporal client SDK (not file-backed).

### Scheduler Commands

| Command | Endpoint | Trigger in UI |
|---------|----------|---------------|
| Pause cron schedule | `POST /api/cmd/scheduler/schedules/:id/pause` | Button in SchedulerBoard |
| Resume cron schedule | `POST /api/cmd/scheduler/schedules/:id/resume` | Button in SchedulerBoard |
| Delete cron schedule | `DELETE /api/cmd/scheduler/schedules/:id` | Button in SchedulerBoard |
| Retry dead letter | `POST /api/cmd/scheduler/dlq/:id/retry` | Button in DeadLetterViewer |

Source: Scheduler in-memory state (not file-backed).

### Harness Commands

| Command | Endpoint | Trigger in UI |
|---------|----------|---------------|
| Pause harness | `POST /api/cmd/harness/pause` | Button in HarnessStatus |
| Resume harness | `POST /api/cmd/harness/resume` | Button in HarnessStatus |

Source: LongRunningHarness state machine (not file-backed).

---

## 8. Orchestration Overlay

Temporal workflows, scheduler queues, task board DAGs, and harness state are NOT file-backed in Nexus. They live in-memory (scheduler heap, harness state) or in Temporal's server. These are surfaced as an **overlay drawer** rather than tree-based views.

### Overlay Layout

The orchestration overlay is a slide-out panel triggered from the sidebar "Orchestration" saved view. It renders four tabs of computed data from `/api/view/` endpoints.

```
┌─── Orchestration Overlay (drawer, slides from right) ─────────────┐
│                                                                     │
│  [Temporal] [Scheduler] [Task Board] [Harness]                     │
│                                                                     │
│  ┌─ Tab: Temporal ──────────────────────────────────────────────┐  │
│  │                                                              │  │
│  │  Server: ● healthy (embed, localhost:7233)                   │  │
│  │  UI: http://localhost:8233 [Open ↗]                          │  │
│  │                                                              │  │
│  │  Workflows:                                                  │  │
│  │  copilot-main    ● running   entity   2h      3 CAN         │  │
│  │    └─ worker-1   ● running   worker   30m     0 CAN         │  │
│  │    └─ worker-2   ✓ done      worker   5m      0 CAN         │  │
│  │  batch-agent     ✓ done      entity   1h      1 CAN         │  │
│  │                                                              │  │
│  │  Click workflow → signal timeline + state refs detail        │  │
│  │  [Signal] [Terminate]                                        │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─ Tab: Scheduler ─────────────────────────────────────────────┐  │
│  │                                                              │  │
│  │  ┌─ Pending (5) ───┐ ┌─ Running (2) ──┐ ┌─ Done (12) ────┐ │  │
│  │  │ task-analyze     │ │ ● task-deploy  │ │ ✓ task-test    │ │  │
│  │  │ task-summarize   │ │ ● task-review  │ │ ✓ task-lint    │ │  │
│  │  └─────────────────┘ └────────────────┘ └────────────────┘ │  │
│  │                                                              │  │
│  │  DLQ: 1 entry  │  Concurrency: 2/5  │  Total: 47 submitted  │  │
│  │                                                              │  │
│  │  Cron Schedules:                                             │  │
│  │  daily-report  0 9 * * *    next: 6h 23m   ● active         │  │
│  │  health-check  */5 * * * *  next: 2m 45s   ● active         │  │
│  │  weekly-sync   0 0 * * 1    next: 3d 14h   ◌ paused         │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─ Tab: Task Board (DAG) ──────────────────────────────────────┐  │
│  │                                                              │  │
│  │         [plan ✓] ──→ [impl-1 ●] ──┐                         │  │
│  │                  ──→ [impl-2 ●] ──┼──→ [verify ○] → [deploy]│  │
│  │                                                              │  │
│  │  Legend: ✓ completed  ● running  ○ pending  ✗ failed        │  │
│  │  Click node → task detail (result, error, assignedTo)       │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─ Tab: Harness ───────────────────────────────────────────────┐  │
│  │                                                              │  │
│  │  Phase: ● running    Sessions: 3    Tasks: 2/5 done         │  │
│  │  Tokens: 45,231      Auto-resume: active (poll: 5s)         │  │
│  │  Last checkpoint: soft @ turn 12 (3m ago)                   │  │
│  │                                                              │  │
│  │  ──●──────●──────────●──────●──→                            │  │
│  │    soft    soft       hard   soft                            │  │
│  │  [Pause] [Resume]                                           │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### API Endpoints (all `/api/view/`, read-only computed state)

| Endpoint | Source | Exists Today? | Returns |
|----------|--------|---------------|---------|
| `GET /api/view/temporal/health` | `createTemporalHealthMonitor()` | **Yes** — exported from `@koi/temporal` | `{ status, mode, serverUrl, uiUrl }` |
| `GET /api/view/temporal/workflows` | **NEW adapter needed** over `@temporalio/client` | **No** — `@koi/temporal` does not export `listWorkflows()`. Must build a thin admin adapter using `client.workflow.list()` from `@temporalio/client` directly | workflow summaries |
| `GET /api/view/temporal/workflows/:id` | **NEW adapter needed** over `@temporalio/client` | **No** — must use `client.workflow.getHandle(id)` + query handlers (`STATE_QUERY_NAME`, `STATUS_QUERY_NAME`, `PENDING_COUNT_QUERY_NAME`) | state refs, CAN count, pending count |
| `GET /api/view/scheduler/tasks` | `@koi/scheduler` heap + SQLite | **Yes** — scheduler exposes task listing | task list with status filter |
| `GET /api/view/scheduler/stats` | `@koi/scheduler` counters | **Yes** — scheduler tracks stats | submitted/completed/failed/DLQ/concurrency |
| `GET /api/view/scheduler/schedules` | `@koi/scheduler` ScheduleStore | **Yes** — schedule store has list | cron list with next fire time |
| `GET /api/view/scheduler/dlq` | `@koi/scheduler` DLQ | **Yes** — scheduler dead-letter queue | dead-lettered tasks (separate from event DLQ) |
| `GET /api/view/taskboard` | `@koi/task-board` snapshot | **Yes** — `toSnapshot()` | full DAG with status |
| `GET /api/view/harness/status` | `@koi/long-running` harness | **Yes** — `status()` | phase, metrics, checkpoints |

> **Temporal admin adapter:** `@koi/temporal` intentionally avoids leaking
> `@temporalio/*` types in its public API (anti-leak rule). The admin panel
> needs a thin `createTemporalAdminAdapter(client: TemporalClientLike)` that
> wraps `@temporalio/client` to expose `listWorkflows()` and `getWorkflow()`.
> This adapter lives in the dashboard-api package (L2), not in `@koi/temporal`,
> to avoid contaminating the temporal package's public surface with admin queries.

---

## 9. Data Layer

### Principle: filesystem-nexus First, Views Second

| Data type | Layer | Access pattern |
|-----------|-------|----------------|
| Forge bricks | File-backed | `GET /api/fs/read?path=/agents/{id}/bricks/{brick}.json` |
| Event streams | File-backed | `GET /api/fs/list` + `GET /api/fs/read` (paths: `events/streams/{streamId}/...`) |
| Event dead letters | File-backed | `GET /api/fs/list?path=/agents/{id}/events/dead-letters/` |
| Session records | File-backed | `GET /api/fs/read?path=/agents/{id}/session/records/{sessionId}.json` |
| Pending frames | File-backed | `GET /api/fs/list?path=/agents/{id}/session/pending/{sessionId}/` |
| Memory entities | File-backed | `GET /api/fs/list` + `GET /api/fs/read` per entity |
| Snapshot chains | File-backed | `GET /api/fs/read` (meta.json) + per-node reads |
| Workspace files | File-backed | `GET /api/fs/list` + `GET /api/fs/read` |
| Gateway state | File-backed | `GET /api/fs/read?path=/global/gateway/*.json` |
| Mailbox messages | **Adapter API** | `POST /api/cmd/mailbox/:agentId/list` (NOT file-backed — uses `createNexusMailbox().list()`) |
| Agent process state | Computed | `GET /api/view/agents/tree` (engine registry) |
| Agent /proc data | Computed | `GET /api/view/agents/:id/procfs` (agent-procfs) |
| Middleware chain | Computed | `GET /api/view/middleware/:id` (composed chain) |
| Temporal workflows | Computed | `GET /api/view/temporal/*` (**NEW admin adapter** over `@temporalio/client`) |
| Scheduler tasks | Computed | `GET /api/view/scheduler/*` (in-memory heap + SQLite) |
| Task board DAG | Computed | `GET /api/view/taskboard` (in-memory board) |
| Harness status | Computed | `GET /api/view/harness/*` (in-memory state) |
| Gateway topology | Computed | `GET /api/view/gateway/topology` (live connections) |

### Backend Interface

Only two interfaces needed:

```typescript
/**
 * File operations — backed by @koi/filesystem-nexus.
 * Used for ALL Nexus namespace access.
 */
interface FileSystemDataSource {
  readonly list: (path: string) => Promise<readonly FileEntry[]>;
  readonly read: (path: string) => Promise<FileContent>;
  readonly search: (query: string, path: string) => Promise<readonly SearchResult[]>;
  readonly delete: (path: string) => Promise<Result<void, KoiError>>;
}

/**
 * Runtime views — backed by engine, Temporal, scheduler, etc.
 * Used for computed data that doesn't live in the namespace.
 */
interface RuntimeViewDataSource {
  readonly getProcessTree: () => ProcessTreeSnapshot | Promise<ProcessTreeSnapshot>;
  readonly getAgentProcfs: (id: string) => AgentProcfs | Promise<AgentProcfs | undefined>;
  readonly getMiddlewareChain: (agentId: string) => MiddlewareChain | Promise<MiddlewareChain>;
  readonly getGatewayTopology: () => GatewayTopology | Promise<GatewayTopology>;
  readonly getSystemMetrics: () => SystemMetrics | Promise<SystemMetrics>;

  // Temporal (optional — unavailable without @koi/temporal)
  readonly temporal?: {
    readonly getHealth: () => TemporalHealth | Promise<TemporalHealth>;
    readonly listWorkflows: () => Promise<readonly WorkflowSummary[]>;
    readonly getWorkflow: (id: string) => Promise<WorkflowDetail | undefined>;
  };

  // Scheduler (optional — unavailable without @koi/scheduler)
  readonly scheduler?: {
    readonly listTasks: (filter?: TaskFilter) => Promise<readonly TaskSummary[]>;
    readonly getStats: () => SchedulerStats | Promise<SchedulerStats>;
    readonly listSchedules: () => Promise<readonly CronSchedule[]>;
    readonly listDeadLetters: () => Promise<readonly DeadLetterEntry[]>;
  };

  // Task board (optional — unavailable without @koi/long-running)
  readonly taskBoard?: {
    readonly getSnapshot: () => TaskBoardSnapshot | Promise<TaskBoardSnapshot>;
  };

  // Harness (optional — unavailable without @koi/long-running)
  readonly harness?: {
    readonly getStatus: () => HarnessStatus | Promise<HarnessStatus>;
    readonly getCheckpoints: () => Promise<readonly CheckpointEntry[]>;
  };
}

/**
 * Command dispatcher — imperative operations.
 */
interface CommandDispatcher {
  // Agent lifecycle (always available — engine registry)
  readonly suspendAgent: (id: string) => Promise<Result<void, KoiError>>;
  readonly resumeAgent: (id: string) => Promise<Result<void, KoiError>>;
  readonly terminateAgent: (id: string) => Promise<Result<void, KoiError>>;

  // Temporal (optional — needs admin adapter over @temporalio/client)
  readonly signalWorkflow?: (id: string, signal: string, payload: unknown) => Promise<Result<void, KoiError>>;
  readonly terminateWorkflow?: (id: string) => Promise<Result<void, KoiError>>;

  // Scheduler (optional)
  readonly pauseSchedule?: (id: string) => Promise<Result<void, KoiError>>;
  readonly resumeSchedule?: (id: string) => Promise<Result<void, KoiError>>;
  readonly retrySchedulerDeadLetter?: (id: string) => Promise<Result<void, KoiError>>;

  // Event DLQ (separate from scheduler DLQ — backed by EventBackend.retryDeadLetter())
  readonly retryEventDeadLetter?: (entryId: string) => Promise<Result<void, KoiError>>;

  // Harness (optional)
  readonly pauseHarness?: () => Promise<Result<void, KoiError>>;
  readonly resumeHarness?: () => Promise<Result<void, KoiError>>;

  // Mailbox (adapter API — not file-backed)
  readonly listMailbox?: (agentId: string) => Promise<readonly AgentMessage[]>;
}
```

Three interfaces vs v1's twelve. The filesystem does most of the work.

---

## 10. SSE Events

Extend existing SSE producer. Events are still pushed by the backend, not polled.

### Existing Events (keep as-is)

| Kind | SubKind | Source |
|------|---------|--------|
| agent | status_changed, dispatched, terminated, metrics_updated | Engine registry |
| skill | installed, removed | Resolver |
| channel | connected, disconnected, message_received | Channel adapters |
| system | memory_warning, error, activity | Runtime |

### New Events

| Kind | SubKind | Trigger | Phase |
|------|---------|---------|-------|
| `nexus` | `file_changed` | Nexus file created/updated/deleted | P1 |
| `temporal` | `workflow_started` | New Temporal workflow started | P1 |
| `temporal` | `workflow_completed` | Workflow finished (success/fail) | P1 |
| `temporal` | `health_changed` | Server health status transition | P1 |
| `scheduler` | `task_submitted` | Task added to queue | P1 |
| `scheduler` | `task_completed` | Task finished (success/fail) | P1 |
| `scheduler` | `task_dead_letter` | Task moved to DLQ | P1 |
| `scheduler` | `schedule_fired` | Cron schedule triggered | P1 |
| `taskboard` | `task_status_changed` | DAG task state transition | P1 |
| `harness` | `checkpoint_created` | Checkpoint (soft/hard) taken | P1 |
| `harness` | `phase_changed` | Harness lifecycle transition | P1 |
| `gateway` | `connection_changed` | Channel connected/disconnected | P1 |

Total: 12 existing + 12 new = 24 event subtypes.

---

## 11. Component Library

| Component | Used By | Description |
|-----------|---------|-------------|
| **Shell** | | |
| `BrowserShell` | All | Sidebar + tree + viewer layout |
| `Sidebar` | All | Saved views nav + file tree |
| `StatusBar` | All | SSE status, agent count, Temporal health |
| `Breadcrumb` | All | Path navigation with clickable segments |
| `CommandBar` | All | Action buttons for non-file operations |
| **Tree** | | |
| `FileTree` | Browser | Recursive expandable tree (lazy-load) |
| `FileContextMenu` | Browser | Right-click actions (Radix) |
| `FileIcon` | Tree/Viewer | Path-based icon resolver |
| **Viewers** | | |
| `ViewerRouter` | Browser | Path pattern → viewer component |
| `AgentOverviewViewer` | Agents view | Agent card with runtime data |
| `BrickViewer` | Forge view | Brick detail with verification |
| `BrickListViewer` | Forge view | Brick table for directory |
| `EventStreamViewer` | Events view | Stream meta + event timeline |
| `EventDetailViewer` | Events view | Single event content |
| `DeadLetterViewer` | Events view | DLQ entry with retry button |
| `SessionRecordViewer` | Sessions view | Session state + checkpoint timeline |
| `PendingFramesViewer` | Sessions view | Pending interactions list |
| `MemoryEntityViewer` | Memory view | Memory content + score |
| `MemoryOverview` | Memory view | Context budget bar |
| `SnapshotChainViewer` | Snapshots | DAG graph (React Flow) |
| `SnapshotNodeViewer` | Snapshots | Individual snapshot content |
| `MailboxViewer` | Agents | Queued message list |
| `WorkspaceFileViewer` | Workspaces | File content with type detection |
| `GatewayOverview` | Gateway | Topology + file state |
| `GatewaySessionViewer` | Gateway | Session JSON |
| `GatewayNodeViewer` | Gateway | Node JSON |
| `JsonViewer` | Fallback | CodeMirror JSON |
| `MarkdownViewer` | Fallback | react-markdown |
| `RawContentViewer` | Fallback | Plain text |
| **Orchestration** | | |
| `OrchestrationDrawer` | Overlay | Slide-out panel with 4 tabs |
| `TemporalTab` | Overlay | Workflow list + detail + signals |
| `SchedulerTab` | Overlay | Kanban board + cron + DLQ |
| `TaskDagTab` | Overlay | React Flow DAG |
| `HarnessTab` | Overlay | Status + checkpoint timeline |
| **Shared** | | |
| `ProcessStateBadge` | Agents, Tree | Colored state badge |
| `DataTable` | Multiple | Sortable/filterable table |
| `StatCard` | Status, Overview | Metric card |
| `EmptyState` | All | "No data" placeholder |
| `LoadingSkeleton` | All | Animated placeholder |
| `ErrorBoundary` | All | Error fallback |
| `ConfirmDialog` | Commands | Destructive action confirmation |
| `TopologyDiagram` | Gateway | React Flow network |

---

## 12. Package Structure

No new packages. Extend existing three:

```
packages/observability/
├── dashboard-types/          ← EXTEND
│   └── src/
│       ├── data-source.ts         (existing — keep for backward compat)
│       ├── events.ts              (existing — extend with 12 new events)
│       ├── config.ts              (existing — keep)
│       ├── cursors.ts             (existing — keep)
│       ├── rest-types.ts          (existing — keep)
│       ├── file-system.ts         (NEW — FileSystemDataSource types)
│       ├── runtime-views.ts       (NEW — RuntimeViewDataSource types)
│       ├── commands.ts            (NEW — CommandDispatcher types)
│       └── admin-panel.ts         (NEW — composite config type)
│
├── dashboard-api/            ← EXTEND
│   └── src/
│       ├── handler.ts             (existing — register new route groups)
│       ├── router.ts              (existing — keep)
│       ├── routes/
│       │   ├── agents.ts          (existing — keep)
│       │   ├── channels.ts        (existing — keep)
│       │   ├── skills.ts          (existing — keep)
│       │   ├── metrics.ts         (existing — keep)
│       │   ├── health.ts          (existing — keep)
│       │   ├── filesystem.ts      (NEW — /api/fs/* via filesystem-nexus)
│       │   ├── views.ts           (NEW — /api/view/* computed state)
│       │   └── commands.ts        (NEW — /api/cmd/* imperative actions)
│       ├── sse/
│       │   ├── producer.ts        (existing — no changes)
│       │   └── encoder.ts         (existing — no changes)
│       ├── middleware/
│       │   └── cors.ts            (existing — keep)
│       └── static-serve.ts        (existing — keep)
│
├── dashboard-ui/             ← REWRITE
│   └── src/
│       ├── main.tsx
│       ├── app.tsx
│       ├── browser/
│       │   ├── browser-shell.tsx        (main layout)
│       │   ├── sidebar.tsx              (saved views + file tree)
│       │   ├── file-tree.tsx            (recursive expandable tree)
│       │   ├── file-icon.tsx            (path-based icon resolver)
│       │   ├── file-context-menu.tsx    (right-click actions)
│       │   ├── breadcrumb.tsx           (path navigation)
│       │   ├── viewer-router.tsx        (path → viewer)
│       │   └── saved-views.ts           (view definitions)
│       ├── viewers/
│       │   ├── agent-overview.tsx
│       │   ├── brick-viewer.tsx
│       │   ├── brick-list.tsx
│       │   ├── event-stream.tsx
│       │   ├── event-detail.tsx
│       │   ├── dead-letter.tsx
│       │   ├── session-record.tsx
│       │   ├── pending-frames.tsx
│       │   ├── memory-entity.tsx
│       │   ├── memory-overview.tsx
│       │   ├── snapshot-chain.tsx
│       │   ├── snapshot-node.tsx
│       │   ├── mailbox.tsx
│       │   ├── workspace-file.tsx
│       │   ├── gateway-overview.tsx
│       │   ├── gateway-session.tsx
│       │   ├── json-viewer.tsx
│       │   ├── markdown-viewer.tsx
│       │   └── raw-content.tsx
│       ├── orchestration/
│       │   ├── orchestration-drawer.tsx
│       │   ├── temporal-tab.tsx
│       │   ├── scheduler-tab.tsx
│       │   ├── task-dag.tsx
│       │   └── harness-tab.tsx
│       ├── components/
│       │   ├── status-bar.tsx
│       │   ├── command-bar.tsx
│       │   ├── process-state-badge.tsx
│       │   ├── data-table.tsx
│       │   ├── stat-card.tsx
│       │   ├── topology-diagram.tsx
│       │   ├── empty-state.tsx
│       │   ├── loading-skeleton.tsx
│       │   ├── error-boundary.tsx
│       │   └── confirm-dialog.tsx
│       ├── hooks/
│       │   ├── use-sse.ts              (existing — extend event dispatch)
│       │   ├── use-file-tree.ts        (NEW — tree data + expand state)
│       │   ├── use-file-content.ts     (NEW — read file content)
│       │   ├── use-search.ts           (NEW — full-text search)
│       │   ├── use-runtime-view.ts     (NEW — generic /api/view/ fetcher)
│       │   └── use-command.ts          (NEW — POST /api/cmd/ mutation)
│       ├── stores/
│       │   ├── agents-store.ts         (existing — keep)
│       │   ├── connection-store.ts     (existing — keep)
│       │   ├── tree-store.ts           (NEW — expanded nodes, selection)
│       │   ├── view-store.ts           (NEW — active saved view)
│       │   └── orchestration-store.ts  (NEW — Temporal/scheduler state)
│       ├── lib/
│       │   ├── api-client.ts           (existing — extend)
│       │   ├── sse-client.ts           (existing — keep)
│       │   ├── dashboard-config.ts     (existing — keep)
│       │   ├── format.ts              (existing — keep)
│       │   └── viewer-routes.ts        (NEW — path pattern matching)
│       └── index.css                   (existing — extend theme)
```

---

## 13. Implementation Phases

### Phase 0: Namespace Contract (1 week)

- [ ] Audit `paths.ts`, `namespace.ts`, `PACKAGES.md` for all mismatches
- [ ] Choose canonical paths (recommend: align `namespace.ts` → `paths.ts`)
- [ ] Update `namespace.ts` `computeAgentNamespace()` to produce canonical paths
- [ ] Add missing paths to `paths.ts` (workspace, mailbox)
- [ ] Update `PACKAGES.md` lines 901-957
- [ ] Run and fix `namespace.test.ts`
- [ ] Verify `nexus-store/*.ts` default basePaths match canonical paths

### Phase 1: Nexus Browser Shell (3-4 weeks)

**Week 1: Browser infrastructure**
- [ ] Install deps: `react-resizable-panels`, `@radix-ui/react-context-menu`, `lucide-react`, `@uiw/react-codemirror`
- [ ] `BrowserShell` layout (sidebar + tree + viewer panels, resizable)
- [ ] `Sidebar` with saved view definitions
- [ ] `StatusBar` with SSE connection indicator
- [ ] `Breadcrumb` with clickable path segments
- [ ] Routing: single route `/` renders browser shell, saved view as URL param

**Week 2: File tree + basic viewers**
- [ ] `FileTree` component backed by `GET /api/fs/list`
- [ ] `FileIcon` path-based icon resolver
- [ ] `FileContextMenu` (open, copy path, refresh, delete)
- [ ] `ViewerRouter` with path pattern matching
- [ ] `JsonViewer` (CodeMirror), `MarkdownViewer` (react-markdown), `RawContentViewer`
- [ ] `use-file-tree` hook (expand state, selection, lazy-load)
- [ ] `use-file-content` hook (read file on selection)
- [ ] Backend: `routes/filesystem.ts` with list/read/search/delete endpoints

**Week 3: Typed viewers**
- [ ] `AgentOverviewViewer` (combines file data + `/api/view/agents/:id/procfs`)
- [ ] `BrickViewer` + `BrickListViewer`
- [ ] `EventStreamViewer` + `EventDetailViewer` + `DeadLetterViewer`
- [ ] `SessionRecordViewer` + `PendingFramesViewer`
- [ ] `MemoryEntityViewer` + `MemoryOverview`
- [ ] `SnapshotChainViewer` (React Flow DAG) + `SnapshotNodeViewer`
- [ ] `MailboxViewer`
- [ ] Backend: `routes/views.ts` with agents/tree, agents/:id/procfs, middleware/:id

**Week 4: Saved views + commands**
- [ ] Saved view filtering (tree root filter + glob)
- [ ] Agents view with `ProcessTreeSummary` component
- [ ] Gateway view with `TopologyDiagram` component
- [ ] `CommandBar` with action buttons
- [ ] `ConfirmDialog` for destructive actions
- [ ] Backend: `routes/commands.ts` with suspend/resume/terminate
- [ ] Backend: `routes/views.ts` with gateway/topology
- [ ] SSE: extend events.ts with `nexus.file_changed`, `gateway.connection_changed`

### Phase 2: Orchestration Overlay (2-3 weeks)

**Week 5: Temporal + Scheduler**
- [ ] `OrchestrationDrawer` slide-out panel
- [ ] `TemporalTab` (workflow list, detail, signal timeline, health)
- [ ] `SchedulerTab` (kanban board, cron schedules, DLQ, stats)
- [ ] Backend: `routes/views.ts` with temporal/*, scheduler/* endpoints
- [ ] Backend: `routes/commands.ts` with signal/terminate/pause/resume/retry
- [ ] SSE: temporal.* and scheduler.* events

**Week 6: Task Board + Harness**
- [ ] `TaskDagTab` (React Flow DAG with status-colored nodes)
- [ ] `HarnessTab` (phase, metrics, checkpoint timeline)
- [ ] Backend: `routes/views.ts` with taskboard, harness/* endpoints
- [ ] Backend: `routes/commands.ts` with harness pause/resume
- [ ] SSE: taskboard.* and harness.* events

**Week 7: Integration**
- [ ] Wire dashboard handler into `koi serve` (mount on existing HTTP server)
- [ ] Add `koi start --dashboard` flag
- [ ] Write `createAdminPanelBridge(host, nexusClient)` adapter
- [ ] E2E tests
- [ ] Documentation

### Phase 3: Polish (2 weeks, optional)

- [ ] Dark/light theme toggle
- [ ] Search improvements (full-text across namespace)
- [ ] File content editing (write-back via filesystem-nexus)
- [ ] Keyboard shortcuts (Ctrl+K for search, arrow keys for tree)
- [ ] Responsive layout for smaller screens
- [ ] Performance: virtualized file tree for large namespaces
- [ ] Performance: infinite scroll for event streams

---

## 14. Embed Mode Constraints

When running in embed mode (`createNexusStack` with no API key), several global backends are disabled:

| Backend | Available in Embed? | Admin Panel Impact |
|---------|--------------------|--------------------|
| Permissions (ReBAC) | Yes | Can show permission data |
| Registry | No | Agents view falls back to engine registry |
| Audit | No | No audit log in governance view |
| Search (global backend) | No | Global search backend disabled, BUT `filesystem-nexus.search()` calls Nexus RPC directly — may still work if embed server handles the `search` RPC. **Needs verification:** test `search()` against embedded Nexus to confirm. If the RPC is handled, search works in embed mode despite the global backend being disabled. |
| Scheduler (Nexus) | No | Falls back to local SQLite scheduler |
| Pay | No | No budget tracking |
| Name Service | No | No ANS resolution |

The admin panel must gracefully degrade:

```typescript
// In viewer components
const { scheduler } = useRuntimeView();
if (!scheduler) {
  return <UnavailableSection reason="Scheduler not configured" />;
}
```

**Day-one experience (embed mode):**
- File tree navigation: works (filesystem-nexus operates without global backends)
- Agent overview: works (engine registry is always available)
- Typed viewers: work (all file-backed, no global backend needed)
- Orchestration overlay: partially works (Temporal if configured, scheduler local-only)
- Search: tree browsing only (no full-text without Nexus search backend)

---

## 15. Open Questions

| # | Question | Options | Impact |
|---|----------|---------|--------|
| 1 | Where does the dashboard mount? | (a) `koi serve` same port (b) `koi dashboard` separate (c) Both | P0 |
| 2 | Auth? | (a) None (local only) (b) Same API key as Nexus (c) Separate | P0 |
| 3 | Should saved views be URL-driven? | (a) `?view=agents` param (b) `/agents` route (c) Both | P1 |
| 4 | Temporal: link to native UI or embed? | (a) Link to `:8233` (b) Embed key views (c) Both | P2 |
| 5 | File editing? | (a) Read-only v1 (b) Edit via filesystem-nexus write-back | P3 |
| 6 | Real-time file tree updates? | (a) Manual refresh (b) SSE `nexus.file_changed` invalidation | P1 |
| 7 | How to handle large event streams? | (a) Paginate (b) Virtual scroll (c) Load-on-expand | P1 |
| 8 | Process tree: React Flow or recursive list? | React Flow is richer but heavier | P1 |

---

## Summary: v1 → v2 Diff

| Aspect | v1 (wrong) | v2 (correct) |
|--------|-----------|--------------|
| Architecture | 10 independent pages, 12 data source interfaces | Nexus browser + typed viewers + saved views |
| Data layer | 12 separate backend contracts | 2 interfaces: FileSystem + RuntimeView + Commands |
| Nexus role | One page among many | The shell — every domain is a path projection |
| Forge/Sessions/Memory | Separate pages with separate APIs | Typed viewers over namespace paths |
| Orchestration | Separate pages | Overlay drawer (non-file data acknowledged as such) |
| Agent lifecycle | Mixed into file-backed model | Explicit commands (imperative, not namespace writes) |
| Foundation | Raw `@koi/nexus-client` | `@koi/filesystem-nexus` (boundary-checked, full CRUD) |
| SSE events | 33 types | 24 types (fewer needed when files are the source of truth) |
| Prerequisite | None | Freeze namespace contract first |

---

*v2 reviewed against Codex audit findings. Core principle: the Nexus namespace IS the admin panel. File-backed data uses filesystem-nexus. Non-file operations stay explicit as commands. Orchestration is an overlay, not a tree projection.*
