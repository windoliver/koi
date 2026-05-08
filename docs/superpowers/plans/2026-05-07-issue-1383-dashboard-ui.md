# Issue 1383 Dashboard UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the dashboard client to the existing SSE transport and ship a new `@koi/dashboard-ui` MVP package that renders agents, sessions, traces, and metrics with live updates.

**Architecture:** Keep `@koi/dashboard-api` as the existing REST + SSE server, refactor `@koi/dashboard-client` so `subscribe(...)` consumes SSE batches from `/api/events`, and build a small React/Vite package under `packages/ui/dashboard-ui` on top of the client and shared dashboard types. The UI stays single-shell and operator-first: one selection model, one live subscription, and bounded snapshot + patch update logic.

**Tech Stack:** Bun 1.3.x, TypeScript 6, `bun:test`, React 19, React DOM 19, Vite 6, `@vitejs/plugin-react`, `happy-dom`, `@testing-library/react`, `@koi/dashboard-client`, `@koi/dashboard-types`.

---

## File Map

```text
Create
  packages/ui/dashboard-ui/
    package.json
    tsconfig.json
    vite.config.ts
    index.html
    src/main.tsx
    src/app.tsx
    src/index.css
    src/lib/demo-data.ts
    src/lib/format.ts
    src/lib/state.ts
    src/lib/state.test.ts
    src/components/agent-list.tsx
    src/components/session-detail.tsx
    src/components/trace-viewer.tsx
    src/components/metrics-panel.tsx
    src/components/status-pill.tsx
    src/components/empty-state.tsx
    src/components/error-state.tsx
    src/components/loading-state.tsx
    src/__tests__/dashboard-ui.test.tsx

Modify
  packages/lib/dashboard-client/package.json
  packages/lib/dashboard-client/src/client.ts
  packages/lib/dashboard-client/src/client.test.ts
  packages/lib/dashboard-client/src/index.ts
  packages/lib/dashboard-client/src/subscribe.ts
  packages/lib/dashboard-client/src/subscribe.test.ts
  docs/L2/dashboard.md
  docs/L2/dashboard-api.md
  docs/L2/dashboard-client.md
  package.json
  bun.lock

Reference only
  /Users/sophiawj/private/koi/archive/v1/packages/observability/dashboard-ui/src/*
```

---

### Task 1: Align `@koi/dashboard-client` to SSE

**Files:**
- Modify: `packages/lib/dashboard-client/src/subscribe.ts`
- Modify: `packages/lib/dashboard-client/src/subscribe.test.ts`
- Modify: `packages/lib/dashboard-client/src/client.ts`
- Modify: `packages/lib/dashboard-client/src/client.test.ts`
- Modify: `packages/lib/dashboard-client/src/index.ts`
- Modify: `packages/lib/dashboard-client/package.json`
- Reference: `packages/lib/dashboard-api/src/sse.ts`
- Reference: `packages/lib/dashboard-api/src/sse.test.ts`

- [ ] **Step 1: Rewrite the subscription tests around SSE instead of WebSocket**

