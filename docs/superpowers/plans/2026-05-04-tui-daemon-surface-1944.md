# TUI Daemon Surface (#1944) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the real `@koi/net/daemon` `Supervisor` into the CLI bootstrap and surface its state in the TUI (status-line badge, alert toasts, `/supervisor`, `/bg`, spawn-tool enrichment, inline events) — closing the gap left by the in-process stub from #1866.

**Architecture:** A new bridge in `packages/meta/cli/src/daemon-bridge.ts` subscribes to `Supervisor.watchAll()`/`health()` and `BackgroundSessionRegistry.describeList()`/`watch()`, then dispatches into the existing TUI store. The bridge has two construction modes: `registry-only` (no supervisor; `/bg` still renders) and `live` (full surface). `wire-daemon-supervisor.ts` composes `createSupervisor + createFileSessionRegistry + attachRegistry` and is invoked from `tui-command.ts` only when the manifest declares subprocess supervision. TUI components stay pure renderers driven by the store.

**Tech Stack:** TypeScript 6 strict (`@koi/core` L0 types), Bun 1.3.x runtime, `bun:test`, Ink/React for TUI, existing `@koi/net/daemon` (L2) and `@koi/tui` (L2) packages. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-04-tui-daemon-surface-1944-design.md` — every task references it for the contracts, code, and acceptance criteria. Read `## File Layout`, `## State Slices`, `## Data Flow Details`, `## Testing` before starting.

---

## Constraints (re-read before every task)

- L2 packages may import only from `@koi/core` (L0) and L0u utilities. `@koi/tui` (L2) MUST NOT import from `@koi/net/daemon` (L2). Bridge code (L3, in `packages/meta/cli`) is the integration point.
- All exported functions need explicit return types (`isolatedDeclarations`).
- All interface fields `readonly`; arrays `readonly T[]`; `as const` for literal config.
- Use `import type` for type-only imports (`verbatimModuleSyntax`).
- File ≤ 400 lines typical, 800 hard max. Function ≤ 50 lines.
- Tests colocated (`foo.ts` + `foo.test.ts`), integration in `__tests__/`.
- Coverage ≥ 80% (`bunfig.toml`).
- No `any`, `!`, `as Type`, `enum`, `namespace`, `class` (default).
- Commit after each green test cycle.

---

## File Map

| Path | Action | Approx LOC |
|------|--------|------------|
| `packages/meta/cli/src/daemon-bridge.ts` | new | ~240 |
| `packages/meta/cli/src/daemon-bridge.test.ts` | new | ~600 |
| `packages/meta/cli/src/wire-daemon-supervisor.ts` | new | ~180 |
| `packages/meta/cli/src/wire-daemon-supervisor.test.ts` | new | ~150 |
| `packages/meta/cli/src/tui-command.ts` | edit | ~40 |
| `packages/ui/tui/src/state/types.ts` | edit | ~80 |
| `packages/ui/tui/src/state/initial.ts` | edit | ~12 |
| `packages/ui/tui/src/state/reduce.ts` | edit | ~120 |
| `packages/ui/tui/src/state/reduce.test.ts` | edit | +~250 |
| `packages/ui/tui/src/state/mutations.ts` | edit | ~30 |
| `packages/ui/tui/src/components/StatusBar.tsx` | edit | ~40 |
| `packages/ui/tui/src/components/StatusBar.test.tsx` | edit | +~80 |
| `packages/ui/tui/src/components/SupervisorView.tsx` | new | ~250 |
| `packages/ui/tui/src/components/SupervisorView.test.tsx` | new | ~150 |
| `packages/ui/tui/src/components/BgView.tsx` | new | ~280 |
| `packages/ui/tui/src/components/BgView.test.tsx` | new | ~250 |
| `packages/ui/tui/src/components/BgLogTail.tsx` | new | ~80 |
| `packages/ui/tui/src/components/BgLogTail.test.tsx` | new | ~250 |
| `packages/ui/tui/src/tui-root.tsx` | edit | ~50 |
| `packages/ui/tui/src/commands/command-definitions.ts` | edit | ~25 |
| `packages/ui/tui/src/tool-display.ts` | edit | ~40 |
| `packages/ui/tui/src/__tests__/daemon-tui-e2e.test.ts` | new (gated) | ~200 |

Total ~1150 LOC implementation + ~1700 LOC tests.

---

## Task 1: State types — supervisor + bg slices

**Files:**
- Modify: `packages/ui/tui/src/state/types.ts`

Source-of-truth: spec `## State Slices` block (lines ~292–455). Copy the type definitions verbatim, including `ChannelLiveness`, `BridgeStatus`, `RegistryStatus`, `SupervisorSlice`, `SupervisorEventEntry`, `BgSessionRow` (full freshness union), `BgSessionsSlice`, and the dispatch action discriminants.

- [ ] **Step 1.1: Add type imports + slice declarations**

```ts
// at top of types.ts, with the other @koi/core imports
import type {
  SupervisorHealth,
  WorkerEvent,
  WorkerHealth,
  WorkerBackendKind,
  BackgroundSessionStatus,
} from "@koi/core/daemon";

export const SUPERVISOR_EVENT_BUFFER_CAP = 50;
```

Then paste the `ChannelLiveness`, `BridgeStatus`, `RegistryStatus`, `SupervisorSlice`, `SupervisorEventEntry`, `BgSessionRow`, `BgSessionsSlice` interfaces from the spec verbatim. All fields `readonly`. Export every type.

- [ ] **Step 1.2: Add the new dispatch action variants**

Find the existing `Action` discriminated union in `types.ts`. Add these variants (kinds match spec):

```ts
| { readonly kind: "set_supervisor_attached"; readonly attached: boolean }
| { readonly kind: "set_supervisor_status"; readonly status: BridgeStatus }
| { readonly kind: "set_supervisor_health"; readonly health: SupervisorHealth | null }
| { readonly kind: "push_supervisor_event"; readonly entry: SupervisorEventEntry }
| { readonly kind: "clear_supervisor_events" }
| { readonly kind: "set_bg_rows"; readonly rows: readonly BgSessionRow[] }
| { readonly kind: "set_bg_registry_status"; readonly status: RegistryStatus }
| { readonly kind: "set_bg_tailing"; readonly workerId: string | null }
| {
    readonly kind: "set_bg_kill_confirm";
    readonly confirm:
      | { readonly workerId: string; readonly version: number; readonly pid: number }
      | null;
  }
```

- [ ] **Step 1.3: Add slices to the `State` interface**

