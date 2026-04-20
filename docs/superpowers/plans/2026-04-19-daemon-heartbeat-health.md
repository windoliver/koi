# Daemon Heartbeat + Health Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `@koi/daemon` with a worker heartbeat IPC protocol, missed-heartbeat timeout detection, and an in-memory `supervisor.health()` snapshot that reports both per-worker health and supervisor self-health.

**Architecture:** New L2 module `health-monitor.ts` owns per-worker deadline timers; hooks into the existing supervisor at four points (admission, watch-loop heartbeat event, terminal event, shutdown). Bun subprocess backend gains opt-in IPC wiring via `backendHints.heartbeat === true`. L0 gains five types + two constants; no new `WorkerEvent` kind — missed heartbeat emits synthetic `crashed` with `error.code = "HEARTBEAT_TIMEOUT"` and reuses the existing teardown pipeline.

**Tech Stack:** Bun 1.3.x, TypeScript 6, `bun:test`, tsup. Spec: `docs/superpowers/specs/2026-04-19-daemon-heartbeat-health-design.md`. Issue: <https://github.com/windoliver/koi/issues/1341>.

---

## File-by-file map

| File | Change | Purpose |
|---|---|---|
| `packages/kernel/core/src/daemon.ts` | +40 LOC | `HeartbeatConfig`, `DEFAULT_HEARTBEAT_CONFIG`, `SUPERVISOR_HEALTH_STATUS`, `SupervisorHealthStatus`, `WorkerHealth`, `SupervisorHealthMetrics`, `SupervisorHealth`; extend `SupervisorConfig` + `Supervisor` |
| `packages/kernel/core/src/index.ts` | +10 LOC | Export new types + constants from daemon |
| `packages/kernel/core/src/__tests__/daemon.test.ts` | +20 LOC | Test `DEFAULT_HEARTBEAT_CONFIG` and `SUPERVISOR_HEALTH_STATUS` shape |
| `packages/net/daemon/src/health-monitor.ts` | NEW ~180 LOC | `createHealthMonitor` — timer-driven deadline, `track`/`observe`/`untrack`/`shutdown`/`snapshot`, synthetic-crash-on-timeout |
| `packages/net/daemon/src/__tests__/health-monitor.test.ts` | NEW ~180 LOC | 10 unit tests with injected fake `now`/`publishEvent`/`teardown` |
| `packages/net/daemon/src/create-supervisor.ts` | +50 LOC | Plumb `agentId` into `RestartingEntry`+`QuarantinedEntry`; instantiate monitor; 4 wiring touch-points; new `health()` method |
| `packages/net/daemon/src/__tests__/supervisor.test.ts` | +100 LOC | Tests for `health()` on fresh/at-capacity/shutting-down supervisor, non-heartbeat-tracked worker, heartbeat-opt-in worker |
| `packages/net/daemon/src/subprocess-backend.ts` | +30 LOC | Opt-in IPC wiring; `isHeartbeatMessage` guard; emit `heartbeat` events |
| `packages/net/daemon/src/__tests__/heartbeat-subprocess.test.ts` | NEW ~80 LOC | 3 integration tests with real `Bun.spawn` using inline `bun -e` children |
| `packages/net/daemon/src/index.ts` | +2 LOC | Export `createHealthMonitor` + `HealthMonitor` type |
| `docs/L2/daemon.md` | +90 LOC | Heartbeat section + `health()` shape + child-side IPC pattern |
| `packages/meta/runtime/src/__tests__/golden-replay.test.ts` | +50 LOC | Two new `test()` cases inside the existing `describe("Golden: @koi/daemon", …)` block |

`scripts/layers.ts` — no change (file `daemon.ts` is already in `L0_RUNTIME_ALLOWLIST` at `scripts/check-layers.ts:101`).

Production LOC total: ~312. Tests/docs do not count against the 300-LOC budget.

---

## Task 1: L0 contract additions

**Files:**
- Modify: `packages/kernel/core/src/daemon.ts` (append new types + extend `SupervisorConfig`, `Supervisor`)
- Modify: `packages/kernel/core/src/index.ts` (append new exports)
- Test: `packages/kernel/core/src/__tests__/daemon.test.ts` (append shape tests)

- [ ] **Step 1: Write failing tests for the new constants and type shape**

Append to `packages/kernel/core/src/__tests__/daemon.test.ts`:

```typescript
import {
  DEFAULT_HEARTBEAT_CONFIG,
  SUPERVISOR_HEALTH_STATUS,
  type SupervisorHealth,
} from "../daemon.js";

describe("DEFAULT_HEARTBEAT_CONFIG", () => {
  it("has positive interval and timeout, with timeout > interval", () => {
    expect(DEFAULT_HEARTBEAT_CONFIG.intervalMs).toBeGreaterThan(0);
    expect(DEFAULT_HEARTBEAT_CONFIG.timeoutMs).toBeGreaterThan(DEFAULT_HEARTBEAT_CONFIG.intervalMs);
  });
});

describe("SUPERVISOR_HEALTH_STATUS", () => {
  it("enumerates ok/degraded/unhealthy", () => {
    expect(SUPERVISOR_HEALTH_STATUS).toEqual({
      OK: "ok",
      DEGRADED: "degraded",
      UNHEALTHY: "unhealthy",
    });
  });
});

describe("SupervisorHealth type shape", () => {
  it("composes from status, reasons, metrics, workers (compile-time check)", () => {
    const sample: SupervisorHealth = {
      status: "ok",
      reasons: [],
      metrics: {
        poolSize: 0,
        maxWorkers: 4,
        quarantinedCount: 0,
        restartingCount: 0,
        pendingSpawnCount: 0,
        eventDropCount: 0,
        shuttingDown: false,
      },
      workers: [],
    };
    expect(sample.status).toBe("ok");
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

Run: `cd packages/kernel/core && bun test src/__tests__/daemon.test.ts`
Expected: FAIL — `DEFAULT_HEARTBEAT_CONFIG`, `SUPERVISOR_HEALTH_STATUS`, `SupervisorHealth` not exported from `../daemon.js`.

- [ ] **Step 3: Extend `daemon.ts` — add types + constants + extend `SupervisorConfig` and `Supervisor`**

Append after the existing `DEFAULT_WORKER_RESTART_POLICY` constant (around line 137) — before the `export interface Supervisor` block:

```typescript
// ---------------------------------------------------------------------------
// Heartbeat / health
// ---------------------------------------------------------------------------

/**
 * Worker heartbeat configuration. `intervalMs` is advisory cadence for the
 * sender; the supervisor does not enforce it. `timeoutMs` is the deadline:
 * if no heartbeat event arrives within this window, the supervisor declares
 * the worker hung and tears it down.
 */
export interface HeartbeatConfig {
  readonly intervalMs: number;
  readonly timeoutMs: number;
}

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  intervalMs: 5_000,
  timeoutMs: 15_000,
};

export const SUPERVISOR_HEALTH_STATUS = {
  OK: "ok",
  DEGRADED: "degraded",
  UNHEALTHY: "unhealthy",
} as const satisfies Record<string, string>;
export type SupervisorHealthStatus =
  (typeof SUPERVISOR_HEALTH_STATUS)[keyof typeof SUPERVISOR_HEALTH_STATUS];