```typescript
// packages/lib/dashboard-client/src/subscribe.test.ts
import { describe, expect, test } from "bun:test";
import type { KoiError } from "@koi/core";
import { openSubscription, type EventSourceLike } from "./subscribe.js";

function fakeEventSource() {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  let closed = false;
  return {
    url: "",
    closed: () => closed,
    addEventListener(event: string, handler: (event: unknown) => void) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    },
    close() {
      closed = true;
    },
    fire(event: string, payload: unknown) {
      for (const handler of listeners.get(event) ?? []) handler(payload);
    },
  };
}

describe("openSubscription", () => {
  test("encodes topics into the SSE url", () => {
    let openedUrl = "";
    openSubscription(
      (url) => {
        openedUrl = url;
        return fakeEventSource() as EventSourceLike;
      },
      "http://h:1/api/events",
      ["metric", "trace"],
      { onEvent: () => {} },
    );
    expect(openedUrl).toBe("http://h:1/api/events?topics=metric%2Ctrace");
  });

  test("dispatches each event from one batch payload", () => {
    const source = fakeEventSource();
    const seen: string[] = [];
    openSubscription(() => source as EventSourceLike, "http://h:1/api/events", ["metric"], {
      onEvent: (event) => seen.push(event.kind),
    });
    source.fire("batch", {
      data: JSON.stringify({
        seq: 1,
        timestampMs: 1,
        events: [
          { v: 1, kind: "metric", points: [{ name: "cpu", value: 1, timestampMs: 1 }] },
          { v: 1, kind: "metric", points: [{ name: "rss", value: 2, timestampMs: 1 }] },
        ],
      }),
    });
    expect(seen).toEqual(["metric", "metric"]);
  });

  test("surfaces a retryable EXTERNAL error on stream failure", () => {
    const source = fakeEventSource();
    const errors: KoiError[] = [];
    openSubscription(() => source as EventSourceLike, "http://h:1/api/events", ["metric"], {
      onEvent: () => {},
      onError: (error) => errors.push(error),
    });
    source.fire("error", new Error("stream dropped"));
    expect(errors[0]?.code).toBe("EXTERNAL");
    expect(errors[0]?.retryable).toBe(true);
  });
});
```

- [ ] **Step 2: Run the subscription tests to verify they fail with the current WebSocket implementation**

Run:

```bash
bun test packages/lib/dashboard-client/src/subscribe.test.ts
```

Expected: FAIL because `subscribe.ts` still exports the WebSocket-based `WsLike` flow and does not understand SSE `batch` frames.

- [ ] **Step 3: Implement a small injectable SSE adapter and batch parser**

```typescript
// packages/lib/dashboard-client/src/subscribe.ts
import type { KoiError } from "@koi/core";
import type { WsEvent, WsTopic } from "@koi/dashboard-types";
import { isWsEvent } from "@koi/dashboard-types";
import { clientError } from "./errors.js";

export interface EventSourceLike {
  addEventListener(event: "batch", handler: (event: { data: string }) => void): void;
  addEventListener(event: "error", handler: (event: unknown) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;
export type Unsubscribe = () => void;

export interface SubscriptionHandlers {
  readonly onEvent: (event: WsEvent) => void;
  readonly onError?: (error: KoiError) => void;
  readonly onClose?: () => void;
}

export function openSubscription(
  factory: EventSourceFactory,
  baseUrl: string,
  topics: readonly WsTopic[],
  handlers: SubscriptionHandlers,
): Unsubscribe {
  const url = withTopics(baseUrl, topics);
  const source = factory(url);
  let closed = false;

  source.addEventListener("batch", (event) => {
    if (closed) return;
    const parsed = parseBatch(event.data);
    if (parsed === undefined) return;
    for (const item of parsed) handlers.onEvent(item);
  });

  source.addEventListener("error", (cause) => {
    if (closed) return;
    closed = true;
    handlers.onError?.(
      clientError("EXTERNAL", `SSE error on ${url}`, { cause, retryable: true }),
    );
    handlers.onClose?.();
    source.close();
  });

  return () => {
    if (closed) return;
    closed = true;
    source.close();
  };
}

function withTopics(baseUrl: string, topics: readonly WsTopic[]): string {
  const url = new URL(baseUrl);
  if (topics.length > 0) url.searchParams.set("topics", topics.join(","));
  return url.toString();
}

function parseBatch(raw: string): readonly WsEvent[] | undefined {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as { events?: unknown }).events)
  ) {
    return undefined;
  }
  const events = (body as { events: unknown[] }).events.filter(isWsEvent);
  return events;
}
```

- [ ] **Step 4: Update the client factory and tests to point at `/api/events`**

```typescript
// packages/lib/dashboard-client/src/client.ts
import {
  openSubscription,
  type EventSourceFactory,
  type SubscriptionHandlers,
  type Unsubscribe,
} from "./subscribe.js";

export interface DashboardClientConfig {
  readonly baseUrl: string;
  readonly fetch?: FetchLike;
  readonly eventSource?: EventSourceFactory;
}

subscribe: (topics, handlers): Unsubscribe =>
  openSubscription(eventSourceFactory, `${baseUrl}/api/events`, topics, handlers),
```