```ts
readonly supervisor: SupervisorSlice;
readonly bg: BgSessionsSlice;
```

- [ ] **Step 1.4: Verify types compile**

Run: `bun run typecheck --filter=@koi/tui`
Expected: PASS (no usages yet so unused-export errors won't fire — types live).

- [ ] **Step 1.5: Commit**

```bash
git add packages/ui/tui/src/state/types.ts
git commit -m "feat(tui): add supervisor + bg state slice types (#1944)"
```

---

## Task 2: Initial state defaults

**Files:**
- Modify: `packages/ui/tui/src/state/initial.ts`

- [ ] **Step 2.1: Add default slices to `INITIAL_STATE`**

```ts
supervisor: {
  attached: false,
  status: { kind: "detached" },
  health: null,
  events: [],
},
bg: {
  rows: [],
  registryStatus: { kind: "live" },
  tailingWorkerId: null,
  killConfirm: null,
},
```

- [ ] **Step 2.2: Typecheck + commit**

Run: `bun run typecheck --filter=@koi/tui` → PASS

```bash
git add packages/ui/tui/src/state/initial.ts
git commit -m "feat(tui): seed supervisor + bg slices in initial state (#1944)"
```

---

## Task 3: Reducer — supervisor slice actions (TDD)

**Files:**
- Test: `packages/ui/tui/src/state/reduce.test.ts`
- Modify: `packages/ui/tui/src/state/reduce.ts`

- [ ] **Step 3.1: Write failing tests for supervisor actions**

Add a `describe("supervisor slice", () => { ... })` block covering:

```ts
test("set_supervisor_attached toggles attached + clears health when detaching", () => {
  const s1 = reduce(INITIAL_STATE, { kind: "set_supervisor_attached", attached: true });
  expect(s1.supervisor.attached).toBe(true);

  const withHealth = reduce(s1, {
    kind: "set_supervisor_health",
    health: SAMPLE_HEALTH, // build a SupervisorHealth fixture
  });
  const s2 = reduce(withHealth, { kind: "set_supervisor_attached", attached: false });
  expect(s2.supervisor.attached).toBe(false);
  expect(s2.supervisor.health).toBeNull();
});

test("set_supervisor_status replaces status object", () => {
  const next = reduce(INITIAL_STATE, {
    kind: "set_supervisor_status",
    status: { kind: "live" },
  });
  expect(next.supervisor.status).toEqual({ kind: "live" });
});

test("push_supervisor_event prepends + caps at 50", () => {
  let s = INITIAL_STATE;
  for (let i = 0; i < 60; i++) {
    s = reduce(s, {
      kind: "push_supervisor_event",
      entry: { id: `e${i}`, ts: i, kind: "started", workerId: "w", agentName: "a" },
    });
  }
  expect(s.supervisor.events.length).toBe(50);
  expect(s.supervisor.events[0]?.id).toBe("e59"); // newest first
  expect(s.supervisor.events[49]?.id).toBe("e10"); // oldest kept
});

test("clear_supervisor_events empties buffer", () => {
  const seeded = reduce(INITIAL_STATE, {
    kind: "push_supervisor_event",
    entry: { id: "x", ts: 0, kind: "started", workerId: "w", agentName: "a" },
  });
  const cleared = reduce(seeded, { kind: "clear_supervisor_events" });
  expect(cleared.supervisor.events).toEqual([]);
});
```

Define `SAMPLE_HEALTH` once at top of file matching `SupervisorHealth`:

```ts
const SAMPLE_HEALTH: SupervisorHealth = {
  status: "ok",
  reasons: [],
  workers: [],
  metrics: {
    poolSize: 0,
    maxWorkers: 4,
    quarantinedCount: 0,
    restartingCount: 0,
    pendingSpawnCount: 0,
    eventDropCount: 0,
    shuttingDown: false,
  },
};
```

(Verify field names against `packages/kernel/core/src/daemon.ts` before pasting — adjust if the L0 type drifted.)

- [ ] **Step 3.2: Run tests, expect failures**

Run: `bun test packages/ui/tui/src/state/reduce.test.ts`
Expected: FAIL — reducer doesn't handle the new action kinds.

- [ ] **Step 3.3: Implement reducer cases**

In `reduce.ts`, add to the switch:

```ts
case "set_supervisor_attached": {
  const next = action.attached;
  return {
    ...state,
    supervisor: {
      ...state.supervisor,
      attached: next,
      health: next ? state.supervisor.health : null,
    },
  };
}
case "set_supervisor_status":
  return { ...state, supervisor: { ...state.supervisor, status: action.status } };
case "set_supervisor_health":
  return { ...state, supervisor: { ...state.supervisor, health: action.health } };
case "push_supervisor_event": {
  const events = [action.entry, ...state.supervisor.events].slice(
    0,
    SUPERVISOR_EVENT_BUFFER_CAP,
  );
  return { ...state, supervisor: { ...state.supervisor, events } };
}
case "clear_supervisor_events":
  return { ...state, supervisor: { ...state.supervisor, events: [] } };
```

- [ ] **Step 3.4: Run tests, expect pass**

Run: `bun test packages/ui/tui/src/state/reduce.test.ts`
Expected: PASS.

- [ ] **Step 3.5: Commit**

```bash
git add packages/ui/tui/src/state/reduce.ts packages/ui/tui/src/state/reduce.test.ts
git commit -m "feat(tui): reducer cases for supervisor slice (#1944)"
```

---

## Task 4: Reducer — bg slice actions + freshness pure function (TDD)

**Files:**
- Modify: `packages/ui/tui/src/state/reduce.ts`
- Modify: `packages/ui/tui/src/state/reduce.test.ts`
- Create: `packages/ui/tui/src/state/freshness.ts`
- Create: `packages/ui/tui/src/state/freshness.test.ts`

The freshness algorithm has its own pure function so it can be unit-tested independently of the reducer. Source-of-truth: spec `### Freshness computation` (lines ~637–763).

- [ ] **Step 4.1: Write failing tests for `freshness.ts`**

Create `packages/ui/tui/src/state/freshness.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { BgSessionRow } from "./types.js";
import type { SupervisorHealth, WorkerHealth } from "@koi/core/daemon";
import { computeFreshness } from "./freshness.js";

const NOW = 1_700_000_000_000;
const baseRow = (overrides: Partial<BgSessionRow> = {}): BgSessionRow => ({
  workerId: "w1",
  agentId: "a1",
  sessionId: null,
  status: "running",
  pid: 1234,
  startedAt: NOW - 60_000,
  endedAt: null,
  exitCode: null,
  lastHeartbeatAt: null,
  heartbeatDeadlineAt: null,
  logPath: "/tmp/log",
  backendKind: "subprocess",
  version: 1,
  signaledAt: null,
  freshness: "ok",
  ...overrides,
});

const health = (workers: readonly WorkerHealth[]): SupervisorHealth => ({
  status: "ok",
  reasons: [],
  workers,
  metrics: {
    poolSize: workers.length,
    maxWorkers: 4,
    quarantinedCount: 0,
    restartingCount: 0,
    pendingSpawnCount: 0,
    eventDropCount: 0,
    shuttingDown: false,
  },
});

describe("computeFreshness", () => {
  test("running + no health entry → foreign", () => {
    const row = baseRow({ status: "running" });
    expect(computeFreshness({ row, health: health([]), locallySpawnedIds: new Set(), now: NOW })).toBe("foreign");
  });

  test("running + health.state restarting overrides registry status", () => {
    const row = baseRow({ status: "crashed" });
    const h = health([{ workerId: "w1", agentId: "a1", state: "restarting" }]);
    expect(computeFreshness({ row, health: h, locallySpawnedIds: new Set(), now: NOW })).toBe("restarting");
  });

  test("running + heartbeat opted out → unmonitored", () => {
    const row = baseRow();
    const h = health([{ workerId: "w1", agentId: "a1", state: "running" }]);
    expect(computeFreshness({ row, health: h, locallySpawnedIds: new Set(), now: NOW })).toBe("unmonitored");
  });

  test("running + heartbeat fresh → ok", () => {
    const row = baseRow({ lastHeartbeatAt: NOW - 1000, heartbeatDeadlineAt: NOW + 5000 });
    const h = health([{
      workerId: "w1", agentId: "a1", state: "running",
      lastHeartbeatAt: NOW - 1000, heartbeatDeadlineAt: NOW + 5000,
    }]);
    expect(computeFreshness({ row, health: h, locallySpawnedIds: new Set(), now: NOW })).toBe("ok");
  });

  test("starting + workerId in locallySpawnedIds → pending within grace", () => {
    const row = baseRow({ status: "starting", startedAt: NOW - 10_000, pid: 0 });
    const ids = new Set(["w1"]);
    expect(computeFreshness({ row, health: health([]), locallySpawnedIds: ids, now: NOW })).toBe("pending");
  });

  test("starting + workerId NOT in locallySpawnedIds → foreign (registry-only mode)", () => {
    const row = baseRow({ status: "starting", startedAt: NOW - 10_000, pid: 0 });
    expect(computeFreshness({ row, health: health([]), locallySpawnedIds: new Set(), now: NOW })).toBe("foreign");
  });

  test("starting locally-spawned past 30s grace → timeout", () => {
    const row = baseRow({ status: "starting", startedAt: NOW - 60_000, pid: 0 });
    const ids = new Set(["w1"]);
    expect(computeFreshness({ row, health: health([]), locallySpawnedIds: ids, now: NOW })).toBe("timeout");
  });

  test("status terminating short-circuits", () => {
    expect(
      computeFreshness({
        row: baseRow({ status: "terminating", signaledAt: NOW - 1000 }),
        health: health([]),
        locallySpawnedIds: new Set(),
        now: NOW,
      }),
    ).toBe("terminating");
  });

  test("status detached short-circuits", () => {
    expect(
      computeFreshness({
        row: baseRow({ status: "detached" }),
        health: health([]),
        locallySpawnedIds: new Set(),
        now: NOW,
      }),
    ).toBe("detached");
  });

  test("exited + no health override → terminal", () => {
    expect(
      computeFreshness({
        row: baseRow({ status: "exited", endedAt: NOW - 1000, exitCode: 0 }),
        health: health([]),
        locallySpawnedIds: new Set(),
        now: NOW,
      }),
    ).toBe("terminal");
  });

  test("crashed + health restarting → restarting (override)", () => {
    const row = baseRow({ status: "crashed" });
    const h = health([{ workerId: "w1", agentId: "a1", state: "restarting" }]);
    expect(computeFreshness({ row, health: h, locallySpawnedIds: new Set(), now: NOW })).toBe("restarting");
  });

  test("running + heartbeat past deadline within interval → stale", () => {
    const row = baseRow();
    const h = health([{
      workerId: "w1", agentId: "a1", state: "running",
      lastHeartbeatAt: NOW - 6000, heartbeatDeadlineAt: NOW - 1000,
    }]);
    expect(computeFreshness({ row, health: h, locallySpawnedIds: new Set(), now: NOW })).toBe("stale");
  });

  test("running + heartbeat past 2× interval → timeout", () => {
    const row = baseRow();
    const h = health([{
      workerId: "w1", agentId: "a1", state: "running",
      lastHeartbeatAt: NOW - 12_000, heartbeatDeadlineAt: NOW - 7000,
    }]);
    expect(computeFreshness({ row, health: h, locallySpawnedIds: new Set(), now: NOW })).toBe("timeout");
  });
});
```

- [ ] **Step 4.2: Run tests, expect failures**

Run: `bun test packages/ui/tui/src/state/freshness.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4.3: Implement `freshness.ts`**

Translate the spec's `### Freshness computation` pseudocode into a pure function:

```ts
import type { SupervisorHealth } from "@koi/core/daemon";
import type { BgSessionRow } from "./types.js";

export interface FreshnessInput {
  readonly row: BgSessionRow;
  readonly health: SupervisorHealth | null;
  readonly locallySpawnedIds: ReadonlySet<string>;
  readonly now: number;
}

const PENDING_GRACE_MS = 30_000;

export function computeFreshness(input: FreshnessInput): BgSessionRow["freshness"] {
  const { row, health, locallySpawnedIds, now } = input;
  const workerSnap = health?.workers.find((w) => w.workerId === row.workerId);

  if (workerSnap !== undefined) {
    if (workerSnap.state === "quarantined") return "quarantined";
    if (workerSnap.state === "restarting") return "restarting";
    if (workerSnap.state === "stopping") return "stopping";
  }

  if (row.status === "exited" || row.status === "crashed") return "terminal";
  if (row.status === "detached") return "detached";
  if (row.status === "terminating") return "terminating";

  if (row.status === "starting") {
    if (!locallySpawnedIds.has(row.workerId)) return "foreign";
    if (now - row.startedAt < PENDING_GRACE_MS) return "pending";
    return "timeout";
  }

  // row.status === "running"
  if (workerSnap === undefined) return "foreign";

  const last = workerSnap.lastHeartbeatAt ?? null;
  const deadline = workerSnap.heartbeatDeadlineAt ?? null;
  if (deadline === null) return "unmonitored";
  if (last === null) {
    if (now - row.startedAt < PENDING_GRACE_MS) return "pending";
    return "timeout";
  }
  if (now <= deadline) return "ok";
  const interval = deadline - last;
  if (now - deadline < interval) return "stale";
  return "timeout";
}
```

- [ ] **Step 4.4: Run tests, expect pass**

Run: `bun test packages/ui/tui/src/state/freshness.test.ts`
Expected: all PASS.

- [ ] **Step 4.5: Add bg-action reducer cases + tests**

In `reduce.test.ts` add:

```ts
describe("bg slice", () => {
  test("set_bg_rows replaces rows", () => {
    const rows: BgSessionRow[] = [/* one fixture */];
    const next = reduce(INITIAL_STATE, { kind: "set_bg_rows", rows });
    expect(next.bg.rows).toEqual(rows);
  });
  test("set_bg_registry_status replaces status", () => {
    const next = reduce(INITIAL_STATE, {
      kind: "set_bg_registry_status",
      status: { kind: "stale", since: 1, reason: "boom" },
    });
    expect(next.bg.registryStatus).toEqual({ kind: "stale", since: 1, reason: "boom" });
  });
  test("set_bg_tailing toggles workerId", () => {
    const a = reduce(INITIAL_STATE, { kind: "set_bg_tailing", workerId: "w1" });
    expect(a.bg.tailingWorkerId).toBe("w1");
    const b = reduce(a, { kind: "set_bg_tailing", workerId: null });
    expect(b.bg.tailingWorkerId).toBeNull();
  });
  test("set_bg_kill_confirm toggles confirm payload", () => {
    const c = reduce(INITIAL_STATE, {
      kind: "set_bg_kill_confirm",
      confirm: { workerId: "w1", version: 3, pid: 7 },
    });
    expect(c.bg.killConfirm).toEqual({ workerId: "w1", version: 3, pid: 7 });
  });
});
```

In `reduce.ts` add the four cases following the same pattern as Task 3.

- [ ] **Step 4.6: Run + commit**

Run: `bun test packages/ui/tui/src/state` → PASS

```bash
git add packages/ui/tui/src/state
git commit -m "feat(tui): freshness compute + bg-slice reducer cases (#1944)"
```

---

## Task 5: Mutations helper for bridge → store wiring

**Files:**
- Modify: `packages/ui/tui/src/state/mutations.ts`

The bridge dispatches actions through a thin facade so it doesn't import store internals. Add helper exports that wrap `dispatch`:

- [ ] **Step 5.1: Add exports**

```ts
export function applySupervisorAttached(d: Dispatch, attached: boolean): void {
  d({ kind: "set_supervisor_attached", attached });
}
export function applySupervisorStatus(d: Dispatch, status: BridgeStatus): void {
  d({ kind: "set_supervisor_status", status });
}
export function applySupervisorHealth(d: Dispatch, health: SupervisorHealth | null): void {
  d({ kind: "set_supervisor_health", health });
}
export function pushSupervisorEvent(d: Dispatch, entry: SupervisorEventEntry): void {
  d({ kind: "push_supervisor_event", entry });
}
export function applyBgRows(d: Dispatch, rows: readonly BgSessionRow[]): void {
  d({ kind: "set_bg_rows", rows });
}
export function applyBgRegistryStatus(d: Dispatch, status: RegistryStatus): void {
  d({ kind: "set_bg_registry_status", status });
}
```

(`Dispatch` already exported from `state/types.ts`. Add `import type` for new types.)

- [ ] **Step 5.2: Typecheck + commit**

Run: `bun run typecheck --filter=@koi/tui` → PASS

```bash
git add packages/ui/tui/src/state/mutations.ts
git commit -m "feat(tui): bridge dispatch helpers (#1944)"
```

---

## Task 6: `daemon-bridge.ts` — registry-only mode (TDD)

**Files:**
- Create: `packages/meta/cli/src/daemon-bridge.ts`
- Create: `packages/meta/cli/src/daemon-bridge.test.ts`

This is the foundation: a bridge that only reads `BackgroundSessionRegistry` and emits bg rows + registry status. The live mode (Task 7) extends this. Source-of-truth: spec `### Bridge subscription + poll cadence`, `### Bridge ownership model`, `### Bridge failure handling` (lines ~459–605).

- [ ] **Step 6.1: Write failing tests**

Create the test file with these cases:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDaemonBridge } from "./daemon-bridge.js";
// Build an in-memory fake BackgroundSessionRegistry exposing
// describeList()/list()/describe()/get()/watch().