/**
 * Per-worker health snapshot. `lastHeartbeatAt` / `heartbeatDeadlineAt` are
 * `undefined` for workers that did not opt into heartbeat monitoring via
 * `WorkerSpawnRequest.backendHints.heartbeat = true`.
 */
export interface WorkerHealth {
  readonly workerId: WorkerId;
  readonly agentId: AgentId;
  readonly state: "running" | "restarting" | "quarantined" | "stopping";
  readonly lastHeartbeatAt: number | undefined;
  readonly heartbeatDeadlineAt: number | undefined;
}

export interface SupervisorHealthMetrics {
  readonly poolSize: number;
  readonly maxWorkers: number;
  readonly quarantinedCount: number;
  readonly restartingCount: number;
  readonly pendingSpawnCount: number;
  readonly eventDropCount: number;
  readonly shuttingDown: boolean;
}

/**
 * Aggregate supervisor health: a three-state verdict + machine-readable
 * reasons + raw counters + per-worker detail. Consumers (TUI, CLI, future
 * HTTP wrapper) render whichever slice they need.
 */
export interface SupervisorHealth {
  readonly status: SupervisorHealthStatus;
  readonly reasons: readonly string[];
  readonly metrics: SupervisorHealthMetrics;
  readonly workers: readonly WorkerHealth[];
}
```

Now extend `SupervisorConfig` — find the existing interface at line 105 and add a new `heartbeat?` field before the closing `}`:

```typescript
export interface SupervisorConfig {
  readonly maxWorkers: number;
  readonly shutdownDeadlineMs: number;
  readonly backends: Readonly<Partial<Record<WorkerBackendKind, WorkerBackend>>>;
  readonly restart?: WorkerRestartPolicy | undefined;
  readonly spawnTimeoutMs?: number | undefined;
  /**
   * Default heartbeat cadence/timeout applied to workers that opt into
   * heartbeat monitoring via `WorkerSpawnRequest.backendHints.heartbeat = true`.
   * Omitted → `DEFAULT_HEARTBEAT_CONFIG` is used.
   */
  readonly heartbeat?: HeartbeatConfig | undefined;
}
```

And extend `Supervisor` — find the existing interface at line 139 and add `health` before the closing `}`:

```typescript
export interface Supervisor {
  readonly start: (
    request: WorkerSpawnRequest,
    overrides?: {
      readonly restart?: WorkerRestartPolicy;
      readonly backend?: WorkerBackendKind;
    },
  ) => Promise<Result<WorkerHandle, KoiError>>;
  readonly stop: (id: WorkerId, reason: string) => Promise<Result<void, KoiError>>;
  readonly shutdown: (reason: string) => Promise<Result<void, KoiError>>;
  readonly list: () => readonly ProcessDescriptor[];
  readonly watchAll: () => AsyncIterable<WorkerEvent>;
  /** In-memory health snapshot — pure read, no mutation, no `await`. */
  readonly health: () => SupervisorHealth;
}
```

- [ ] **Step 4: Add exports in `packages/kernel/core/src/index.ts`**

Find the existing daemon type-export block (starts at line 275) and add these type names in alphabetical order:

```typescript
export type {
  BackgroundSessionEvent,
  BackgroundSessionRecord,
  BackgroundSessionRegistry,
  BackgroundSessionStatus,
  BackgroundSessionUpdate,
  HeartbeatConfig,
  Supervisor,
  SupervisorConfig,
  SupervisorHealth,
  SupervisorHealthMetrics,
  SupervisorHealthStatus,
  WorkerBackend,
  WorkerBackendKind,
  WorkerEvent,
  WorkerHandle,
  WorkerHealth,
  WorkerId,
  WorkerRestartPolicy,
  WorkerSpawnRequest,
} from "./daemon.js";
```

Find the existing daemon value-export block (starts at line 291) and extend:

```typescript
export {
  DEFAULT_HEARTBEAT_CONFIG,
  DEFAULT_WORKER_RESTART_POLICY,
  SUPERVISOR_HEALTH_STATUS,
  validateBackgroundSessionRecord,
  validateSupervisorConfig,
  workerId,
} from "./daemon.js";
```

- [ ] **Step 5: Run tests, expect pass**

Run: `cd packages/kernel/core && bun test src/__tests__/daemon.test.ts`
Expected: PASS (all existing tests plus 3 new assertions).

- [ ] **Step 6: Run layer check**

Run: `cd /Users/tafeng/koi/.claude/worktrees/swift-giggling-rabbit && bun scripts/check-layers.ts`
Expected: PASS (no new function bodies in L0 — only type definitions + one `as const` constant).

- [ ] **Step 7: Commit**

```bash
git add packages/kernel/core/src/daemon.ts packages/kernel/core/src/index.ts packages/kernel/core/src/__tests__/daemon.test.ts
git commit -m "feat(core): add heartbeat + supervisor health L0 contracts"
```

---

## Task 2: `health-monitor.ts` — unit tests first

**Files:**
- Test: `packages/net/daemon/src/__tests__/health-monitor.test.ts` (NEW)
- Create: `packages/net/daemon/src/health-monitor.ts` (NEW)

- [ ] **Step 1: Write failing unit tests**

Create `packages/net/daemon/src/__tests__/health-monitor.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentId, WorkerEvent, WorkerId } from "@koi/core";
import { agentId, workerId } from "@koi/core";
import { createHealthMonitor, type HealthMonitor } from "../health-monitor.js";

const wid = (s: string): WorkerId => workerId(s);
const aid = (s: string): AgentId => agentId(s);
const CONFIG = { intervalMs: 50, timeoutMs: 120 };

interface Harness {
  readonly monitor: HealthMonitor;
  readonly events: WorkerEvent[];
  readonly teardownCalls: Array<{ readonly id: WorkerId; readonly reason: string }>;
  tick: (ms: number) => Promise<void>;
}

const makeHarness = (opts?: {
  readonly teardownImpl?: (id: WorkerId, reason: string) => Promise<void>;
}): Harness => {
  const events: WorkerEvent[] = [];
  const teardownCalls: Array<{ readonly id: WorkerId; readonly reason: string }> = [];
  let nowMs = 1_000_000;
  const monitor = createHealthMonitor({
    publishEvent: (ev) => events.push(ev),
    teardown: async (id, reason) => {
      teardownCalls.push({ id, reason });
      if (opts?.teardownImpl !== undefined) await opts.teardownImpl(id, reason);
    },
    now: () => nowMs,
  });
  return {
    monitor,
    events,
    teardownCalls,
    tick: async (ms: number) => {
      nowMs += ms;
      await new Promise((r) => setTimeout(r, ms));
    },
  };
};