```typescript
// packages/lib/dashboard-client/src/client.test.ts
test("subscribe targets /api/events", () => {
  let openedUrl = "";
  const client = createDashboardClient({
    baseUrl: "http://h:1",
    fetch: async () => jsonResponse({ ok: true, value: [] }),
    eventSource: (url) => {
      openedUrl = url;
      return {
        addEventListener() {},
        close() {},
      };
    },
  });
  client.subscribe(["metric"], { onEvent: () => {} });
  expect(openedUrl).toBe("http://h:1/api/events?topics=metric");
});
```

- [ ] **Step 5: Run the dashboard-client test suite**

Run:

```bash
bun test packages/lib/dashboard-client/src
```

Expected: PASS with the SSE subscription tests green and the HTTP client tests still passing.

- [ ] **Step 6: Commit the client transport alignment**

```bash
git add \
  packages/lib/dashboard-client/package.json \
  packages/lib/dashboard-client/src/client.ts \
  packages/lib/dashboard-client/src/client.test.ts \
  packages/lib/dashboard-client/src/index.ts \
  packages/lib/dashboard-client/src/subscribe.ts \
  packages/lib/dashboard-client/src/subscribe.test.ts
git commit -m "feat: align dashboard client with SSE transport"
```

---

### Task 2: Reconcile dashboard documentation

**Files:**
- Modify: `docs/L2/dashboard.md`
- Modify: `docs/L2/dashboard-api.md`
- Modify: `docs/L2/dashboard-client.md`

- [ ] **Step 1: Add doc assertions that capture the intended transport story**

```markdown
<!-- docs/L2/dashboard-client.md -->
- `subscribe(topics, handlers): Unsubscribe` — SSE subscription over `/api/events`
- Optional `fetch` and `EventSource` injection keep the package runtime-agnostic
- v2 dashboard live updates use SSE, not WebSocket
```

```markdown
<!-- docs/L2/dashboard.md -->
- `@koi/dashboard-api` provides REST + SSE
- `@koi/dashboard-client` wraps REST + SSE for UI consumers
- `@koi/dashboard-ui` is a single-shell React SPA MVP in this phase
```

- [ ] **Step 2: Run a narrow doc sync search before editing**

Run:

```bash
rg -n "WebSocket|/api/ws|SSE|/events" docs/L2/dashboard*.md packages/lib/dashboard-client
```

Expected: existing WebSocket references in `docs/L2/dashboard-client.md` and `packages/lib/dashboard-client`.

- [ ] **Step 3: Edit the three L2 docs to remove the WebSocket contradiction**

```markdown
<!-- docs/L2/dashboard-api.md -->
| `GET` | `/events` | bearer | SSE stream of batched `WsEvent` values |

<!-- docs/L2/dashboard-client.md -->
Typed client SDK for the dashboard HTTP + SSE API.

<!-- docs/L2/dashboard.md -->
`@koi/dashboard-ui` consumes `@koi/dashboard-client` rather than speaking to raw transport primitives directly.
```

- [ ] **Step 4: Run a final transport consistency grep**

Run:

```bash
rg -n "/api/ws|WebSocket" docs/L2/dashboard*.md packages/lib/dashboard-client
```

Expected: no remaining dashboard WebSocket references in docs or the client package, except possibly historical comments that are intentionally removed during editing.

- [ ] **Step 5: Commit the doc cleanup**

```bash
git add docs/L2/dashboard.md docs/L2/dashboard-api.md docs/L2/dashboard-client.md
git commit -m "docs: standardize dashboard transport on SSE"
```

---

### Task 3: Scaffold `@koi/dashboard-ui`