describe("daemon-bridge (registry-only mode)", () => {
  test("dispatches set_bg_rows from describeList polls", async () => { /* ... */ });
  test("3-strike describeList failure flips registryStatus to stale", async () => { /* ... */ });
  test("registry.watch() outage flips registryStatus to degraded; polls keep updating rows", async () => { /* ... */ });
  test("registryStatus → live restoration emits info toast once", async () => { /* ... */ });
  test("close() drains poll loop + watch consumer; no leaked timers", async () => { /* ... */ });
  test("registry.describeList returning Result.ok:false counts as failure", async () => { /* ... */ });
  test("close during watch backoff cancels via closed sentinel", async () => { /* ... */ });
});
```

For each test, build a fake registry with controllable behavior. Use `bun:test`'s `mock()` for poll counts, fake timers via `Bun.setTimeout` if needed.

- [ ] **Step 6.2: Run tests, expect FAIL**

Run: `bun test packages/meta/cli/src/daemon-bridge.test.ts`
Expected: module not found.

- [ ] **Step 6.3: Implement `createDaemonBridge` (registry-only branch)**

API surface:

```ts
import type { BackgroundSessionRegistry } from "@koi/core/daemon";
import type { Dispatch } from "@koi/tui";

export type DaemonBridgeMode =
  | { readonly kind: "registry-only"; readonly registry: BackgroundSessionRegistry }
  | { readonly kind: "live"; readonly registry: BackgroundSessionRegistry; readonly supervisor: Supervisor };

