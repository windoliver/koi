# Design: `@koi/dashboard-ui` MVP + SSE Client Alignment

**Date:** 2026-05-07
**Issue:** [#1383](https://github.com/windoliver/koi/issues/1383)
**Approach:** A — align the dashboard client to the existing SSE API first, then build a narrow React/Vite MVP UI on top

---

## Overview

Issue `#1383` adds the missing v2 dashboard web UI. The active tree already has the backend and shared contracts needed to support this work:

- `@koi/dashboard-types`
- `@koi/dashboard-api`
- `@koi/dashboard-client`

What is missing is the actual UI package and a transport-consistent client surface. Today the API package exposes live updates through SSE at `/events`, while the client package and its docs still describe a WebSocket subscription surface at `/api/ws`. The first implementation step must remove that contradiction so the UI can consume a single real transport without carrying compatibility glue or speculative abstractions.

This design therefore splits the work into two tightly scoped parts:

1. align `@koi/dashboard-client` to the existing SSE-based dashboard API
2. add a new `@koi/dashboard-ui` package that proves the full stack end to end with a deliberately small operator-facing MVP

The MVP includes:

- agent list view
- session detail view
- trace viewer
- basic live metrics
- real-time connection status
- responsive single-shell layout

The MVP explicitly does not recreate the breadth of the archived v1 dashboard.

---

## Scope

### In scope

- standardize v2 dashboard live updates on SSE
- update `@koi/dashboard-client` subscription internals to consume `/events`
- reconcile dashboard docs so API, client, and UI all describe the same transport
- create a new `@koi/dashboard-ui` package in the active tree
- build a single-route operator dashboard shell
- render agent summaries with live status updates
- render session details for the selected agent/session
- render a simple trace tree for the selected trace or turn
- render lightweight metrics visualizations with live updates
- cover loading, empty, degraded-connection, and error states
- add focused tests for client subscription behavior and UI state updates

### Out of scope

- restoring v1 console/chat/browser/file-tree surfaces
- orchestration, scheduler, or self-improvement pages from v1
- multi-route application architecture beyond what the MVP needs
- dual transport support for SSE and WebSocket
- backend transport expansion to add `/api/ws`
- broad dashboard auth redesign beyond existing bearer-token usage
- complex caching or sync frameworks unless the implementation proves they are necessary

---

## Existing State

### Packages already present

| Package | Status | Notes |
|---------|--------|-------|
| `packages/lib/dashboard-types` | implemented | current shared read models and event types |
| `packages/lib/dashboard-api` | implemented | exposes REST + SSE endpoints |
| `packages/lib/dashboard-client` | implemented | HTTP methods exist; live subscription still assumes WebSocket |

### Missing package

No live `dashboard-ui` package exists in the active tree. There is also no current React/Vite app scaffold in the monorepo dedicated to dashboard work.

### Reference code

The old reference implementation remains useful as a source of ideas and visual patterns, but not as a package to revive wholesale:

- `/Users/sophiawj/private/koi/archive/v1/packages/observability/dashboard-ui`

The v1 package was intentionally much broader than the issue target. It should be mined for:

- shell/layout ideas
- trace tree rendering ideas
- loading and empty state patterns
- small formatting utilities

It should not be ported page-for-page.

---

## Package Structure

### New package

| Package | Layer | Purpose |
|---------|-------|---------|
| `@koi/dashboard-ui` | L2 | React/Vite operator dashboard consuming `@koi/dashboard-client` and `@koi/dashboard-types` |

### Existing packages modified

| Package | Reason |
|---------|--------|
| `@koi/dashboard-client` | replace WebSocket subscription internals with SSE subscription support |
| `@koi/dashboard-api` | no transport redesign expected; only adjust docs or tiny compatibility affordances if tests reveal naming drift |
| `docs/L2/*dashboard*` | remove transport contradictions and document the actual MVP shape |

### Directory layout

```text
packages/
├── lib/
│   ├── dashboard-api/
│   ├── dashboard-client/
│   └── dashboard-types/
└── ui/
    └── dashboard-ui/
        ├── package.json
        ├── tsconfig.json
        ├── vite.config.ts
        ├── index.html
        └── src/
            ├── main.tsx
            ├── app.tsx
            ├── index.css
            ├── lib/
            ├── components/
            └── __tests__/
```

Placing the package under `packages/ui/` keeps it aligned with the monorepo layout while clearly distinguishing it from the lower-level dashboard libraries in `packages/lib/`.

---

## Architecture

### 1. SSE becomes the canonical v2 dashboard transport

The API already exposes:

- REST endpoints for snapshot reads
- `GET /events` for live updates using SSE batching

The client package must align to that reality instead of forcing the server toward WebSockets before the UI exists. For v2 phase 3, the transport decision is:

- canonical live transport: SSE
- canonical snapshot transport: HTTP fetch

This keeps the implementation grounded in the current server behavior and minimizes scope before UI delivery.

### 2. Preserve a stable client API surface where possible

`@koi/dashboard-client` should still expose a single high-level `subscribe(...)` entrypoint to UI consumers. The implementation beneath it changes from WebSocket framing to SSE event consumption.

That means the UI should not know or care whether live updates arrive via:

- `EventSource`
- streamed `fetch`
- a future alternate transport

The client is responsible for that mapping.

### 3. The UI stays single-shell and operator-first

The UI should open into one dashboard shell with three coordinated surfaces:

- agent list/grid
- detail pane for the current selection
- metrics/trace supporting views

This preserves a clear MVP and avoids multi-page sprawl. If later issues add deeper drill-downs or navigation, those can be layered in after the basic operator workflow is proven.

---

## Transport Alignment

### Current mismatch

Current state is contradictory:

- `dashboard-api` implements SSE at `/events`
- `dashboard-client` currently targets `/api/ws`
- docs disagree about whether the real-time channel is SSE or WebSocket

That mismatch is a blocker for `#1383`, because the UI cannot safely choose a client contract while both are simultaneously "official."

### Decision

Standardize on SSE for this issue and phase.

### Client changes

`@koi/dashboard-client` should be refactored so:

- `subscribe(topics, handlers)` opens an SSE stream against `/api/events`
- topic filtering is translated into the existing `topics=` query parameter
- incoming SSE `batch` events are parsed and re-emitted to `handlers.onEvent`
- malformed frames are ignored
- connection/open/error/close conditions are converted into the current `onError` / `onClose` style callbacks where still useful

The high-level consumer contract should remain as stable as possible:

```typescript
subscribe(topics, handlers): Unsubscribe
```

The concrete injected transport dependency will likely change from `WebSocket` to either:

- `EventSource`
- a small browser/runtime-agnostic SSE adapter

The design recommendation is to prefer a small adapter abstraction rather than binding the entire client directly to browser-global `EventSource` semantics, because tests and non-browser runtimes may still need injection.

### API changes

No new WebSocket endpoint should be added for this issue.

The API package should only change if minor compatibility gaps appear during client integration, for example:

- event payload naming drift
- route prefix drift
- missing docs/examples

The target is client alignment, not server transport expansion.

### Documentation changes

Update:

- `docs/L2/dashboard.md`
- `docs/L2/dashboard-api.md`
- `docs/L2/dashboard-client.md`

So they consistently state:

- REST + SSE
- no WebSocket dashboard transport in this phase
- the UI consumes the dashboard client rather than talking to raw transport primitives directly

---

## `@koi/dashboard-ui` MVP

### Responsibilities

- render live agent state
- let an operator inspect sessions related to the current selection
- show a compact trace tree for the active trace
- show a small set of live metrics
- surface connection state and degraded behavior clearly

### Not responsible for

- editing agent configuration
- lifecycle orchestration beyond what the existing dashboard endpoints already expose
- chat or shell interaction
- deploy workflows
- historical analytics beyond the bounded metrics/trace views already supported by current contracts

### Primary user flow

```text
Open dashboard
  -> initial snapshot load
  -> see agents and connection status
  -> choose an agent
  -> inspect recent sessions for that agent
  -> choose a session / trace target
  -> inspect session details + trace tree + live metrics
  -> watch live updates patch the visible state
```

---

## UI Composition

### Top-level shell

The dashboard is a single responsive shell with:

- header: product name, connection indicator, refresh affordance
- main content: two-column or stacked responsive layout
- left pane: agent list or grid
- right pane: selection detail tabs or sections for session, trace, and metrics

Recommended behavior:

- desktop: split view
- tablet/mobile: stacked sections with the selected detail below the list

### Agent view

Display each agent with:

- name / id
- lifecycle state
- model
- parent relationship if present
- channel summary
- last-updated or active indicator

The view should optimize for quick scanning rather than dense admin-table completeness.

### Session detail view

For the selected agent, render:

- recent sessions list
- selected session summary
- token / cost / timing summary if present in the model
- graceful fallback when no sessions exist

The design should tolerate incomplete or delayed session data.

### Trace viewer

The MVP trace viewer is a compact span tree:

- nested span labels
- duration
- error marker when relevant
- collapsed/expanded tree rows if needed

It should not include advanced filtering, search, diffing, or timeline overlays in the first pass.

### Metrics view

Render a lightweight time-series display for a small number of metrics. The first pass should favor:

- minimal custom sparkline-like charts
- or a small, purposeful chart dependency if hand-rolled rendering becomes too costly

The design should avoid pulling in a heavy visualization stack unless the implementation clearly benefits.

---

## Data Flow and State

### Snapshot + stream model

The UI uses:

- REST for initial load and explicit re-selection
- SSE for incremental updates

Flow:

```text
initial render
  -> fetch agents
  -> fetch sessions
  -> fetch metrics
  -> fetch traces as needed
  -> subscribe to live topics
  -> patch visible state as events arrive
```

### Selection state

Keep these as explicit UI state:

- `selectedAgentId`
- `selectedSessionId`
- selected trace or turn identifier

These are local application concerns and should not be derived indirectly from server event ordering.

### Resource state

Use a minimal normalized in-memory shape only where it helps targeted live updates. Avoid introducing a large state framework unless the component tree proves it necessary.

The default implementation preference is:

- React state/context for shell-level selection and connection state
- a small helper layer for patching collections from SSE updates

Only introduce a broader shared state store if the update paths become materially simpler because of it.

### Connection state

The UI should explicitly represent:

- connected
- reconnecting / degraded
- disconnected

If the SSE stream drops:

- show a visible degraded banner or badge
- keep the last known data on screen
- allow manual refresh
- optionally fall back to bounded polling if that becomes necessary during implementation

---

## Testing Strategy

### `@koi/dashboard-client`

Add tests for:

- translating topic lists into SSE query parameters
- parsing SSE batch frames into individual dashboard events
- ignoring malformed payloads
- surfacing terminal connection failures predictably

### `@koi/dashboard-ui`

Add tests for:

- agent list rendering
- session detail rendering
- trace tree rendering
- metrics rendering with sample data
- loading / empty / error / degraded-connection states
- live event patching after the initial snapshot load

### Integration level

Include at least one integration-style test that proves:

1. initial snapshot data is rendered
2. a subsequent live event updates the visible UI without a full page refresh

The first implementation pass does not require browser E2E unless a concrete runtime issue appears that component/integration tests cannot cover.

---

## Dependencies and Tooling

### Required additions

The new UI package will need:

- React
- React DOM
- Vite
- TypeScript package wiring consistent with the monorepo
- test utilities appropriate for component rendering in the repo

### Preferred dependency posture

Start small. Add only the libraries required to ship the MVP. Specifically:

- do not assume Zustand is required
- do not assume TanStack Query is required
- do not assume a heavy charting library is required

Each additional dependency should be justified by a clear simplification in the implementation.

---

## Risks and Mitigations

### Risk: transport refactor bleeds into backend redesign

Mitigation:

- treat SSE as settled for this issue
- do not add `/api/ws`
- constrain changes in `dashboard-api` to compatibility fixes only

### Risk: v1 UI complexity leaks into the MVP

Mitigation:

- keep a strict single-shell scope
- mine v1 only for reusable ideas, not feature parity
- defer secondary pages and tools explicitly

### Risk: live patching logic becomes brittle

Mitigation:

- keep event-to-state patching centralized in a small helper layer
- test the patch behavior with representative event sequences
- fall back to targeted refetch where event semantics are insufficient

### Risk: mobile/responsive layout gets deferred until too late

Mitigation:

- treat responsive behavior as part of the initial shell
- test narrow viewport layouts during the first implementation pass

---

## Implementation Sequence

1. align `@koi/dashboard-client` to SSE
2. update the dashboard docs to match the transport decision
3. scaffold `@koi/dashboard-ui`
4. render the shell and agent list from snapshot data
5. add selection-driven session detail
6. add trace viewer
7. add live metrics
8. wire real-time updates through the SSE-aligned client
9. add tests for client and UI behavior

This order keeps the transport seam settled before any UI code depends on it.

---

## Success Criteria

This issue is successful when:

- there is one transport story across code and docs
- `@koi/dashboard-client` consumes the implemented SSE endpoint
- a new `@koi/dashboard-ui` package exists in the active tree
- the UI can render agents, session detail, traces, and metrics from current dashboard contracts
- visible state updates live through the aligned client
- loading, empty, error, and degraded connection states are covered
- the result stays recognizably smaller and simpler than the archived v1 dashboard