describe("createHealthMonitor", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.monitor.shutdown();
  });

  it("track arms a deadline timer — timeout fires after timeoutMs with no observe", async () => {
    h.monitor.track(wid("w1"), aid("a1"), CONFIG);
    await h.tick(CONFIG.timeoutMs + 30);
    expect(h.teardownCalls.map((c) => c.id)).toContain(wid("w1"));
    const crash = h.events.find(
      (e) => e.kind === "crashed" && e.workerId === wid("w1"),
    ) as { kind: "crashed"; error: { code: string } } | undefined;
    expect(crash).toBeDefined();
    expect(crash?.error.code).toBe("HEARTBEAT_TIMEOUT");
  });

  it("observe resets deadline — no timeout if called within window", async () => {
    h.monitor.track(wid("w1"), aid("a1"), CONFIG);
    await h.tick(CONFIG.timeoutMs - 20);
    h.monitor.observe(wid("w1"));
    await h.tick(CONFIG.timeoutMs - 20);
    h.monitor.observe(wid("w1"));
    await h.tick(CONFIG.timeoutMs - 20);
    expect(h.teardownCalls).toEqual([]);
    expect(h.events.filter((e) => e.kind === "crashed")).toEqual([]);
  });

  it("untrack clears timer — no fire after untrack", async () => {
    h.monitor.track(wid("w1"), aid("a1"), CONFIG);
    h.monitor.untrack(wid("w1"));
    await h.tick(CONFIG.timeoutMs + 30);
    expect(h.teardownCalls).toEqual([]);
    expect(h.events.filter((e) => e.kind === "crashed")).toEqual([]);
  });

  it("shutdown clears every tracked timer", async () => {
    h.monitor.track(wid("w1"), aid("a1"), CONFIG);
    h.monitor.track(wid("w2"), aid("a2"), CONFIG);
    h.monitor.shutdown();
    await h.tick(CONFIG.timeoutMs + 30);
    expect(h.teardownCalls).toEqual([]);
  });

  it("timeout teardown reason is 'heartbeat-timeout'", async () => {
    h.monitor.track(wid("w1"), aid("a1"), CONFIG);
    await h.tick(CONFIG.timeoutMs + 30);
    expect(h.teardownCalls[0]?.reason).toBe("heartbeat-timeout");
  });

  it("snapshot returns current state for each tracked worker", async () => {
    h.monitor.track(wid("w1"), aid("a1"), CONFIG);
    h.monitor.track(wid("w2"), aid("a2"), CONFIG);
    h.monitor.observe(wid("w1"));
    const snap = h.monitor.snapshot();
    expect(snap).toHaveLength(2);
    const w1 = snap.find((s) => s.workerId === wid("w1"));
    expect(w1?.agentId).toBe(aid("a1"));
    expect(w1?.state).toBe("running");
    expect(typeof w1?.lastHeartbeatAt).toBe("number");
    expect(typeof w1?.heartbeatDeadlineAt).toBe("number");
  });

  it("double track on same id replaces state (old timer cleared)", async () => {
    h.monitor.track(wid("w1"), aid("a1"), { intervalMs: 10, timeoutMs: 40 });
    h.monitor.track(wid("w1"), aid("a1"), CONFIG);
    await h.tick(60);
    expect(h.teardownCalls).toEqual([]);
  });

  it("observe on untracked id is a no-op", () => {
    expect(() => h.monitor.observe(wid("never-tracked"))).not.toThrow();
  });

  it("untrack on untracked id is a no-op", () => {
    expect(() => h.monitor.untrack(wid("never-tracked"))).not.toThrow();
  });

  it("teardown rejection is swallowed — does not throw into event loop", async () => {
    const bad = makeHarness({
      teardownImpl: () => Promise.reject(new Error("teardown boom")),
    });
    bad.monitor.track(wid("w1"), aid("a1"), CONFIG);
    const captured = mock(() => undefined);
    const orig = process.listeners("unhandledRejection");
    const handler = (): void => captured();
    process.on("unhandledRejection", handler);
    try {
      await bad.tick(CONFIG.timeoutMs + 30);
      await new Promise((r) => setTimeout(r, 20));
      expect(captured).toHaveBeenCalledTimes(0);
    } finally {
      process.off("unhandledRejection", handler);
      for (const l of orig) process.on("unhandledRejection", l);
      bad.monitor.shutdown();
    }
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

Run: `cd packages/net/daemon && bun test src/__tests__/health-monitor.test.ts`
Expected: FAIL — module `../health-monitor.js` not found.

- [ ] **Step 3: Create `packages/net/daemon/src/health-monitor.ts`**

```typescript
import type {
  AgentId,
  HeartbeatConfig,
  WorkerEvent,
  WorkerHealth,
  WorkerId,
} from "@koi/core";

export interface HealthMonitorDeps {
  readonly publishEvent: (ev: WorkerEvent) => void;
  readonly teardown: (id: WorkerId, reason: string) => Promise<void>;
  readonly now: () => number;
}

export interface HealthMonitor {
  readonly track: (id: WorkerId, agentId: AgentId, config: HeartbeatConfig) => void;
  readonly observe: (id: WorkerId) => void;
  readonly untrack: (id: WorkerId) => void;
  readonly shutdown: () => void;
  readonly snapshot: () => readonly WorkerHealth[];
}

interface MonitorEntry {
  readonly agentId: AgentId;
  readonly config: HeartbeatConfig;
  lastHeartbeatAt: number;
  deadlineAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export function createHealthMonitor(deps: HealthMonitorDeps): HealthMonitor {
  const entries = new Map<WorkerId, MonitorEntry>();
  let isShutdown = false;

  const armTimer = (id: WorkerId, entry: MonitorEntry): void => {
    entry.timer = setTimeout(() => onDeadline(id), entry.config.timeoutMs);
  };

  const onDeadline = (id: WorkerId): void => {
    if (isShutdown) return;
    const entry = entries.get(id);
    if (entry === undefined) return;
    deps.publishEvent({
      kind: "crashed",
      workerId: id,
      at: deps.now(),
      error: {
        code: "HEARTBEAT_TIMEOUT",
        message: `No heartbeat from worker ${id} within ${entry.config.timeoutMs}ms`,
        retryable: true,
      },
    });
    deps.teardown(id, "heartbeat-timeout").catch(() => undefined);
  };

  const track: HealthMonitor["track"] = (id, agentId, config) => {
    if (isShutdown) return;
    const existing = entries.get(id);
    if (existing !== undefined) clearTimeout(existing.timer);
    const now = deps.now();
    const entry: MonitorEntry = {
      agentId,
      config,
      lastHeartbeatAt: now,
      deadlineAt: now + config.timeoutMs,
      timer: setTimeout(() => undefined, 0),
    };
    clearTimeout(entry.timer);
    armTimer(id, entry);
    entries.set(id, entry);
  };

  const observe: HealthMonitor["observe"] = (id) => {
    const entry = entries.get(id);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    const now = deps.now();
    entry.lastHeartbeatAt = now;
    entry.deadlineAt = now + entry.config.timeoutMs;
    armTimer(id, entry);
  };

  const untrack: HealthMonitor["untrack"] = (id) => {
    const entry = entries.get(id);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    entries.delete(id);
  };

  const shutdown: HealthMonitor["shutdown"] = () => {
    isShutdown = true;
    for (const entry of entries.values()) clearTimeout(entry.timer);
    entries.clear();
  };

  const snapshot: HealthMonitor["snapshot"] = () => {
    const out: WorkerHealth[] = [];
    for (const [id, entry] of entries) {
      out.push({
        workerId: id,
        agentId: entry.agentId,
        state: "running",
        lastHeartbeatAt: entry.lastHeartbeatAt,
        heartbeatDeadlineAt: entry.deadlineAt,
      });
    }
    return out;
  };

  return { track, observe, untrack, shutdown, snapshot };
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `cd packages/net/daemon && bun test src/__tests__/health-monitor.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Run layer check**

Run: `cd /Users/tafeng/koi/.claude/worktrees/swift-giggling-rabbit && bun scripts/check-layers.ts`
Expected: PASS — health-monitor imports only from `@koi/core` (L0).

- [ ] **Step 6: Commit**

```bash
git add packages/net/daemon/src/health-monitor.ts packages/net/daemon/src/__tests__/health-monitor.test.ts
git commit -m "feat(daemon): health-monitor with timer-driven deadline detection"
```

---

## Task 3: Plumb `agentId` into private supervisor entries

**Files:**
- Modify: `packages/net/daemon/src/create-supervisor.ts` (extend `RestartingEntry` + `QuarantinedEntry`, populate at construction sites)

- [ ] **Step 1: Write a failing test that exercises the future `health()` read path via `list()` semantics**

This task is a prerequisite refactor — the public interface does not change yet. To prove the plumbing compiles and preserves behavior, add a regression test that restart-path workers keep their `agentId` through a crash → restart cycle, asserted via `list()`:

Append to `packages/net/daemon/src/__tests__/supervisor.test.ts`:

```typescript
describe("supervisor internal agentId propagation (prereq for health())", () => {
  it("list() returns the original agentId for a quarantined worker", async () => {
    // This test passes today (pool.entry.handle.agentId survives), but
    // documents the invariant that Task 4 relies on via RestartingEntry /
    // QuarantinedEntry carrying agentId.
    const { backend } = createFakeBackend();
    const supervisor = createSupervisor({
      maxWorkers: 2,
      shutdownDeadlineMs: 500,
      backends: { "in-process": backend },
    });
    expect(supervisor.ok).toBe(true);
    if (!supervisor.ok) return;
    const started = await supervisor.value.start(makeRequest("agentid-1"));
    expect(started.ok).toBe(true);
    const list = supervisor.value.list();
    expect(list.some((d) => d.agentId === agentId("agent-agentid-1"))).toBe(true);
    await supervisor.value.shutdown("test");
  });
});
```

- [ ] **Step 2: Run tests, expect pass (regression baseline)**

Run: `cd packages/net/daemon && bun test src/__tests__/supervisor.test.ts -t "agentId propagation"`
Expected: PASS — documents current invariant.

- [ ] **Step 3: Extend private entry types and populate at construction sites**

In `packages/net/daemon/src/create-supervisor.ts`, modify the `QuarantinedEntry` and `RestartingEntry` interfaces (lines 46-63):

```typescript
interface QuarantinedEntry {
  readonly backend: WorkerBackend;
  readonly agentId: AgentId;
  readonly reason: string;
}

interface RestartingEntry {
  readonly agentId: AgentId;
  cancelled: boolean;
  readonly done: Promise<void>;
  wake: (() => void) | undefined;
}
```

Add `AgentId` to the top-of-file import from `@koi/core`:

```typescript
import type {
  AgentId,
  KoiError,
  // … (existing imports unchanged)
} from "@koi/core";
```

Update all construction sites to pass `agentId`:

1. In `scheduleRestart` (around line 252), replace:

```typescript
    const entry: RestartingEntry = {
      cancelled: false,
      done: restartDonePromise,
      wake: undefined,
    };
```

with:

```typescript
    const entry: RestartingEntry = {
      agentId: request.agentId,
      cancelled: false,
      done: restartDonePromise,
      wake: undefined,
    };
```

2. In `performSpawn`'s spawn-timeout quarantine branch (around line 433):

```typescript
          quarantined.set(request.workerId, {
            backend,
            agentId: request.agentId,
            reason: "spawn-timeout",
          });
```

3. In the `cancelled-during-spawn-teardown-failed` quarantine branch (around line 523):

```typescript
        quarantined.set(request.workerId, {
          backend,
          agentId: request.agentId,
          reason: "cancelled-during-spawn-teardown-failed",
        });
```

4. In the watch-stream-fault quarantine branch (around line 651):

```typescript
          quarantined.set(request.workerId, {
            backend: current.backend,
            agentId: current.handle.agentId,
            reason: "watch-stream-fault-teardown-failed",
          });
```

- [ ] **Step 4: Run the daemon test suite**

Run: `cd packages/net/daemon && bun test`
Expected: PASS — behavior is unchanged; only private type surface gained a field.

- [ ] **Step 5: Run typecheck**

Run: `cd packages/net/daemon && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/net/daemon/src/create-supervisor.ts packages/net/daemon/src/__tests__/supervisor.test.ts
git commit -m "refactor(daemon): plumb agentId into RestartingEntry and QuarantinedEntry"
```

---

## Task 4: Wire health-monitor into supervisor + add `health()` method

**Files:**
- Modify: `packages/net/daemon/src/create-supervisor.ts`
- Modify: `packages/net/daemon/src/index.ts` (add `createHealthMonitor` + `HealthMonitor` type export)

- [ ] **Step 1: Write failing supervisor-level tests for `health()`**

Append to `packages/net/daemon/src/__tests__/supervisor.test.ts`:

```typescript
describe("supervisor.health()", () => {
  it("returns status:ok and empty workers on a fresh supervisor", () => {
    const { backend } = createFakeBackend();
    const supervisor = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 500,
      backends: { "in-process": backend },
    });
    if (!supervisor.ok) return;
    const h = supervisor.value.health();
    expect(h.status).toBe("ok");
    expect(h.reasons).toEqual([]);
    expect(h.workers).toEqual([]);
    expect(h.metrics.poolSize).toBe(0);
    expect(h.metrics.maxWorkers).toBe(4);
    expect(h.metrics.shuttingDown).toBe(false);
  });

  it("returns status:degraded with reason 'at_capacity' when pool is full", async () => {
    const { backend } = createFakeBackend();
    const supervisor = createSupervisor({
      maxWorkers: 1,
      shutdownDeadlineMs: 500,
      backends: { "in-process": backend },
    });
    if (!supervisor.ok) return;
    await supervisor.value.start(makeRequest("cap-1"));
    const h = supervisor.value.health();
    expect(h.status).toBe("degraded");
    expect(h.reasons).toContain("at_capacity");
    await supervisor.value.shutdown("test");
  });

  it("returns status:unhealthy with reason 'shutting_down' during shutdown", async () => {
    const { backend } = createFakeBackend();
    const supervisor = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 500,
      backends: { "in-process": backend },
    });
    if (!supervisor.ok) return;
    await supervisor.value.start(makeRequest("sd-1"));
    const shutdownPromise = supervisor.value.shutdown("test");
    // Pull health mid-shutdown — shuttingDown flag is set synchronously.
    const h = supervisor.value.health();
    expect(h.status).toBe("unhealthy");
    expect(h.reasons).toEqual(["shutting_down"]);
    await shutdownPromise;
  });

  it("includes non-heartbeat-opted workers with lastHeartbeatAt undefined", async () => {
    const { backend } = createFakeBackend();
    const supervisor = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 500,
      backends: { "in-process": backend },
    });
    if (!supervisor.ok) return;
    await supervisor.value.start(makeRequest("no-hb"));
    const h = supervisor.value.health();
    const w = h.workers.find((x) => x.workerId === workerId("no-hb"));
    expect(w).toBeDefined();
    expect(w?.lastHeartbeatAt).toBeUndefined();
    expect(w?.heartbeatDeadlineAt).toBeUndefined();
    expect(w?.agentId).toBe(agentId("agent-no-hb"));
    await supervisor.value.shutdown("test");
  });

  it("heartbeat-opt-in worker: lastHeartbeatAt advances on each observed heartbeat", async () => {
    const { backend, heartbeat } = createFakeBackend();
    const supervisor = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 500,
      heartbeat: { intervalMs: 50, timeoutMs: 200 },
      backends: { "in-process": backend },
    });
    if (!supervisor.ok) return;
    await supervisor.value.start({
      workerId: workerId("hb-1"),
      agentId: agentId("agent-hb-1"),
      command: ["echo", "hb"],
      backendHints: { heartbeat: true },
    });
    // Give the supervisor's watch IIFE a microtask to attach to the backend.
    await new Promise((r) => setTimeout(r, 10));
    heartbeat(workerId("hb-1"));
    await new Promise((r) => setTimeout(r, 10));
    const first = supervisor.value.health().workers.find((w) => w.workerId === workerId("hb-1"));
    const firstTs = first?.lastHeartbeatAt;
    expect(typeof firstTs).toBe("number");
    await new Promise((r) => setTimeout(r, 20));
    heartbeat(workerId("hb-1"));
    await new Promise((r) => setTimeout(r, 10));
    const second = supervisor.value.health().workers.find((w) => w.workerId === workerId("hb-1"));
    expect(second?.lastHeartbeatAt).toBeGreaterThan(firstTs ?? 0);
    await supervisor.value.shutdown("test");
  });
});
```

This test calls a new `heartbeat(id)` helper on `FakeBackendControls`. Add it to `packages/net/daemon/src/__tests__/fake-backend.ts`:

Extend the `FakeBackendControls` interface:

```typescript
export interface FakeBackendControls {
  readonly backend: WorkerBackend;
  readonly crash: (id: WorkerId, at?: number) => void;
  readonly exit: (id: WorkerId, code?: number) => void;
  readonly heartbeat: (id: WorkerId, at?: number) => void;
  readonly isAlive: (id: WorkerId) => boolean;
  readonly liveWorkerCount: () => number;
}
```

And in the factory's return object, add:

```typescript
    heartbeat: (id, at = Date.now()) => {
      const s = workers.get(id);
      if (s === undefined) return;
      s.emit({ kind: "heartbeat", workerId: id, at });
    },
```

No internal-state exposure and no `unknown` casts — matches the existing `crash`/`exit` shape.

- [ ] **Step 2: Run tests, expect failure**

Run: `cd packages/net/daemon && bun test src/__tests__/supervisor.test.ts -t "supervisor.health"`
Expected: FAIL — `supervisor.value.health` is not a function.

- [ ] **Step 3: Wire health-monitor into `create-supervisor.ts`**

At the top of `create-supervisor.ts`, add imports:

```typescript
import type {
  AgentId,
  HeartbeatConfig,
  KoiError,
  ProcessDescriptor,
  Result,
  Supervisor,
  SupervisorConfig,
  SupervisorHealth,
  SupervisorHealthMetrics,
  SupervisorHealthStatus,
  WorkerBackend,
  WorkerBackendKind,
  WorkerEvent,
  WorkerHandle,
  WorkerHealth,
  WorkerId,
  WorkerRestartPolicy,
  WorkerSpawnRequest,
} from "@koi/core";
import {
  DEFAULT_HEARTBEAT_CONFIG,
  DEFAULT_WORKER_RESTART_POLICY,
  validateSupervisorConfig,
} from "@koi/core";
import { createHealthMonitor } from "./health-monitor.js";
```

Inside `createSupervisor`, after `const defaultPolicy = ...` (around line 110):

```typescript
  const heartbeatDefaults: HeartbeatConfig = config.heartbeat ?? DEFAULT_HEARTBEAT_CONFIG;

  // Late-bound `stop` reference. The teardown callback only fires on a timer
  // tick — async, long after `stop` is initialized — so a raw closure over
  // `stop` would work, but the indirection here makes the ordering explicit
  // and keeps the code robust against future construction-order changes.
  let stopRef: Supervisor["stop"] | undefined;
  const healthMonitor = createHealthMonitor({
    publishEvent,
    teardown: async (id, reason) => {
      if (stopRef === undefined) return;
      await stopRef(id, reason);
    },
    now: Date.now,
  });
```

Later in the file, after the `const stop: Supervisor["stop"] = ...` declaration, bind the reference:

```typescript
  stopRef = stop;
```

Add helpers to detect the heartbeat opt-in and derive the per-worker heartbeat config:

```typescript
  const isHeartbeatOptIn = (request: WorkerSpawnRequest): boolean => {
    const hints = request.backendHints;
    if (hints === undefined) return false;
    return hints.heartbeat === true;
  };
```

Inside `performSpawn`, directly after the `pool.set(request.workerId, entry);` block (around line 562), add:

```typescript
    if (isHeartbeatOptIn(request)) {
      healthMonitor.track(request.workerId, request.agentId, heartbeatDefaults);
    }
```

Inside the watch-loop IIFE (around line 576), modify the for-await so that heartbeat events are routed through the monitor. Replace the existing:

```typescript
        for await (const ev of backend.watch(request.workerId)) {
          publishEvent(ev);
          if (ev.kind !== "exited" && ev.kind !== "crashed") continue;
          // … existing teardown/restart logic …
        }
```

with:

```typescript
        for await (const ev of backend.watch(request.workerId)) {
          publishEvent(ev);
          if (ev.kind === "heartbeat") {
            healthMonitor.observe(ev.workerId);
            continue;
          }
          if (ev.kind !== "exited" && ev.kind !== "crashed") continue;
          healthMonitor.untrack(ev.workerId);
          // … existing teardown/restart logic …
        }
```

Also in the watch-stream-fault catch branch (around line 636), after `pool.delete(request.workerId);`, add:

```typescript
        healthMonitor.untrack(request.workerId);
```

Similarly in `stop()`, at the start of the function, after establishing the stopping entry (before `entry.stopping = true`), add:

```typescript
    healthMonitor.untrack(id);
```

In `shutdown()`, after the `while (pendingRestarts.size > 0) { … }` block, add:

```typescript
    healthMonitor.shutdown();
```

Add the `deriveStatus` pure helper near the top of the file (after `BACKEND_PREFERENCE`):

```typescript
function deriveStatus(m: SupervisorHealthMetrics): {
  readonly status: SupervisorHealthStatus;
  readonly reasons: readonly string[];
} {
  if (m.shuttingDown) return { status: "unhealthy", reasons: ["shutting_down"] };
  const reasons: string[] = [];
  if (m.quarantinedCount > 0) reasons.push("quarantined_workers");
  if (m.eventDropCount > 0) reasons.push("event_buffer_drops");
  if (m.poolSize + m.pendingSpawnCount >= m.maxWorkers) reasons.push("at_capacity");
  return { status: reasons.length > 0 ? "degraded" : "ok", reasons };
}
```

Add the `health` method before the final `return { start, stop, shutdown, list, watchAll };` line:

```typescript
  const health: Supervisor["health"] = () => {
    const metrics: SupervisorHealthMetrics = {
      poolSize: pool.size,
      maxWorkers: config.maxWorkers,
      quarantinedCount: quarantined.size,
      restartingCount: restarting.size,
      pendingSpawnCount: pendingSpawns,
      eventDropCount: droppedCount,
      shuttingDown,
    };
    const tracked = healthMonitor.snapshot();
    const trackedIds = new Set(tracked.map((w) => w.workerId));
    const extras: WorkerHealth[] = [];
    for (const [id, entry] of pool) {
      if (trackedIds.has(id)) continue;
      extras.push({
        workerId: id,
        agentId: entry.handle.agentId,
        state: entry.stopping ? "stopping" : "running",
        lastHeartbeatAt: undefined,
        heartbeatDeadlineAt: undefined,
      });
    }
    for (const [id, q] of quarantined) {
      if (trackedIds.has(id) || pool.has(id)) continue;
      extras.push({
        workerId: id,
        agentId: q.agentId,
        state: "quarantined",
        lastHeartbeatAt: undefined,
        heartbeatDeadlineAt: undefined,
      });
    }
    for (const [id, r] of restarting) {
      if (trackedIds.has(id) || pool.has(id)) continue;
      extras.push({
        workerId: id,
        agentId: r.agentId,
        state: "restarting",
        lastHeartbeatAt: undefined,
        heartbeatDeadlineAt: undefined,
      });
    }
    const { status, reasons } = deriveStatus(metrics);
    return { status, reasons, metrics, workers: [...tracked, ...extras] };
  };
```

Update the final return:

```typescript
  return { ok: true, value: { start, stop, shutdown, list, watchAll, health } };
```

- [ ] **Step 4: Export `createHealthMonitor` from `packages/net/daemon/src/index.ts`**

Modify `packages/net/daemon/src/index.ts` — add these lines:

```typescript
export type { HealthMonitor, HealthMonitorDeps } from "./health-monitor.js";
export { createHealthMonitor } from "./health-monitor.js";
```

- [ ] **Step 5: Run supervisor tests, expect pass**

Run: `cd packages/net/daemon && bun test src/__tests__/supervisor.test.ts`
Expected: PASS — all existing tests + 5 new `health()` tests.

- [ ] **Step 6: Run full daemon suite + typecheck + layers**

Run: `cd packages/net/daemon && bun run test && bun run typecheck && cd /Users/tafeng/koi/.claude/worktrees/swift-giggling-rabbit && bun scripts/check-layers.ts`
Expected: PASS for all three.

- [ ] **Step 7: Commit**

```bash
git add packages/net/daemon/src/create-supervisor.ts packages/net/daemon/src/index.ts packages/net/daemon/src/__tests__/supervisor.test.ts packages/net/daemon/src/__tests__/fake-backend.ts
git commit -m "feat(daemon): integrate health-monitor into supervisor, add health() method"
```

---

## Task 5: Subprocess-backend IPC heartbeat wiring

**Files:**
- Modify: `packages/net/daemon/src/subprocess-backend.ts`

- [ ] **Step 1: Write failing integration test with a real Bun subprocess**

Create `packages/net/daemon/src/__tests__/heartbeat-subprocess.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import type { WorkerEvent } from "@koi/core";
import { agentId, workerId } from "@koi/core";
import { createSubprocessBackend } from "../subprocess-backend.js";

const HEARTBEAT_CHILD = `
setInterval(() => {
  if (typeof process.send === "function") process.send({ koi: "heartbeat" });
}, 30);
setTimeout(() => process.exit(0), 500);
`;

const NO_HEARTBEAT_CHILD = `
setTimeout(() => process.exit(0), 500);
`;

const collect = async (
  iter: AsyncIterable<WorkerEvent>,
  stopPredicate: (ev: WorkerEvent) => boolean,
  timeoutMs = 1_000,
): Promise<readonly WorkerEvent[]> => {
  const out: WorkerEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  for await (const ev of iter) {
    out.push(ev);
    if (stopPredicate(ev)) break;
    if (Date.now() > deadline) break;
  }
  return out;
};

describe("subprocess heartbeat (IPC opt-in)", () => {
  it("emits heartbeat WorkerEvent when child sends {koi:'heartbeat'} via process.send", async () => {
    const backend = createSubprocessBackend();
    const id = workerId("ipc-hb-1");
    const spawned = await backend.spawn({
      workerId: id,
      agentId: agentId("agent-ipc-hb-1"),
      command: ["bun", "-e", HEARTBEAT_CHILD],
      backendHints: { heartbeat: true },
    });
    expect(spawned.ok).toBe(true);
    const events = await collect(
      backend.watch(id),
      (ev) => ev.kind === "exited" || ev.kind === "crashed",
      2_000,
    );
    const heartbeats = events.filter((e) => e.kind === "heartbeat");
    expect(heartbeats.length).toBeGreaterThan(0);
  });

  it("does NOT attach IPC handler when backendHints.heartbeat is absent", async () => {
    const backend = createSubprocessBackend();
    const id = workerId("no-ipc-hb-1");
    const spawned = await backend.spawn({
      workerId: id,
      agentId: agentId("agent-no-ipc-hb-1"),
      command: ["bun", "-e", HEARTBEAT_CHILD],
    });
    expect(spawned.ok).toBe(true);
    const events = await collect(
      backend.watch(id),
      (ev) => ev.kind === "exited" || ev.kind === "crashed",
      2_000,
    );
    const heartbeats = events.filter((e) => e.kind === "heartbeat");
    expect(heartbeats.length).toBe(0);
  });

  it("child that never heartbeats still exits cleanly under IPC opt-in (backend is permissive)", async () => {
    const backend = createSubprocessBackend();
    const id = workerId("silent-hb-1");
    const spawned = await backend.spawn({
      workerId: id,
      agentId: agentId("agent-silent-hb-1"),
      command: ["bun", "-e", NO_HEARTBEAT_CHILD],
      backendHints: { heartbeat: true },
    });
    expect(spawned.ok).toBe(true);
    const events = await collect(
      backend.watch(id),
      (ev) => ev.kind === "exited" || ev.kind === "crashed",
      2_000,
    );
    expect(events.some((e) => e.kind === "exited")).toBe(true);
    expect(events.filter((e) => e.kind === "heartbeat").length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

Run: `cd packages/net/daemon && bun test src/__tests__/heartbeat-subprocess.test.ts`
Expected: FAIL — first test fails because the backend never emits a `heartbeat` event (IPC not wired).

- [ ] **Step 3: Wire IPC handler in `subprocess-backend.ts`**

In `packages/net/daemon/src/subprocess-backend.ts`, find the `spawnOptions` construction around line 106 and extend it with optional IPC handling:

```typescript
      const spawnOptions: Parameters<typeof Bun.spawn>[1] = {
        env,
        stdin: "ignore",
        stdout: logFd ?? "ignore",
        stderr: logFd ?? "ignore",
      };
      if (request.cwd !== undefined) {
        spawnOptions.cwd = request.cwd;
      }
      if (isHeartbeatOptIn(request)) {
        spawnOptions.ipc = (message: unknown): void => {
          if (isHeartbeatMessage(message)) {
            emit(state, {
              kind: "heartbeat",
              workerId: request.workerId,
              at: Date.now(),
            });
          }
        };
      }
      const proc = Bun.spawn([...request.command], spawnOptions);
```

Note: `state` is referenced inside the ipc handler before its declaration. To avoid a temporal dead zone, refactor so the handler closes over a forward-declared variable:

```typescript
      let state: SubprocState | undefined;
      const ipcHandler = (message: unknown): void => {
        if (state === undefined) return;
        if (isHeartbeatMessage(message)) {
          emit(state, {
            kind: "heartbeat",
            workerId: request.workerId,
            at: Date.now(),
          });
        }
      };
      const spawnOptions: Parameters<typeof Bun.spawn>[1] = {
        env,
        stdin: "ignore",
        stdout: logFd ?? "ignore",
        stderr: logFd ?? "ignore",
      };
      if (request.cwd !== undefined) {
        spawnOptions.cwd = request.cwd;
      }
      if (isHeartbeatOptIn(request)) {
        spawnOptions.ipc = ipcHandler;
      }
      const proc = Bun.spawn([...request.command], spawnOptions);
      // … existing code continues: close logFd, create controller, etc.
      // Then instead of `const state: SubprocState = { … }`, write:
      state = {
        proc,
        controller,
        events: [],
        listeners: [],
        alive: true,
        terminalDelivered: false,
        terminatedIntentionally: false,
        pruneTimer: undefined,
      };
      workers.set(request.workerId, state);
```

At the bottom of the file, add the two private helpers:

```typescript
function isHeartbeatOptIn(request: WorkerSpawnRequest): boolean {
  const hints = request.backendHints;
  if (hints === undefined) return false;
  return hints.heartbeat === true;
}

function isHeartbeatMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const value = (message as { readonly koi?: unknown }).koi;
  return value === "heartbeat";
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `cd packages/net/daemon && bun test src/__tests__/heartbeat-subprocess.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run full daemon suite**

Run: `cd packages/net/daemon && bun run test`
Expected: PASS — existing subprocess + supervisor tests unaffected.

- [ ] **Step 6: Commit**

```bash
git add packages/net/daemon/src/subprocess-backend.ts packages/net/daemon/src/__tests__/heartbeat-subprocess.test.ts
git commit -m "feat(daemon): subprocess backend emits heartbeat events via Bun IPC opt-in"
```

---

## Task 6: Extend `docs/L2/daemon.md` with heartbeat + health sections

**Files:**
- Modify: `docs/L2/daemon.md`

- [ ] **Step 1: Append a "Heartbeat protocol" section after the existing "What This Enables" section**

Locate the section in `docs/L2/daemon.md` that follows the "What This Enables" block (search for `## Why It Exists` and the next `##` header). Insert a new `## Heartbeat Protocol` and `## Health Reporting` section. The content must match actual exported API:

```markdown
## Heartbeat Protocol

Workers can opt into supervisor-side liveness monitoring by sending heartbeat messages over Bun's native IPC channel. Unlike OS-level `isAlive` polling (which only catches crashes), heartbeats also detect hangs — a looping worker that never finishes a task will miss its heartbeat deadline and be torn down.

### Opting in

Set `backendHints.heartbeat: true` in the spawn request:

```typescript
await supervisor.start({
  workerId: workerId("research-1"),
  agentId: agentId("agent-research"),
  command: ["bun", "run", "./my-worker.ts"],
  backendHints: { heartbeat: true },
});
```

### Child-side pattern

The child process sends a single-shape message over IPC:

```typescript
// Inside the worker's main loop:
setInterval(() => {
  if (typeof process.send === "function") {
    process.send({ koi: "heartbeat" });
  }
}, 5_000); // Advisory cadence — must be shorter than config.heartbeat.timeoutMs
```

The supervisor ignores any IPC message that is not a heartbeat, leaving room for future control messages.

### Configuration

`SupervisorConfig.heartbeat` sets global defaults (`DEFAULT_HEARTBEAT_CONFIG = { intervalMs: 5_000, timeoutMs: 15_000 }`):

```typescript
const supervisor = createSupervisor({
  maxWorkers: 4,
  shutdownDeadlineMs: 10_000,
  heartbeat: { intervalMs: 5_000, timeoutMs: 15_000 },
  backends: { subprocess: createSubprocessBackend() },
});
```

### Timeout behavior

If no heartbeat arrives within `timeoutMs`, the supervisor:

1. Publishes a synthetic `WorkerEvent` of kind `"crashed"` with `error.code = "HEARTBEAT_TIMEOUT"` — visible via `watchAll()` to any observer.
2. Invokes `stop(workerId, "heartbeat-timeout")` — graceful terminate, then kill after `shutdownDeadlineMs`.
3. Does not auto-restart. Callers that want automatic restart after a heartbeat timeout should wrap `stop()`; this may become a first-class policy in a follow-up issue.

The first heartbeat must arrive within `timeoutMs` of spawn — there is no separate startup grace window. Workers with non-trivial boot cost should emit an early heartbeat as soon as initialization completes.

## Health Reporting

`supervisor.health()` is a synchronous, in-memory snapshot of both per-worker health and supervisor self-health:

```typescript
const h: SupervisorHealth = supervisor.health();
// h.status:  "ok" | "degraded" | "unhealthy"
// h.reasons: readonly string[]   (machine-readable tags)
// h.metrics: SupervisorHealthMetrics  (raw counters)
// h.workers: readonly WorkerHealth[]  (per-worker detail)
```

### Status derivation

- `"unhealthy"` ⇢ supervisor is shutting down
- `"degraded"` ⇢ any of: quarantined workers exist, event-buffer drops occurred, pool is at capacity
- `"ok"` ⇢ no degrading condition

Reasons vocabulary:
- `"shutting_down"` — supervisor-level
- `"quarantined_workers"` — one or more workers have unconfirmed liveness
- `"event_buffer_drops"` — the event ring buffer has evicted events (subscribers may have missed some)
- `"at_capacity"` — `poolSize + pendingSpawnCount >= maxWorkers`

### WorkerHealth fields

```typescript
interface WorkerHealth {
  readonly workerId: WorkerId;
  readonly agentId: AgentId;
  readonly state: "running" | "restarting" | "quarantined" | "stopping";
  readonly lastHeartbeatAt: number | undefined;       // undefined for non-heartbeat-tracked workers
  readonly heartbeatDeadlineAt: number | undefined;   // undefined for non-heartbeat-tracked workers
}
```

Non-heartbeat-tracked workers (those spawned without `backendHints.heartbeat: true`) appear in `workers[]` with `lastHeartbeatAt` and `heartbeatDeadlineAt` set to `undefined`.
```

- [ ] **Step 2: Run the doc gate**

Run: `cd /Users/tafeng/koi/.claude/worktrees/swift-giggling-rabbit && bun scripts/check-doc-gate.ts`
Expected: PASS — daemon.md exists and references exported API.

- [ ] **Step 3: Commit**

```bash
git add docs/L2/daemon.md
git commit -m "docs(daemon): heartbeat protocol and health reporting"
```

---

## Task 7: Golden queries — extend `@koi/runtime` golden-replay tests

**Files:**
- Modify: `packages/meta/runtime/src/__tests__/golden-replay.test.ts`

- [ ] **Step 1: Locate the existing `describe("Golden: @koi/daemon", …)` block at approximately line 10957**

- [ ] **Step 2: Append two new `test()` cases inside that `describe()` block, before the closing `});`**

```typescript
  test("heartbeat health — lastHeartbeatAt advances across emitted IPC heartbeats", async () => {
    const { createSupervisor, createSubprocessBackend } = await import("@koi/daemon");
    const { agentId, workerId } = await import("@koi/core");

    const supervisorResult = createSupervisor({
      maxWorkers: 2,
      shutdownDeadlineMs: 1_000,
      heartbeat: { intervalMs: 50, timeoutMs: 500 },
      backends: { subprocess: createSubprocessBackend() },
    });
    expect(supervisorResult.ok).toBe(true);
    if (!supervisorResult.ok) return;

    const started = await supervisorResult.value.start({
      workerId: workerId("golden-hb-1"),
      agentId: agentId("agent-golden-hb-1"),
      command: [
        "bun",
        "-e",
        "let n=0; const iv=setInterval(()=>{ if(typeof process.send==='function'){process.send({koi:'heartbeat'})} if(++n>=4){clearInterval(iv);process.exit(0)} }, 40);",
      ],
      backendHints: { heartbeat: true },
    });
    expect(started.ok).toBe(true);

    // Let a few heartbeats pump through before reading health.
    await new Promise((r) => setTimeout(r, 150));
    const first = supervisorResult.value.health();
    const worker = first.workers.find((w) => w.workerId === workerId("golden-hb-1"));
    expect(worker?.lastHeartbeatAt).toBeDefined();
    expect(first.status).toBe("ok");
    expect(first.metrics.maxWorkers).toBe(2);

    await supervisorResult.value.shutdown("test");
  });

  test("heartbeat timeout — silent worker is cleaned from health()", async () => {
    const { createSupervisor, createSubprocessBackend } = await import("@koi/daemon");
    const { agentId, workerId } = await import("@koi/core");

    const supervisorResult = createSupervisor({
      maxWorkers: 2,
      shutdownDeadlineMs: 1_000,
      heartbeat: { intervalMs: 20, timeoutMs: 100 },
      backends: { subprocess: createSubprocessBackend() },
    });
    if (!supervisorResult.ok) return;

    const started = await supervisorResult.value.start({
      workerId: workerId("golden-hb-silent"),
      agentId: agentId("agent-golden-hb-silent"),
      command: ["bun", "-e", "setTimeout(()=>{},2000)"],
      backendHints: { heartbeat: true },
    });
    expect(started.ok).toBe(true);

    // Wait past timeoutMs — supervisor should tear down the silent worker.
    await new Promise((r) => setTimeout(r, 300));
    const h = supervisorResult.value.health();
    const stillThere = h.workers.some((w) => w.workerId === workerId("golden-hb-silent"));
    expect(stillThere).toBe(false);
    expect(supervisorResult.value.list().map((d) => d.agentId)).not.toContain(
      agentId("agent-golden-hb-silent"),
    );

    await supervisorResult.value.shutdown("test");
  });
```

- [ ] **Step 3: Run the runtime golden tests**

Run: `cd packages/meta/runtime && bun test src/__tests__/golden-replay.test.ts -t "Golden: @koi/daemon"`
Expected: PASS — 4 tests total under the daemon describe block (2 existing + 2 new).

- [ ] **Step 4: Run check:golden-queries and check:orphans**

Run: `cd /Users/tafeng/koi/.claude/worktrees/swift-giggling-rabbit && bun scripts/check-golden-queries.ts && bun scripts/check-orphans.ts`
Expected: PASS — `@koi/daemon` already a `@koi/runtime` dependency (added in #1338); the two new tests satisfy the golden-coverage rule for the extended surface.

- [ ] **Step 5: Commit**

```bash
git add packages/meta/runtime/src/__tests__/golden-replay.test.ts
git commit -m "test(daemon): golden queries for heartbeat health + timeout cleanup"
```

---

## Task 8: Final CI gate

**Files:** none

- [ ] **Step 1: Run the full CI gate**

```bash
cd /Users/tafeng/koi/.claude/worktrees/swift-giggling-rabbit
bun install --frozen-lockfile
bun run test
bun run typecheck
bun run lint
bun run check:layers
bun run check:orphans
bun run check:unused
bun run check:duplicates
bun run check:doc-gate
bun run check:golden-queries
```

Expected: all PASS.

- [ ] **Step 2: If any check fails, diagnose root cause and land a fix in a new commit**

Do not skip checks, suppress errors, or weaken tests. If `check:duplicates` flags the new `isHeartbeatOptIn` helper as duplicated across `create-supervisor.ts` and `subprocess-backend.ts`, extract it to a shared module `packages/net/daemon/src/heartbeat-opt-in.ts` as a single-line helper and import from both — that is the only acceptable dedup path.

- [ ] **Step 3: Open PR**

```bash
gh pr create --title "feat(daemon): heartbeat + health monitoring (closes #1341)" --body "$(cat <<'EOF'
## Summary
- Add worker heartbeat IPC protocol — opt-in via `WorkerSpawnRequest.backendHints.heartbeat: true`.
- Add supervisor timeout detection — missed heartbeat emits synthetic `crashed` with `error.code = "HEARTBEAT_TIMEOUT"` and tears down the hung process via existing `stop()` pipeline.
- Add `supervisor.health(): SupervisorHealth` — three-state verdict (`ok` / `degraded` / `unhealthy`) + raw metrics + per-worker detail.
- Subprocess backend wires Bun IPC when opted in.
- Extends `@koi/daemon` by ~300 LOC (production); zero new packages.

## Test plan
- [x] Unit tests on `health-monitor` — 10 tests, fake timers, covers all code paths
- [x] Integration tests on subprocess IPC — 3 tests with real `Bun.spawn`
- [x] Supervisor tests — `health()` returns correct status on fresh/at-capacity/shutting-down/heartbeat-tracked cases
- [x] Golden queries — heartbeat cadence + timeout cleanup, no LLM
- [x] `check:layers` / `check:orphans` / `check:doc-gate` / `check:golden-queries` all pass
- [x] Docs: `docs/L2/daemon.md` updated with heartbeat + health sections

## Notes
- No new `WorkerEvent` kind — reuses `crashed` with tagged `error.code`; keeps L0 contract stable.
- Auto-restart after heartbeat timeout is deferred (spec §12); callers wrap `stop()` if they need it.
- HTTP health endpoint deferred — sidecar package if/when external probes are a requirement.
EOF
)"
```

- [ ] **Step 4: Return the PR URL**

---

## Self-Review

- [x] **Spec coverage**
  - Worker heartbeat protocol → Tasks 1, 2, 5
  - Health check endpoints (in-memory API) → Tasks 1, 4
  - Worker failure detection (missed heartbeats) → Tasks 2, 4
  - Dead worker cleanup → Task 2 (teardown), Task 4 (untrack on terminal event)
  - Health status reporting → Tasks 1, 4
  - Supervisor self-health monitoring → Task 4 (`deriveStatus`)
  - Heartbeat received within interval (test AC) → Task 5 (test 1), Task 7 (golden 1)
  - Missed heartbeats trigger failure detection (test AC) → Task 2 (test 1), Task 7 (golden 2)
  - Dead worker cleaned up from registry (test AC) → Task 4 (test 5), Task 7 (golden 2)
  - Health endpoint returns correct status (test AC) → Task 4 (tests 1-4)
  - Supervisor monitors own health (test AC) → Task 4 (tests 1-3)
- [x] **No placeholders** — every step has exact code; no "TBD", "later", "fill in"
- [x] **Type consistency** — `HeartbeatConfig`, `HealthMonitor`, `SupervisorHealth`, `WorkerHealth`, `createHealthMonitor` used identically across tasks; reason strings (`"at_capacity"`, `"quarantined_workers"`, `"event_buffer_drops"`, `"shutting_down"`) match spec and tests
- [x] **File paths** — all absolute from repo root
- [x] **TDD order preserved** — every implementation task has a failing test step before the implementation step
- [x] **Frequent commits** — eight named commits aligned with the issue's AC-by-AC structure

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-19-daemon-heartbeat-health.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