export interface DaemonBridge {
  readonly close: () => Promise<void>;
  readonly requestKill: (req: KillRequest) => Promise<void>;
}

export interface CreateDaemonBridgeOptions {
  readonly mode: DaemonBridgeMode;
  readonly dispatch: Dispatch;
  readonly pushToast: (toast: ToastEntry) => void;
  readonly clock?: () => number;
  readonly intervals?: { readonly registryPollMs?: number; readonly healthPollMs?: number };
}

export function createDaemonBridge(opts: CreateDaemonBridgeOptions): DaemonBridge { /* ... */ }
```

For registry-only mode, only run:
- 1s poll loop calling `registry.describeList()` → `applyBgRows` + `applyBgRegistryStatus`.
- Background consumer loop on `registry.watch()` (if exposed) → re-poll on change to keep up to date.
- 3-strike failure model on poll, status transitions per spec.
- Closed sentinel pattern (race between iterator next + closed-promise) for cancellation; never `await iter.return()`.

Map `describeList` rows to `BgSessionRow` with `freshness: "foreign"` placeholder — Task 7 will recompute when supervisor available. (In registry-only mode `locallySpawnedIds` is empty so freshness is computed against an empty set on the next refresh.) Actually compute freshness here too using `computeFreshness` with `health: null, locallySpawnedIds: new Set()`.

- [ ] **Step 6.4: Run tests, expect PASS**

Run: `bun test packages/meta/cli/src/daemon-bridge.test.ts`
Expected: registry-only tests PASS.

- [ ] **Step 6.5: Commit**

```bash
git add packages/meta/cli/src/daemon-bridge.ts packages/meta/cli/src/daemon-bridge.test.ts
git commit -m "feat(daemon-bridge): registry-only mode + describeList polling (#1944)"
```

---

## Task 7: `daemon-bridge.ts` — live mode (supervisor wiring + locallySpawnedIds + kill flow)

**Files:**
- Modify: `packages/meta/cli/src/daemon-bridge.ts`
- Modify: `packages/meta/cli/src/daemon-bridge.test.ts`

Source-of-truth: spec `### Toast triggers`, `### Kill flow`, plus the `bridge.locallySpawnedIds` self-healing rules (lines ~607–956).