**Files:**
- Create: `packages/ui/dashboard-ui/package.json`
- Create: `packages/ui/dashboard-ui/tsconfig.json`
- Create: `packages/ui/dashboard-ui/vite.config.ts`
- Create: `packages/ui/dashboard-ui/index.html`
- Create: `packages/ui/dashboard-ui/src/main.tsx`
- Create: `packages/ui/dashboard-ui/src/app.tsx`
- Create: `packages/ui/dashboard-ui/src/index.css`
- Modify: `package.json`
- Modify: `bun.lock`
- Reference: `packages/ui/tui/package.json`
- Reference: `/Users/sophiawj/private/koi/archive/v1/packages/observability/dashboard-ui/package.json`

- [ ] **Step 1: Write a failing smoke test for the new package root**

```typescript
// packages/ui/dashboard-ui/src/__tests__/dashboard-ui.test.tsx
import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { DashboardApp } from "../app.js";

describe("DashboardApp", () => {
  test("renders the dashboard shell title", () => {
    render(<DashboardApp />);
    expect(screen.getByText("Koi Dashboard")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the new package test and watch it fail because the package does not exist**

Run:

```bash
bun test packages/ui/dashboard-ui/src/__tests__/dashboard-ui.test.tsx
```

Expected: FAIL because `packages/ui/dashboard-ui` and `DashboardApp` do not exist yet.

- [ ] **Step 3: Add the minimal package scaffold and app shell**

```json
// packages/ui/dashboard-ui/package.json
{
  "name": "@koi/dashboard-ui",
  "description": "React dashboard MVP for Koi observability",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "bun test"
  },
  "dependencies": {
    "@koi/dashboard-client": "workspace:*",
    "@koi/dashboard-types": "workspace:*",
    "react": "19.1.0",
    "react-dom": "19.1.0"
  },
  "devDependencies": {
    "@testing-library/react": "16.3.0",
    "@types/react": "19.1.8",
    "@types/react-dom": "19.1.6",
    "@vitejs/plugin-react": "4.5.2",
    "happy-dom": "18.0.1",
    "vite": "6.3.5"
  }
}
```

```tsx
// packages/ui/dashboard-ui/src/app.tsx
export function DashboardApp(): JSX.Element {
  return (
    <main>
      <header>
        <h1>Koi Dashboard</h1>
        <p>Agents, sessions, traces, and live metrics in one place.</p>
      </header>
    </main>
  );
}
```

```tsx
// packages/ui/dashboard-ui/src/main.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { DashboardApp } from "./app.js";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DashboardApp />
  </React.StrictMode>,
);
```

- [ ] **Step 4: Install/update dependencies and run the smoke test**

Run:

```bash
bun install
bun test packages/ui/dashboard-ui/src/__tests__/dashboard-ui.test.tsx
```

Expected: PASS with the new shell title rendered.

- [ ] **Step 5: Commit the package scaffold**

```bash
git add package.json bun.lock packages/ui/dashboard-ui
git commit -m "feat: scaffold dashboard ui package"
```

---

### Task 4: Build the MVP state model and presentational components

**Files:**
- Create: `packages/ui/dashboard-ui/src/lib/demo-data.ts`
- Create: `packages/ui/dashboard-ui/src/lib/format.ts`
- Create: `packages/ui/dashboard-ui/src/lib/state.ts`
- Create: `packages/ui/dashboard-ui/src/lib/state.test.ts`
- Create: `packages/ui/dashboard-ui/src/components/agent-list.tsx`
- Create: `packages/ui/dashboard-ui/src/components/session-detail.tsx`
- Create: `packages/ui/dashboard-ui/src/components/trace-viewer.tsx`
- Create: `packages/ui/dashboard-ui/src/components/metrics-panel.tsx`
- Create: `packages/ui/dashboard-ui/src/components/status-pill.tsx`
- Create: `packages/ui/dashboard-ui/src/components/empty-state.tsx`
- Create: `packages/ui/dashboard-ui/src/components/error-state.tsx`
- Create: `packages/ui/dashboard-ui/src/components/loading-state.tsx`
- Modify: `packages/ui/dashboard-ui/src/app.tsx`
- Modify: `packages/ui/dashboard-ui/src/index.css`
- Reference: `packages/lib/dashboard-types/src/agent-status.ts`
- Reference: `packages/lib/dashboard-types/src/session-summary.ts`
- Reference: `packages/lib/dashboard-types/src/trace-view.ts`
- Reference: `packages/lib/dashboard-types/src/metric-point.ts`

- [ ] **Step 1: Write failing state-patching tests before adding UI logic**

```typescript
// packages/ui/dashboard-ui/src/lib/state.test.ts
import { describe, expect, test } from "bun:test";
import { applyDashboardEvent, createDashboardViewModel } from "./state.js";