- [ ] **Step 7.1: Write failing tests for live mode**

Add tests under `describe("daemon-bridge (live mode)", () => { ... })`:

- `health()` poll dispatches `set_supervisor_health`.
- `WorkerEvent.crashed` from `watchAll()` pushes toast + supervisor event entry.
- Crash dedup within 30s (single toast); same workerId different incarnation (`startedAt`) emits two toasts.
- `WorkerHealth.state running→quarantined` (health diff) emits toast once per transition.
- `running→restarting` emits info toast.
- `health.status` ok→degraded emits toast.
- 3 consecutive `health()` failures → status `stale`.
- `watchAll()` failure → status `degraded` (`missing: ["workerEvents"]`); polls still update rows.
- Recovery `degraded→live` requires push channel to actually reattach.
- `requestKill` happy path: best-effort `registry.describe`, version+pid match → `supervisor.stop`. No pre-stop registry CAS.
- `requestKill` mismatched version/pid → toast, no `supervisor.stop`.
- `requestKill` registry unreadable → info toast, proceeds with `supervisor.stop`.
- `requestKill` `expectedPid === 0` AND `workerEvents` live → bypass CAS; `supervisor.stop` called.
- `requestKill` `expectedPid === 0` AND `workerEvents` stale → enforce CAS (require version match); mismatch aborts.
- `locallySpawnedIds`: insertion on `supervisor.start`, removal on terminal `WorkerEvent`.
- `locallySpawnedIds` cleared on `workerEvents → stale`.
- `requestKill` refuses for foreign rows (workerId not in `health.workers` AND not in `locallySpawnedIds`).
- `requestKill` refuses for terminal/terminating/detached registry status.
- Shutdown ordering: `supervisor.shutdown` resolves before `bridge.close`.
- `attachRegistry` integration: live `WorkerEvent.exited` from `supervisor.stop` flows through to registry transition (verified via `supervisor.test.ts:1227` end-to-end fixture).
- Toast incarnation key: `${workerId}:${startedAt}:${signalKind}`.

Each test uses an in-memory `Supervisor` fake that lets the test drive `watchAll()` events and override `health()` returns.

- [ ] **Step 7.2: Run tests, expect FAIL**

Run: `bun test packages/meta/cli/src/daemon-bridge.test.ts`
Expected: live-mode tests FAIL.

- [ ] **Step 7.3: Implement live-mode branch**

Extend `createDaemonBridge`:

- Three concurrent poll/consume loops: `health()` (1s), `describeList()` (1s, shared with registry-only), `watchAll()` consumer.
- Maintain `ChannelLiveness` per the four channels; compute composite `BridgeStatus` and dispatch on transitions.
- Maintain `RegistryStatus` separately (as in registry-only mode).
- Maintain a `locallySpawnedIds: Set<WorkerId>`. Insert before awaiting `supervisor.start()` (the bridge wraps a hook into the spawn call site — see step 7.4). Remove on terminal `WorkerEvent.exited`/`crashed`. Clear entire set on `workerEvents → stale` transition.
- Implement `requestKill` step-by-step exactly as spec `### Kill flow` steps 1–7 prescribe. Use `computeFreshness` only as a UX helper; ownership decision is driven by direct membership in `health.workers` ∪ `locallySpawnedIds`.
- Toast dedup map keyed by `${workerId}:${incarnation}:${signalKind}` with 30s TTL.
- Use closed-sentinel pattern for `watchAll()` cancellation.

Keep functions ≤ 50 lines. Extract helpers: `computeBridgeStatus`, `computeRegistryStatus`, `dedupToast`, `pollLoop`, `watchLoop`, `processWorkerEvent`, `runKillFlow`.

- [ ] **Step 7.4: Expose `markLocallySpawned(workerId)` for the bootstrap to call before `supervisor.start`**

The bridge can't intercept `supervisor.start` directly — `wire-daemon-supervisor.ts` (Task 8) will hand the bridge a callback. Add to the `DaemonBridge` interface:

```ts
readonly markLocallySpawned: (workerId: WorkerId) => void;
```

`wire-daemon-supervisor.ts` wraps the underlying supervisor with a thin proxy that calls `bridge.markLocallySpawned(req.workerId)` before invoking `realSupervisor.start(req)`. Document this in `wire-daemon-supervisor.ts`.

- [ ] **Step 7.5: Run tests, expect PASS**

Run: `bun test packages/meta/cli/src/daemon-bridge.test.ts`
Expected: all PASS.

- [ ] **Step 7.6: Commit**

```bash
git add packages/meta/cli/src/daemon-bridge.ts packages/meta/cli/src/daemon-bridge.test.ts
git commit -m "feat(daemon-bridge): live mode — supervisor polls/events, kill flow, locallySpawnedIds (#1944)"
```

---

## Task 8: `wire-daemon-supervisor.ts` — composer (TDD)

**Files:**
- Create: `packages/meta/cli/src/wire-daemon-supervisor.ts`
- Create: `packages/meta/cli/src/wire-daemon-supervisor.test.ts`

Composes `createSupervisor` + `createFileSessionRegistry` + `attachRegistry`. Returns a handle with `supervisor`, `registry`, and `dispose()`. Skipped by caller when no subprocess children.

- [ ] **Step 8.1: Write failing tests**

```ts
test("instantiates supervisor + registry + bridge for subprocess manifest", async () => { /* ... */ });
test("dispose tears down in reverse order: bridge → supervisor.shutdown → registry close", async () => { /* ... */ });
test("daemon-spawned children configured with restart: temporary, maxRestarts: 0", async () => { /* ... */ });
test("supervisor.start proxy calls bridge.markLocallySpawned before underlying start", async () => { /* ... */ });
```

- [ ] **Step 8.2: Run, expect FAIL**

- [ ] **Step 8.3: Implement**

```ts
export interface WireDaemonSupervisorOptions {
  readonly stateDir: string;
  readonly manifest: Manifest;
  readonly dispatch: Dispatch;
  readonly pushToast: ToastFn;
}

export interface WireDaemonSupervisorHandle {
  readonly supervisor: Supervisor;
  readonly registry: BackgroundSessionRegistry;
  readonly bridge: DaemonBridge;
  readonly dispose: () => Promise<void>;
}

export function wireDaemonSupervisor(
  opts: WireDaemonSupervisorOptions,
): WireDaemonSupervisorHandle { /* ... */ }
```

Steps inside:
1. `createFileSessionRegistry({ dir: stateDir })`.
2. `createSupervisor({ ... daemonSpawnChildFn requires `restart: "temporary", maxRestarts: 0` ... })`.
3. `attachRegistry({ supervisor, registry })` — get its dispose.
4. Wrap supervisor in a proxy whose `start(req)` calls `bridge.markLocallySpawned(req.workerId)` before delegating.
5. `createDaemonBridge({ mode: { kind: "live", registry, supervisor: proxiedSupervisor }, dispatch, pushToast })`.
6. `dispose` runs in order: `bridge.close()` → `supervisor.shutdown()` → `attachRegistry.dispose()` → `registry.close?.()`. (Spec mandates supervisor.shutdown BEFORE bridge.close in production wiring — re-read spec: "supervisor.shutdown() resolves before bridge.close()". Update order accordingly.) **Correction:** the order is `supervisor.shutdown()` THEN `bridge.close()` so terminal events drain through `watchAll()` to the bridge and into the store before the bridge closes. Implement that order.

- [ ] **Step 8.4: Run tests, expect PASS**

- [ ] **Step 8.5: Commit**

```bash
git add packages/meta/cli/src/wire-daemon-supervisor.ts packages/meta/cli/src/wire-daemon-supervisor.test.ts
git commit -m "feat(cli): wire-daemon-supervisor composer (#1944)"
```

---

## Task 9: `tui-command.ts` wiring

**Files:**
- Modify: `packages/meta/cli/src/tui-command.ts`

Source-of-truth: spec `## File Layout` `tui-command.ts` block (lines ~218–246). Two wiring points: registry-only bridge ALWAYS open if state dir exists; live bridge only when manifest declares subprocess supervision.

- [ ] **Step 9.1: Locate the existing supervision wire points**

Find the two existing call sites (`wireManifestSupervision` near line 1172 and 2051+) and the shutdown sequence.

- [ ] **Step 9.2: Add registry-only construction (always)**

Right after the state dir is resolved:

```ts
const registryDir = path.join(stateDir, "bg-sessions"); // or actual location
const registryExists = await fs.exists(registryDir);
let registryOnlyBridge: DaemonBridge | null = null;
if (registryExists) {
  const roRegistry = createFileSessionRegistry({ dir: registryDir, readOnly: true });
  registryOnlyBridge = createDaemonBridge({
    mode: { kind: "registry-only", registry: roRegistry },
    dispatch,
    pushToast,
  });
}
```

- [ ] **Step 9.3: Add live wiring only when manifest has subprocess children**

```ts
const hasSubprocessChild = manifest.supervision?.some((c) => c.isolation === "subprocess") ?? false;
let supervisionHandle: WireDaemonSupervisorHandle | null = null;
if (hasSubprocessChild) {
  // Tear down the registry-only bridge first; live mode owns its own registry handle.
  await registryOnlyBridge?.close();
  registryOnlyBridge = null;
  supervisionHandle = wireDaemonSupervisor({ stateDir: registryDir, manifest, dispatch, pushToast });
  dispatch({ kind: "set_supervisor_attached", attached: true });
}
```

- [ ] **Step 9.4: Update shutdown sequence**

Order:
1. existing `supervisionHandle?.dispose()` (which itself runs supervisor.shutdown → bridge.close in correct order)
2. `registryOnlyBridge?.close()` (no-op if it was torn down on live wiring)
3. existing `runtime.dispose()`

Place between `supervisionHandle.dispose()` and `runtime.dispose()` so the renderer is still alive while terminal events drain.

- [ ] **Step 9.5: Verify typecheck + commit**

```bash
bun run typecheck --filter=@koi/meta-cli
git add packages/meta/cli/src/tui-command.ts
git commit -m "feat(cli): wire daemon supervisor + registry-only bridge into tui-command (#1944)"
```

---

## Task 10: StatusBar badge (TDD)

**Files:**
- Modify: `packages/ui/tui/src/components/StatusBar.tsx`
- Modify: `packages/ui/tui/src/components/StatusBar.test.tsx`

Source-of-truth: spec `## Hidden status-line` (lines ~1042–1048) and `### Bridge failure handling` for badge symbology.

- [ ] **Step 10.1: Write failing tests**

```ts
test("badge hidden when supervisor.attached === false", () => { /* status: detached */ });
test("badge ◎ green + 'N/M workers' when status live + health.status ok", () => { /* ... */ });
test("badge ◑ yellow when status live + health.status degraded", () => { /* ... */ });
test("badge ● red when status live + health.status unhealthy", () => { /* ... */ });
test("badge ◌ + 'stale Ns' when status.kind === 'stale'", () => { /* ... */ });
test("badge ◐ + 'degraded' when status.kind === 'degraded'", () => { /* ... */ });
test("renders after governance segment with · separator", () => { /* ... */ });
```

- [ ] **Step 10.2: Run, expect FAIL**