test("replaces an agent by agentId on agent-status events", () => {
  const initial = createDashboardViewModel({
    agents: [
      {
        agentId: "agent-1",
        name: "Main",
        state: "running",
        agentType: "copilot",
        channels: [],
        turns: 1,
        tokenCount: 10,
        startedAt: 1,
        lastActivityAt: 2,
        childCount: 0,
      },
    ],
    sessions: [],
    metrics: [],
    traces: [],
  });

  const next = applyDashboardEvent(initial, {
    v: 1,
    kind: "agent-status",
    status: {
      agentId: "agent-1",
      name: "Main",
      state: "idle",
      agentType: "copilot",
      channels: [],
      turns: 2,
      tokenCount: 11,
      startedAt: 1,
      lastActivityAt: 3,
      childCount: 0,
    },
  });

  expect(next.agents[0]?.state).toBe("idle");
  expect(next.agents[0]?.turns).toBe(2);
});
```

- [ ] **Step 2: Run the state test to verify the reducer layer does not exist yet**

Run:

```bash
bun test packages/ui/dashboard-ui/src/lib/state.test.ts
```

Expected: FAIL because `createDashboardViewModel` and `applyDashboardEvent` do not exist yet.

- [ ] **Step 3: Implement the smallest state model and shell composition**

```typescript
// packages/ui/dashboard-ui/src/lib/state.ts
import type {
  AgentStatus,
  MetricPoint,
  SessionSummary,
  TraceView,
  WsEvent,
} from "@koi/dashboard-types";

export interface DashboardViewModel {
  readonly agents: readonly AgentStatus[];
  readonly sessions: readonly SessionSummary[];
  readonly metrics: readonly MetricPoint[];
  readonly traces: readonly TraceView[];
  readonly selectedAgentId?: string | undefined;
  readonly selectedSessionId?: string | undefined;
}

export function createDashboardViewModel(input: {
  agents: readonly AgentStatus[];
  sessions: readonly SessionSummary[];
  metrics: readonly MetricPoint[];
  traces: readonly TraceView[];
}): DashboardViewModel {
  return { ...input };
}

export function applyDashboardEvent(
  model: DashboardViewModel,
  event: WsEvent,
): DashboardViewModel {
  if (event.kind === "agent-status") {
    return {
      ...model,
      agents: upsertBy(model.agents, event.status, (item) => item.agentId),
    };
  }
  if (event.kind === "session-summary") {
    return {
      ...model,
      sessions: upsertBy(model.sessions, event.session, (item) => item.sessionId),
    };
  }
  if (event.kind === "metric") {
    return { ...model, metrics: [...model.metrics, ...event.points].slice(-60) };
  }
  return {
    ...model,
    traces: upsertBy(model.traces, event.trace, (item) => item.turnId),
  };
}

function upsertBy<T>(items: readonly T[], next: T, key: (item: T) => string): readonly T[] {
  const id = key(next);
  const index = items.findIndex((item) => key(item) === id);
  if (index === -1) return [next, ...items];
  return items.map((item, itemIndex) => (itemIndex === index ? next : item));
}
```

```tsx
// packages/ui/dashboard-ui/src/app.tsx
import { useState } from "react";
import { demoAgents, demoMetrics, demoSessions, demoTrace } from "./lib/demo-data.js";
import { AgentList } from "./components/agent-list.js";
import { SessionDetail } from "./components/session-detail.js";
import { TraceViewer } from "./components/trace-viewer.js";
import { MetricsPanel } from "./components/metrics-panel.js";