- [ ] **Step 10.3: Add Supervisor segment**

Render after the existing governance segment:

```tsx
{state.supervisor.attached && (
  <Text>
    {governanceSegment ? " · " : ""}
    {renderSupervisorBadge(state.supervisor)}
  </Text>
)}
```

`renderSupervisorBadge` is a small pure helper in the same file that maps `(status, health)` → `{ symbol, color, label }`.

- [ ] **Step 10.4: Tests PASS + commit**

```bash
bun test packages/ui/tui/src/components/StatusBar.test.tsx
git add packages/ui/tui/src/components/StatusBar.tsx packages/ui/tui/src/components/StatusBar.test.tsx
git commit -m "feat(tui): supervisor badge in status bar (#1944)"
```

---

## Task 11: SupervisorView component (TDD)

**Files:**
- Create: `packages/ui/tui/src/components/SupervisorView.tsx`
- Create: `packages/ui/tui/src/components/SupervisorView.test.tsx`

- [ ] **Step 11.1: Write failing tests**

Render-only component reading `state.supervisor`. Tests:

```ts
test("worker table columns: workerId, agentId, state, lastHeartbeatAt, heartbeatDeadlineAt", () => {});
test("metrics row shows poolSize/maxWorkers, quarantinedCount, restartingCount, pendingSpawnCount, eventDropCount, shuttingDown", () => {});
test("reasons section hidden when health.reasons empty", () => {});
test("reasons section visible with bullet list when health.reasons non-empty", () => {});
test("event feed renders last-50 entries newest-first", () => {});
test("renders empty-state when supervisor.attached === false", () => {});
test("renders 'observability stale' banner when status.kind === 'stale'", () => {});
test("renders 'push channel down' banner when status.kind === 'degraded'", () => {});
```

- [ ] **Step 11.2 → 11.4: Implement, run, commit**

Pure presentation component using Ink primitives. Keep ≤ 250 LOC, ≤ 50 LOC per render helper.

```bash
git add packages/ui/tui/src/components/SupervisorView.tsx packages/ui/tui/src/components/SupervisorView.test.tsx
git commit -m "feat(tui): /supervisor view (#1944)"
```

---

## Task 12: BgView component (TDD)

**Files:**
- Create: `packages/ui/tui/src/components/BgView.tsx`
- Create: `packages/ui/tui/src/components/BgView.test.tsx`

Source-of-truth: spec `### Kill flow` action availability table (lines ~790–818) + `### Freshness computation` render mapping (lines ~739–754).

- [ ] **Step 12.1: Write failing tests**

```ts
test("table columns: workerId, agentId, status, freshness, pid, startedAt, logPath", () => {});
test("freshness color mapping per spec render table", () => {});
test("registry-stale banner renders when bg.registryStatus.kind === 'stale'", () => {});
test("registry-degraded banner renders when bg.registryStatus.kind === 'degraded'", () => {});
test("k key opens kill confirm modal for locally-owned running row", () => {});
test("k key opens kill confirm for locally-spawned starting row", () => {});
test("k key disabled for foreign row + shows 'use koi bg kill' hint", () => {});
test("k key disabled for terminating / detached / terminal", () => {});
test("k key disabled for ALL rows in registry-only mode (every row foreign)", () => {});
test("Enter key dispatches set_bg_tailing with row.workerId", () => {});
test("Enter on logPath === '' shows 'logging disabled' (no tail mount)", () => {});
test("kill confirm 'y' fires onCommand('system:bg-kill', { workerId, expectedVersion, expectedPid })", () => {});
test("kill confirm 'n' / Esc clears killConfirm", () => {});
```

- [ ] **Step 12.2 → 12.4: Implement, run, commit**