export function DashboardApp(): JSX.Element {
  const [selectedAgentId, setSelectedAgentId] = useState(demoAgents[0]?.agentId);
  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <h1>Koi Dashboard</h1>
          <p>Live agent operations at a glance.</p>
        </div>
        <span className="connection-badge">Connected</span>
      </header>
      <section className="dashboard-grid">
        <AgentList
          agents={demoAgents}
          selectedAgentId={selectedAgentId}
          onSelect={setSelectedAgentId}
        />
        <div className="dashboard-detail">
          <SessionDetail sessions={demoSessions} selectedAgentId={selectedAgentId} />
          <TraceViewer trace={demoTrace} />
          <MetricsPanel metrics={demoMetrics} />
        </div>
      </section>
    </main>
  );
}
```

- [ ] **Step 4: Add component tests for shell rendering and selection-driven detail**

```typescript
// packages/ui/dashboard-ui/src/__tests__/dashboard-ui.test.tsx
import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { DashboardApp } from "../app.js";

describe("DashboardApp", () => {
  test("renders the selected agent detail", () => {
    render(<DashboardApp />);
    expect(screen.getByText("Recent Sessions")).toBeTruthy();
    expect(screen.getByText("Trace")).toBeTruthy();
    expect(screen.getByText("Metrics")).toBeTruthy();
  });

  test("switches the selected agent from the list", () => {
    render(<DashboardApp />);
    fireEvent.click(screen.getByRole("button", { name: /worker beta/i }));
    expect(screen.getByText("worker-beta-session")).toBeTruthy();
  });
});
```

- [ ] **Step 5: Run the UI package tests**

Run:

```bash
bun test packages/ui/dashboard-ui/src
```

Expected: PASS with the reducer tests and render tests green.

- [ ] **Step 6: Commit the MVP shell and local view-model logic**

```bash
git add \
  packages/ui/dashboard-ui/src/app.tsx \
  packages/ui/dashboard-ui/src/index.css \
  packages/ui/dashboard-ui/src/lib \
  packages/ui/dashboard-ui/src/components \
  packages/ui/dashboard-ui/src/__tests__/dashboard-ui.test.tsx
git commit -m "feat: build dashboard ui mvp shell"
```

---

### Task 5: Wire live data through the aligned dashboard client

**Files:**
- Modify: `packages/ui/dashboard-ui/src/app.tsx`
- Modify: `packages/ui/dashboard-ui/src/lib/demo-data.ts`
- Modify: `packages/ui/dashboard-ui/src/lib/state.ts`
- Modify: `packages/ui/dashboard-ui/src/__tests__/dashboard-ui.test.tsx`
- Optional modify if needed: `packages/lib/dashboard-client/src/client.ts`

- [ ] **Step 1: Add a failing integration-style UI test for snapshot + live patching**

```typescript
// packages/ui/dashboard-ui/src/__tests__/dashboard-ui.test.tsx
import type { DashboardClient } from "@koi/dashboard-client";

test("patches visible state after a live agent-status event", async () => {
  let emit: ((event: Parameters<NonNullable<DashboardClient["subscribe"]>>[1]["onEvent"]) => void) | undefined;
  const client: DashboardClient = {
    listAgents: async () => ({
      ok: true,
      value: [
        {
          agentId: "agent-1",
          name: "Main",
          state: "running",
          agentType: "copilot",
          channels: [],
          turns: 1,
          tokenCount: 10,
          startedAt: 1,
          lastActivityAt: 2,
          childCount: 0,
        },
      ],
    }),
    getAgent: async () => ({ ok: true, value: undefined }),
    listSessions: async () => ({ ok: true, value: [] }),
    getMetrics: async () => ({ ok: true, value: [] }),
    getTrace: async () => ({ ok: true, value: undefined }),
    subscribe: (_topics, handlers) => {
      emit = handlers.onEvent;
      return () => {};
    },
  };

  render(<DashboardApp client={client} />);
  expect(screen.getByText("running")).toBeTruthy();

  emit?.({
    v: 1,
    kind: "agent-status",
    status: {
      agentId: "agent-1",
      name: "Main",
      state: "idle",
      agentType: "copilot",
      channels: [],
      turns: 2,
      tokenCount: 11,
      startedAt: 1,
      lastActivityAt: 3,
      childCount: 0,
    },
  });

  expect(await screen.findByText("idle")).toBeTruthy();
});
```

- [ ] **Step 2: Run the integration test to verify the shell still depends on static demo data**

Run:

```bash
bun test packages/ui/dashboard-ui/src/__tests__/dashboard-ui.test.tsx
```

Expected: FAIL because `DashboardApp` does not yet accept an injected client or patch state from live events.

- [ ] **Step 3: Refactor the app to load snapshots and subscribe to live topics**

```tsx
// packages/ui/dashboard-ui/src/app.tsx
import { useEffect, useState } from "react";
import { createDashboardClient, type DashboardClient } from "@koi/dashboard-client";
import { applyDashboardEvent, createDashboardViewModel } from "./lib/state.js";
import { LoadingState } from "./components/loading-state.js";
import { ErrorState } from "./components/error-state.js";

export function DashboardApp({
  client = createDashboardClient({ baseUrl: "/dashboard" }),
}: {
  readonly client?: DashboardClient;
}): JSX.Element {
  const [model, setModel] = useState(() =>
    createDashboardViewModel({ agents: [], sessions: [], metrics: [], traces: [] }),
  );
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let disposed = false;
    const boot = async () => {
      const [agents, sessions, metrics] = await Promise.all([
        client.listAgents(),
        client.listSessions(),
        client.getMetrics({
          names: ["cpu", "memory"],
          fromMs: Date.now() - 60_000,
          toMs: Date.now(),
        }),
      ]);

      if (disposed) return;
      if (!agents.ok || !sessions.ok || !metrics.ok) {
        setStatus("error");
        return;
      }

      setModel(
        createDashboardViewModel({
          agents: agents.value,
          sessions: sessions.value,
          metrics: metrics.value,
          traces: [],
        }),
      );
      setStatus("ready");
    };

    void boot();
    const unsubscribe = client.subscribe(
      ["agent-status", "session-summary", "metric", "trace"],
      {
        onEvent: (event) => setModel((current) => applyDashboardEvent(current, event)),
      },
    );
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [client]);

  if (status === "loading") return <LoadingState label="Loading dashboard..." />;
  if (status === "error") return <ErrorState label="Unable to load dashboard data." />;
  return <DashboardShell model={model} />;
}
```

- [ ] **Step 4: Run the full UI package tests again**

Run:

```bash
bun test packages/ui/dashboard-ui/src
```

Expected: PASS, including the integration-style live patch test.

- [ ] **Step 5: Run the targeted multi-package verification pass**

Run:

```bash
bun test packages/lib/dashboard-client/src
bun test packages/ui/dashboard-ui/src
bun run --filter @koi/dashboard-client typecheck
bun run --filter @koi/dashboard-ui typecheck
```

Expected: PASS across both packages.

- [ ] **Step 6: Commit the end-to-end wiring**

```bash
git add packages/ui/dashboard-ui/src
git commit -m "feat: wire dashboard ui to live dashboard client"
```

---

## Self-Review Checklist

- Spec coverage:
  - transport alignment is covered by Task 1 and Task 2
  - new `dashboard-ui` package scaffold is covered by Task 3
  - agent/session/trace/metrics MVP rendering is covered by Task 4
  - real-time updates and degraded behavior wiring are covered by Task 5
- Placeholder scan:
  - no `TODO`, `TBD`, or “implement later” placeholders remain in this plan
- Type consistency:
  - plan uses the existing `AgentStatus`, `SessionSummary`, `MetricPoint`, `TraceView`, and `WsEvent` shapes from `@koi/dashboard-types`
  - live transport is consistently described as SSE and `/api/events`