Component reads `state.bg`, `state.supervisor` (for ownership classification), and `bridge.locallySpawnedIds` exposed via `state.bg.rows[i].freshness` (already computed by the bridge — view doesn't need to reimplement). Use `useInput` from Ink for key bindings.

For ownership/foreign hint: row's `freshness === "foreign"` is the canonical signal — no need to read `locallySpawnedIds` directly in the view.

```bash
git add packages/ui/tui/src/components/BgView.tsx packages/ui/tui/src/components/BgView.test.tsx
git commit -m "feat(tui): /bg view + kill confirm modal (#1944)"
```

---

## Task 13: BgLogTail component (TDD)

**Files:**
- Create: `packages/ui/tui/src/components/BgLogTail.tsx`
- Create: `packages/ui/tui/src/components/BgLogTail.test.tsx`

Source-of-truth: spec `### Log tail` (lines ~956–1041).

- [ ] **Step 13.1: Write failing tests**

```ts
test("never mounts when row.logPath === ''", () => {});
test("initial reverse-tail produces last 1000 lines", async () => {});
test("appended write extends buffer", async () => {});
test("truncation: file size shrinks → reset offset + render '--- log truncated ---'", async () => {});
test("inode change (rotation): close fd, render '--- log rotated ---', read new from start, rebind fs.watch", async () => {});
test("logPath change mid-tail: close fd, render '--- log path changed ---', open new", async () => {});
test("ENOENT at startup: enter waiting state; resume on first successful stat with '--- log opened ---'", async () => {});
test("watchdog 1s stat sweep detects writes when fs.watch silently drops", async () => {});
test("unmount: closes fd, clears watcher, clears watchdog, clears ENOENT poll", async () => {});
```

Use Bun's tmpdir + `Bun.write` to drive real fs activity. Wrap in `beforeEach`/`afterEach` to clean up.

- [ ] **Step 13.2 → 13.4: Implement, run, commit**

```bash
git add packages/ui/tui/src/components/BgLogTail.tsx packages/ui/tui/src/components/BgLogTail.test.tsx
git commit -m "feat(tui): bg log tail with rotation + watchdog (#1944)"
```

---

## Task 14: tui-root view dispatch + command handler

**Files:**
- Modify: `packages/ui/tui/src/tui-root.tsx`
- Modify: `packages/ui/tui/src/commands/command-definitions.ts`

- [ ] **Step 14.1: Register slash commands**

In `command-definitions.ts` add:

```ts
{ name: "supervisor", description: "Show supervisor status", view: "supervisor" },
{ name: "bg", description: "Show background sessions", view: "bg" },
```

And the system command:

```ts
{ name: "system:bg-kill", system: true /* ... */ }
```

- [ ] **Step 14.2: View dispatch in `tui-root`**

Render `<SupervisorView />` when current view is `"supervisor"`, `<BgView />` when `"bg"`. Mount `<BgLogTail row={row} />` when `state.bg.tailingWorkerId` is set AND `row.logPath !== ""`.

- [ ] **Step 14.3: Wire `system:bg-kill` to bridge**

`tui-root` receives a `bridge` prop (or via context). Handler:

```ts
case "system:bg-kill":
  await bridge.requestKill({
    workerId: payload.workerId,
    expectedVersion: payload.expectedVersion,
    expectedPid: payload.expectedPid,
  });
```

- [ ] **Step 14.4: Typecheck + commit**

```bash
git add packages/ui/tui/src
git commit -m "feat(tui): wire /supervisor /bg views + bg-kill command (#1944)"
```

---

## Task 15: Spawn tool output enrichment

**Files:**
- Modify: `packages/ui/tui/src/tool-display.ts`

Show `workerId`, isolation mode, backend kind on Spawn tool result rendering.

- [ ] **Step 15.1: Locate Spawn renderer**

`grep -n "Spawn" packages/ui/tui/src/tool-display.ts`

- [ ] **Step 15.2: Add fields to result rendering**

```ts
if (result?.workerId) lines.push(`worker: ${result.workerId}`);
if (result?.isolation) lines.push(`isolation: ${result.isolation}`);
if (result?.backendKind) lines.push(`backend: ${result.backendKind}`);
```

(Verify the Spawn tool result shape has these fields. If missing, threading them through is in scope per spec risk row "Spawn tool output needs `workerId`".)

- [ ] **Step 15.3: Update tests + commit**

```bash
git add packages/ui/tui/src/tool-display.ts
git commit -m "feat(tui): enrich Spawn tool output with workerId/isolation/backend (#1944)"
```

---

## Task 16: Inline supervisor events in session log

**Files:**
- Modify: `packages/ui/tui/src/tui-root.tsx` (or wherever the session log renderer lives)

The bridge already pushes `SupervisorEventEntry` to `state.supervisor.events`. Render new entries inline in the session log when they arrive, with the agent name and (for `crashed`) the error message.

- [ ] **Step 16.1: Subscribe to event additions**

Use a `useEffect` keyed on `state.supervisor.events.length` to append new entries to the log buffer. Mark derived `restarting`/`quarantined` entries with a "(derived)" suffix per spec.

- [ ] **Step 16.2: Tests + commit**

```bash
git add packages/ui/tui/src
git commit -m "feat(tui): inline supervisor events in session log (#1944)"
```

---

## Task 17: E2E (gated on `$RUN_E2E`)

**Files:**
- Create: `packages/ui/tui/src/__tests__/daemon-tui-e2e.test.ts`

Source-of-truth: spec `### E2E (tmux harness, gated on $RUN_E2E)` (lines ~1237–1252).

- [ ] **Step 17.1: Write E2E suite**

Skip with `test.skipIf(!process.env.RUN_E2E)`. Use the tmux session-naming pattern from CLAUDE.md (`${WORKTREE}-koi-e2e`). Cases:

- Manifest with subprocess supervision → `◎` badge appears within 1s.
- `os.kill` worker → `⚠` toast + status flips to `◑`.
- Stall worker past heartbeat deadline → timeout toast + `/bg` row red.
- `/supervisor` renders worker table + metrics.
- `/bg` `k` confirm terminates worker; row flips to `exited`.
- Manifest without `supervision:` → no badge.

- [ ] **Step 17.2: Commit**

```bash
git add packages/ui/tui/src/__tests__/daemon-tui-e2e.test.ts
git commit -m "test(tui): daemon TUI E2E suite (gated) (#1944)"
```

---

## Task 18: CI gate sweep

- [ ] **Step 18.1: Run the full CI gate**

```bash
bun run typecheck
bun run lint
bun run check:layers
bun run check:unused
bun run check:duplicates
bun run test
```

Fix any failures inline; do NOT weaken tests.

- [ ] **Step 18.2: Per-package focused tests**

```bash
bun run test --filter=@koi/tui
bun run test --filter=@koi/meta-cli
```

- [ ] **Step 18.3: Verify acceptance checklist**

Open the spec's `## Acceptance` section and tick every item against the implementation. Any unchecked items = scope gap; create a follow-up task or close the gap before opening the PR.

- [ ] **Step 18.4: Final commit (if cleanup needed)**

```bash
git commit -am "chore(tui-daemon): CI gate cleanup (#1944)"
```

---

## Task 19: Open PR

- [ ] **Step 19.1: Push branch**

```bash
git push -u origin feat/tui-daemon-surface-1944
```

- [ ] **Step 19.2: Open PR**

Title: `feat(tui-daemon): wire @koi/net/daemon supervisor into TUI (closes #1944)`

Body should reference:
- Closes #1944 (and prerequisite #1866 closure note)
- Spec: `docs/superpowers/specs/2026-05-04-tui-daemon-surface-1944-design.md`
- Plan: `docs/superpowers/plans/2026-05-04-tui-daemon-surface-1944.md`
- Total LOC + per-package breakdown
- Test strategy summary (unit + E2E gate)
- Acceptance checklist (copy from spec, all ticked)

---

## Self-Review Notes

**Spec coverage:** Every spec section maps to tasks 1–17:
- Half A runtime wiring → Tasks 8, 9
- Half B feature 1 (status-line badge) → Task 10
- Half B feature 2 (toasts) → Task 7 (bridge dispatches them)
- Half B feature 3 (/supervisor) → Tasks 11, 14
- Half B feature 4 (/bg) → Tasks 12, 13, 14
- Half B feature 5 (Spawn enrichment) → Task 15
- Half B feature 6 (inline events) → Task 16
- State slices → Tasks 1–5
- Freshness compute → Task 4
- Kill flow + locallySpawnedIds + CAS bypass gating → Task 7
- Log tail rotation/watchdog → Task 13
- E2E → Task 17

**Type consistency check:** `BgSessionRow.workerId: string` (Task 1) used as the row identity throughout (Tasks 12, 14, 7's kill flow). `WorkerId` brand from `@koi/core/daemon` is the bridge-side type; rows store the unbranded `string` because they come from registry deserialization. The bridge re-brands on its way into `supervisor.stop`. This is consistent with how `attachRegistry` already operates.

**No-placeholder check:** Every task lists the exact file paths, the test cases enumerated, and the implementation pointers (with spec line ranges where the source-of-truth is too long to inline). Code blocks contain real code, not "TBD".

**Granularity check:** Each task is a single coherent piece (one file or tightly coupled pair) with TDD substeps and a commit. Tasks 6 and 7 are the largest; they intentionally split registry-only from live mode so the foundation lands first.
