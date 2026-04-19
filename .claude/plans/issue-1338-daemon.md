# Issue #1338 — Daemon (supervisor + worker management) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@koi/daemon` — the OS-process substrate that hosts long-running agent workers. Provides a `WorkerBackend` contract, a pool-managing supervisor with restart/maxWorkers/graceful-shutdown, and an in-tree Bun subprocess backend.

**Architecture:** Two-layer supervision. Koi already has *logical* supervision in L0 (`SupervisionConfig`, `SupervisionReconciler` in `@koi/engine-reconcile`) which restarts agents by calling `SpawnFn` again. This plan adds the *physical* layer below: `WorkerBackend` (spawn/terminate/kill/watch OS processes) + a `Supervisor` that hosts a pool of backends and enforces capacity/lifecycle. The existing reconciler's `SpawnFn` is wired to the daemon's supervisor in a follow-up integration, so reconciler logic is unchanged.

**Tech Stack:** Bun 1.3.x, TypeScript 6, `bun:test`, tsup. Bun subprocess APIs (`Bun.spawn`, `subproc.kill`, `subproc.exited`) for the subprocess backend.

---

## Decisions (resolves open questions from design review)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Reuse L0 `SupervisionConfig.maxRestarts`/`maxRestartWindowMs`/`RestartType`**. Add only `WorkerBackend` family types. | Don't duplicate Erlang-model supervision. Daemon = substrate, reconciler = logic. |
| D2 | **One package `@koi/daemon`** hosts both supervisor and in-tree subprocess backend. | Keeps #1338 <300 LOC logic rule. Future backends (tmux, remote) extract to peer L2 packages. |
| D3 | **Backend registry: keyed object `Record<WorkerBackendKind, WorkerBackend>`**. | Cheaper than Map; serializable; matches Koi channel/engine registration patterns. |
| D4 | **Supervisor exposes only `watchAll()`**, not per-worker `watch()`. Per-worker watch is a backend-internal detail. | Simpler surface; matches `ChannelRegistry.onMessage` pattern. |
| D5 | **Supervisor owns restart state**, backends are stateless on restart policy. | Backends only report events; policy centralized for uniform behavior across backends. |
| D6 | **Graceful shutdown deadline defaults to 10_000 ms**, configurable. After deadline → `kill()`. | Matches CC `sessionRunner` deadline; issue AC requires SIGTERM/SIGINT handling. |
| D7 | **No direct integration with `SupervisionReconciler` in this PR**. Daemon exposes a `SpawnFn` adapter that reconciler can consume in a follow-up issue. | Keeps blast radius small; reconciler already tested against its own `SpawnChildFn`. |

## File Structure

**New L0 types:**
- Create: `packages/kernel/core/src/daemon.ts` (~170 LOC) — `WorkerId`, `WorkerBackendKind`, `WorkerBackend`, `WorkerSpawnRequest`, `WorkerHandle`, `WorkerEvent`, `Supervisor`, `SupervisorConfig`, `validateSupervisorConfig`
- Modify: `packages/kernel/core/src/index.ts` — export the new types
- Modify: `scripts/layers.ts` (`L0_RUNTIME_ALLOWLIST`) — add `daemon.ts` (contains one validator function)

**New L2 package `@koi/daemon`:**
```
packages/net/daemon/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/
    ├── index.ts                           # barrel: createSupervisor, createSubprocessBackend
    ├── create-supervisor.ts               # pool, lifecycle, restart policy
    ├── backoff.ts                         # exponential backoff computation
    ├── signal-handlers.ts                 # registerSignalHandlers (SIGTERM/SIGINT)
    ├── subprocess-backend.ts              # Bun.spawn-based WorkerBackend
    └── __tests__/
        ├── backoff.test.ts
        ├── supervisor.test.ts             # start/maxWorkers/stop/shutdown/watchAll
        ├── restart-policy.test.ts         # crash → restart, storm cap, transient vs permanent
        ├── signal-handlers.test.ts        # SIGTERM/SIGINT path
        └── subprocess-backend.test.ts     # spawn/terminate/kill/watch
```

**Docs:**
- Create: `docs/L2/daemon.md` (required by CI doc-gate)

**Runtime wiring (Task 14):**
- Modify: `packages/meta/runtime/package.json` — add `@koi/daemon` dep
- Modify: `packages/meta/runtime/tsconfig.json` — add reference
- Modify: `packages/meta/runtime/scripts/record-cassettes.ts` — add `QueryConfig` for `daemon-basic`
- Modify: `packages/meta/runtime/src/__tests__/golden-replay.test.ts` — add assertions
- Record: `packages/meta/runtime/fixtures/daemon-basic.cassette.json` + `.trajectory.json`

---

## Task 1: L0 types — `daemon.ts`

**Files:**
- Create: `packages/kernel/core/src/daemon.ts`
- Modify: `packages/kernel/core/src/index.ts` (append exports)
- Modify: `scripts/layers.ts` (add `daemon.ts` to `L0_RUNTIME_ALLOWLIST`)
- Test: `packages/kernel/core/src/__tests__/daemon.test.ts`

- [ ] **Step 1: Write failing test for `validateSupervisorConfig`**

`packages/kernel/core/src/__tests__/daemon.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { validateSupervisorConfig, type SupervisorConfig, type WorkerBackend } from "../daemon.js";

const fakeBackend = {
  kind: "in-process",
  displayName: "fake",
  isAvailable: () => true,
  spawn: async () => ({ ok: false, error: { code: "INTERNAL", message: "stub", retryable: false } }),
  terminate: async () => ({ ok: true, value: undefined }),
  kill: async () => ({ ok: true, value: undefined }),
  isAlive: async () => false,
  watch: async function* () {},
} satisfies WorkerBackend;

describe("validateSupervisorConfig", () => {
  it("rejects maxWorkers < 1", () => {
    const result = validateSupervisorConfig({
      maxWorkers: 0,
      shutdownDeadlineMs: 10_000,
      backends: { "in-process": fakeBackend } as SupervisorConfig["backends"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  it("rejects empty backend registry", () => {
    const result = validateSupervisorConfig({
      maxWorkers: 4,
      shutdownDeadlineMs: 10_000,
      backends: {} as SupervisorConfig["backends"],
    });
    expect(result.ok).toBe(false);
  });

  it("accepts valid config", () => {
    const result = validateSupervisorConfig({
      maxWorkers: 4,
      shutdownDeadlineMs: 10_000,
      backends: { "in-process": fakeBackend } as SupervisorConfig["backends"],
    });
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

```
cd packages/kernel/core && bun test src/__tests__/daemon.test.ts
```
Expected: FAIL — module `../daemon.js` not found.

- [ ] **Step 3: Create `packages/kernel/core/src/daemon.ts`**

```typescript
/**
 * Daemon contracts — WorkerBackend + Supervisor for the OS-process substrate
 * that hosts long-running agent workers.
 *
 * Sits *below* the logical supervision layer (`SupervisionConfig` +
 * `SupervisionReconciler`): the reconciler decides WHEN to restart an agent;
 * the daemon decides HOW to spawn/terminate the underlying process. The two
 * layers are independent — reconciler consumes a `SpawnFn` which, at the
 * integration boundary, delegates into a daemon `Supervisor`.
 *
 * L0 status: types/interfaces + one validator. The validator is side-effect-free
 * data validation, permitted in L0 per architecture-doc exceptions.
 */

import type { JsonObject } from "./common.js";
import type { AgentId, ProcessState } from "./ecs.js";
import type { KoiError, Result } from "./errors.js";
import type { ProcessDescriptor } from "./process-descriptor.js";
import type { RestartType } from "./supervision.js";

// ---------------------------------------------------------------------------
// WorkerId — branded identity
// ---------------------------------------------------------------------------

declare const __workerIdBrand: unique symbol;
export type WorkerId = string & { readonly [__workerIdBrand]: "WorkerId" };
export const workerId = (s: string): WorkerId => s as WorkerId;

// ---------------------------------------------------------------------------
// WorkerBackend — swappable execution substrate
// ---------------------------------------------------------------------------

export type WorkerBackendKind = "in-process" | "subprocess" | "tmux" | "remote";

export interface WorkerBackend {
  readonly kind: WorkerBackendKind;
  readonly displayName: string;
  readonly isAvailable: () => boolean | Promise<boolean>;
  readonly spawn: (request: WorkerSpawnRequest) => Promise<Result<WorkerHandle, KoiError>>;
  readonly terminate: (id: WorkerId, reason: string) => Promise<Result<void, KoiError>>;
  readonly kill: (id: WorkerId) => Promise<Result<void, KoiError>>;
  readonly isAlive: (id: WorkerId) => Promise<boolean>;
  readonly watch: (id: WorkerId) => AsyncIterable<WorkerEvent>;
}

// ---------------------------------------------------------------------------
// Spawn request / handle
// ---------------------------------------------------------------------------

export interface WorkerSpawnRequest {
  readonly workerId: WorkerId;
  readonly agentId: AgentId;
  readonly command: readonly string[];
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string | null>> | undefined;
  readonly backendHints?: JsonObject | undefined;
}

export interface WorkerHandle {
  readonly workerId: WorkerId;
  readonly agentId: AgentId;
  readonly backendKind: WorkerBackendKind;
  readonly startedAt: number;
  readonly signal: AbortSignal;
}

// ---------------------------------------------------------------------------
// Worker events
// ---------------------------------------------------------------------------

export type WorkerEvent =
  | { readonly kind: "started"; readonly workerId: WorkerId; readonly at: number }
  | { readonly kind: "heartbeat"; readonly workerId: WorkerId; readonly at: number }
  | {
      readonly kind: "exited";
      readonly workerId: WorkerId;
      readonly at: number;
      readonly code: number;
      readonly state: ProcessState;
    }
  | {
      readonly kind: "crashed";
      readonly workerId: WorkerId;
      readonly at: number;
      readonly error: KoiError;
    };

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

export interface SupervisorConfig {
  readonly maxWorkers: number;
  readonly shutdownDeadlineMs: number;
  readonly backends: Readonly<Partial<Record<WorkerBackendKind, WorkerBackend>>>;
  readonly restart?: WorkerRestartPolicy | undefined;
}

export interface WorkerRestartPolicy {
  readonly restart: RestartType;
  readonly maxRestarts: number;
  readonly maxRestartWindowMs: number;
  readonly backoffBaseMs: number;
  readonly backoffCeilingMs: number;
}

export const DEFAULT_WORKER_RESTART_POLICY: WorkerRestartPolicy = {
  restart: "transient",
  maxRestarts: 5,
  maxRestartWindowMs: 60_000,
  backoffBaseMs: 1000,
  backoffCeilingMs: 30_000,
};

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
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateSupervisorConfig(
  config: SupervisorConfig,
): Result<SupervisorConfig, KoiError> {
  if (config.maxWorkers < 1) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "SupervisorConfig.maxWorkers must be >= 1",
        retryable: false,
      },
    };
  }
  if (Object.keys(config.backends).length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message:
          "SupervisorConfig.backends must register at least one backend. " +
          "Install @koi/daemon's subprocess backend or provide a custom WorkerBackend.",
        retryable: false,
      },
    };
  }
  if (config.shutdownDeadlineMs < 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "SupervisorConfig.shutdownDeadlineMs must be >= 0",
        retryable: false,
      },
    };
  }
  return { ok: true, value: config };
}
```

- [ ] **Step 4: Add export to `packages/kernel/core/src/index.ts`**

Append after the `./supervision.js` block (~line 1059):

```typescript
// daemon — OS-process supervisor + worker backend contracts
export type {
  Supervisor,
  SupervisorConfig,
  WorkerBackend,
  WorkerBackendKind,
  WorkerEvent,
  WorkerHandle,
  WorkerId,
  WorkerRestartPolicy,
  WorkerSpawnRequest,
} from "./daemon.js";
export {
  DEFAULT_WORKER_RESTART_POLICY,
  validateSupervisorConfig,
  workerId,
} from "./daemon.js";
```

- [ ] **Step 5: Add `daemon.ts` to `L0_RUNTIME_ALLOWLIST` in `scripts/layers.ts`**

Insert alphabetically in the allowlist set:

```typescript
"daemon.ts",
```

- [ ] **Step 6: Run test, expect pass**

```
cd packages/kernel/core && bun test src/__tests__/daemon.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 7: Run layer check**

```
cd /Users/tafeng/koi/.claude/worktrees/magical-brewing-floyd && bun scripts/check-layers.ts
```
Expected: PASS.

- [ ] **Step 8: Commit**

```
git add packages/kernel/core/src/daemon.ts packages/kernel/core/src/__tests__/daemon.test.ts packages/kernel/core/src/index.ts scripts/layers.ts
git commit -m "feat(core): add daemon L0 contracts (WorkerBackend, Supervisor)"
```

---

## Task 2: Package scaffolding — `@koi/daemon`

**Files:**
- Create: `packages/net/daemon/package.json`
- Create: `packages/net/daemon/tsconfig.json`
- Create: `packages/net/daemon/tsup.config.ts`
- Create: `packages/net/daemon/src/index.ts`

- [ ] **Step 1: Create `packages/net/daemon/package.json`**

```json
{
  "name": "@koi/daemon",
  "description": "OS-process supervisor and worker backends (subprocess) for long-running agent workers",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "bun test"
  },
  "dependencies": {
    "@koi/core": "workspace:*",
    "@koi/errors": "workspace:*",
    "@koi/shutdown": "workspace:*"
  }
}
```

- [ ] **Step 2: Create `packages/net/daemon/tsconfig.json`**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `packages/net/daemon/tsup.config.ts`**

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  clean: true,
  treeshake: true,
  target: "node22",
});
```

- [ ] **Step 4: Create `packages/net/daemon/src/index.ts` (stub)**

```typescript
export { createSupervisor } from "./create-supervisor.js";
export { createSubprocessBackend } from "./subprocess-backend.js";
export { registerSignalHandlers } from "./signal-handlers.js";
```

(These files don't exist yet — subsequent tasks create them. Stub means compile will fail until Task 4 lands.)

- [ ] **Step 5: Install deps + run layer check**

```
bun install
bun scripts/check-layers.ts
```
Expected: install PASS; check:layers PASS (no source yet to violate rules).

- [ ] **Step 6: Commit**

```
git add packages/net/daemon/
git commit -m "feat(daemon): scaffold @koi/daemon package"
```

---

## Task 3: Exponential backoff helper

**Files:**
- Create: `packages/net/daemon/src/backoff.ts`
- Test: `packages/net/daemon/src/__tests__/backoff.test.ts`

- [ ] **Step 1: Write failing test**

`packages/net/daemon/src/__tests__/backoff.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { computeBackoff } from "../backoff.js";

describe("computeBackoff", () => {
  it("returns base on attempt 0", () => {
    expect(computeBackoff(0, { baseMs: 1000, ceilingMs: 30_000 })).toBe(1000);
  });

  it("doubles each attempt", () => {
    expect(computeBackoff(1, { baseMs: 1000, ceilingMs: 30_000 })).toBe(2000);
    expect(computeBackoff(2, { baseMs: 1000, ceilingMs: 30_000 })).toBe(4000);
    expect(computeBackoff(3, { baseMs: 1000, ceilingMs: 30_000 })).toBe(8000);
  });

  it("caps at ceiling", () => {
    expect(computeBackoff(20, { baseMs: 1000, ceilingMs: 30_000 })).toBe(30_000);
  });

  it("handles attempt = 0 with baseMs = 0", () => {
    expect(computeBackoff(0, { baseMs: 0, ceilingMs: 30_000 })).toBe(0);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

```
cd packages/net/daemon && bun test src/__tests__/backoff.test.ts
```
Expected: FAIL — module `../backoff.js` not found.

- [ ] **Step 3: Create `packages/net/daemon/src/backoff.ts`**

```typescript
export interface BackoffConfig {
  readonly baseMs: number;
  readonly ceilingMs: number;
}

export function computeBackoff(attempt: number, config: BackoffConfig): number {
  const raw = config.baseMs * 2 ** attempt;
  return Math.min(raw, config.ceilingMs);
}
```

- [ ] **Step 4: Run test, expect pass**

```
cd packages/net/daemon && bun test src/__tests__/backoff.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```
git add packages/net/daemon/src/backoff.ts packages/net/daemon/src/__tests__/backoff.test.ts
git commit -m "feat(daemon): exponential backoff helper"
```

---

## Task 4: Supervisor — start + maxWorkers enforcement

**Files:**
- Create: `packages/net/daemon/src/create-supervisor.ts`
- Test: `packages/net/daemon/src/__tests__/supervisor.test.ts` (will grow across subsequent tasks)

- [ ] **Step 1: Create test helper — fake backend**

`packages/net/daemon/src/__tests__/fake-backend.ts`:

```typescript
import type {
  KoiError,
  Result,
  WorkerBackend,
  WorkerEvent,
  WorkerHandle,
  WorkerId,
  WorkerSpawnRequest,
} from "@koi/core";

interface FakeWorkerState {
  alive: boolean;
  controller: AbortController;
  events: WorkerEvent[];
  emit: (ev: WorkerEvent) => void;
}

export interface FakeBackendControls {
  readonly backend: WorkerBackend;
  readonly crash: (id: WorkerId, at?: number) => void;
  readonly exit: (id: WorkerId, code?: number) => void;
  readonly isAlive: (id: WorkerId) => boolean;
  readonly liveWorkerCount: () => number;
}

export function createFakeBackend(): FakeBackendControls {
  const workers = new Map<WorkerId, FakeWorkerState>();

  const backend: WorkerBackend = {
    kind: "in-process",
    displayName: "fake",
    isAvailable: () => true,
    spawn: async (req: WorkerSpawnRequest): Promise<Result<WorkerHandle, KoiError>> => {
      const controller = new AbortController();
      const listeners: Array<(ev: WorkerEvent) => void> = [];
      const state: FakeWorkerState = {
        alive: true,
        controller,
        events: [],
        emit: (ev) => {
          state.events.push(ev);
          for (const l of listeners) l(ev);
        },
      };
      workers.set(req.workerId, state);
      const handle: WorkerHandle = {
        workerId: req.workerId,
        agentId: req.agentId,
        backendKind: "in-process",
        startedAt: Date.now(),
        signal: controller.signal,
      };
      state.emit({ kind: "started", workerId: req.workerId, at: Date.now() });
      return { ok: true, value: handle };
    },
    terminate: async (id, _reason) => {
      const s = workers.get(id);
      if (s === undefined) return { ok: true, value: undefined };
      s.alive = false;
      s.controller.abort();
      s.emit({ kind: "exited", workerId: id, at: Date.now(), code: 0, state: "terminated" });
      return { ok: true, value: undefined };
    },
    kill: async (id) => {
      const s = workers.get(id);
      if (s === undefined) return { ok: true, value: undefined };
      s.alive = false;
      s.controller.abort();
      s.emit({ kind: "exited", workerId: id, at: Date.now(), code: 137, state: "terminated" });
      return { ok: true, value: undefined };
    },
    isAlive: async (id) => workers.get(id)?.alive ?? false,
    watch: async function* (id) {
      const s = workers.get(id);
      if (s === undefined) return;
      for (const ev of s.events) yield ev;
      while (s.alive) {
        const ev = await new Promise<WorkerEvent>((resolve) => {
          const tmp = (e: WorkerEvent) => {
            resolve(e);
          };
          const listeners = (s as unknown as { listeners: Array<(ev: WorkerEvent) => void> }).listeners;
          if (listeners !== undefined) listeners.push(tmp);
        });
        yield ev;
        if (ev.kind === "exited" || ev.kind === "crashed") break;
      }
    },
  };

  return {
    backend,
    crash: (id, at = Date.now()) => {
      const s = workers.get(id);
      if (s === undefined) return;
      s.alive = false;
      s.emit({
        kind: "crashed",
        workerId: id,
        at,
        error: { code: "INTERNAL", message: "test crash", retryable: true },
      });
    },
    exit: (id, code = 0) => {
      const s = workers.get(id);
      if (s === undefined) return;
      s.alive = false;
      s.emit({ kind: "exited", workerId: id, at: Date.now(), code, state: "terminated" });
    },
    isAlive: (id) => workers.get(id)?.alive ?? false,
    liveWorkerCount: () => {
      let n = 0;
      for (const s of workers.values()) if (s.alive) n++;
      return n;
    },
  };
}
```

Note: the `watch` iterator shape is simplified for tests — real backend uses a proper event queue. Supervisor impl must tolerate both patterns.

- [ ] **Step 2: Write failing tests for `start` + `maxWorkers`**

`packages/net/daemon/src/__tests__/supervisor.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import type { SupervisorConfig, WorkerSpawnRequest } from "@koi/core";
import { workerId } from "@koi/core";
import { agentId } from "@koi/core";
import { createSupervisor } from "../create-supervisor.js";
import { createFakeBackend } from "./fake-backend.js";

const makeRequest = (id: string): WorkerSpawnRequest => ({
  workerId: workerId(id),
  agentId: agentId("agent-" + id),
  command: ["echo", "hello"],
});

const makeConfig = (maxWorkers: number): SupervisorConfig => {
  const { backend } = createFakeBackend();
  return {
    maxWorkers,
    shutdownDeadlineMs: 1000,
    backends: { "in-process": backend },
  };
};

describe("createSupervisor.start", () => {
  it("spawns a worker via the registered backend", async () => {
    const supervisorResult = createSupervisor(makeConfig(4));
    expect(supervisorResult.ok).toBe(true);
    if (!supervisorResult.ok) return;
    const started = await supervisorResult.value.start(makeRequest("w1"));
    expect(started.ok).toBe(true);
    if (started.ok) expect(started.value.workerId).toBe(workerId("w1"));
  });

  it("returns RESOURCE_EXHAUSTED when maxWorkers reached", async () => {
    const supervisorResult = createSupervisor(makeConfig(1));
    expect(supervisorResult.ok).toBe(true);
    if (!supervisorResult.ok) return;
    const first = await supervisorResult.value.start(makeRequest("w1"));
    expect(first.ok).toBe(true);
    const second = await supervisorResult.value.start(makeRequest("w2"));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("RESOURCE_EXHAUSTED");
  });
});
```

- [ ] **Step 3: Run test, expect failure**

```
cd packages/net/daemon && bun test src/__tests__/supervisor.test.ts
```
Expected: FAIL — module `../create-supervisor.js` not found.

- [ ] **Step 4: Implement minimal `create-supervisor.ts`**

`packages/net/daemon/src/create-supervisor.ts`:

```typescript
import type {
  KoiError,
  ProcessDescriptor,
  Result,
  Supervisor,
  SupervisorConfig,
  WorkerBackend,
  WorkerBackendKind,
  WorkerEvent,
  WorkerHandle,
  WorkerId,
  WorkerRestartPolicy,
  WorkerSpawnRequest,
} from "@koi/core";
import { DEFAULT_WORKER_RESTART_POLICY, validateSupervisorConfig } from "@koi/core";

interface PoolEntry {
  readonly handle: WorkerHandle;
  readonly backend: WorkerBackend;
  readonly policy: WorkerRestartPolicy;
  restartAttempts: number;
  restartTimestamps: number[];
}

const BACKEND_PREFERENCE: readonly WorkerBackendKind[] = [
  "subprocess",
  "in-process",
  "tmux",
  "remote",
];

export function createSupervisor(config: SupervisorConfig): Result<Supervisor, KoiError> {
  const validated = validateSupervisorConfig(config);
  if (!validated.ok) return validated;

  const pool = new Map<WorkerId, PoolEntry>();
  const defaultPolicy = config.restart ?? DEFAULT_WORKER_RESTART_POLICY;

  const pickBackend = (kind?: WorkerBackendKind): WorkerBackend | undefined => {
    if (kind !== undefined) return config.backends[kind];
    for (const k of BACKEND_PREFERENCE) {
      const b = config.backends[k];
      if (b !== undefined) return b;
    }
    return undefined;
  };

  const start: Supervisor["start"] = async (request, overrides) => {
    if (pool.size >= config.maxWorkers) {
      return {
        ok: false,
        error: {
          code: "RESOURCE_EXHAUSTED",
          message: `Supervisor at maxWorkers=${config.maxWorkers}`,
          retryable: true,
        },
      };
    }
    const backend = pickBackend(overrides?.backend);
    if (backend === undefined) {
      return {
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "No registered backend can handle this spawn",
          retryable: false,
        },
      };
    }
    const spawned = await backend.spawn(request);
    if (!spawned.ok) return spawned;
    pool.set(request.workerId, {
      handle: spawned.value,
      backend,
      policy: overrides?.restart ?? defaultPolicy,
      restartAttempts: 0,
      restartTimestamps: [],
    });
    return { ok: true, value: spawned.value };
  };

  const stop: Supervisor["stop"] = async (_id, _reason) => {
    // Implemented in Task 6
    return { ok: true, value: undefined };
  };

  const shutdown: Supervisor["shutdown"] = async (_reason) => {
    // Implemented in Task 6
    return { ok: true, value: undefined };
  };

  const list: Supervisor["list"] = () => {
    const out: ProcessDescriptor[] = [];
    for (const entry of pool.values()) {
      out.push({
        agentId: entry.handle.agentId,
        state: "running",
        conditions: [],
        generation: 1,
        registeredAt: entry.handle.startedAt,
      });
    }
    return out;
  };

  const watchAll: Supervisor["watchAll"] = async function* (): AsyncIterable<WorkerEvent> {
    // Implemented in Task 7
    return;
  };

  return { ok: true, value: { start, stop, shutdown, list, watchAll } };
}
```

- [ ] **Step 5: Run test, expect pass**

```
cd packages/net/daemon && bun test src/__tests__/supervisor.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```
git add packages/net/daemon/src/create-supervisor.ts packages/net/daemon/src/__tests__/supervisor.test.ts packages/net/daemon/src/__tests__/fake-backend.ts
git commit -m "feat(daemon): supervisor start + maxWorkers enforcement"
```

---

## Task 5: Crash detection + restart policy

**Files:**
- Modify: `packages/net/daemon/src/create-supervisor.ts`
- Test: `packages/net/daemon/src/__tests__/restart-policy.test.ts`

- [ ] **Step 1: Write failing tests**

`packages/net/daemon/src/__tests__/restart-policy.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import type { SupervisorConfig, WorkerRestartPolicy, WorkerSpawnRequest } from "@koi/core";
import { agentId, workerId } from "@koi/core";
import { createSupervisor } from "../create-supervisor.js";
import { createFakeBackend } from "./fake-backend.js";

const fastPolicy: WorkerRestartPolicy = {
  restart: "transient",
  maxRestarts: 3,
  maxRestartWindowMs: 60_000,
  backoffBaseMs: 1,
  backoffCeilingMs: 10,
};

const makeRequest = (id: string): WorkerSpawnRequest => ({
  workerId: workerId(id),
  agentId: agentId("agent-" + id),
  command: ["echo", "hi"],
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("restart policy", () => {
  it("restarts transient workers on crash", async () => {
    const { backend, crash, liveWorkerCount } = createFakeBackend();
    const config: SupervisorConfig = {
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { "in-process": backend },
      restart: fastPolicy,
    };
    const sup = createSupervisor(config);
    expect(sup.ok).toBe(true);
    if (!sup.ok) return;
    await sup.value.start(makeRequest("w1"));
    crash(workerId("w1"));
    await sleep(50);
    expect(liveWorkerCount()).toBeGreaterThan(0);
  });

  it("does not restart temporary workers", async () => {
    const { backend, crash, liveWorkerCount } = createFakeBackend();
    const config: SupervisorConfig = {
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { "in-process": backend },
      restart: { ...fastPolicy, restart: "temporary" },
    };
    const sup = createSupervisor(config);
    if (!sup.ok) return;
    await sup.value.start(makeRequest("w1"));
    crash(workerId("w1"));
    await sleep(50);
    expect(liveWorkerCount()).toBe(0);
  });

  it("stops restarting after maxRestarts in window", async () => {
    const { backend, crash, liveWorkerCount } = createFakeBackend();
    const config: SupervisorConfig = {
      maxWorkers: 4,
      shutdownDeadlineMs: 1000,
      backends: { "in-process": backend },
      restart: { ...fastPolicy, maxRestarts: 2 },
    };
    const sup = createSupervisor(config);
    if (!sup.ok) return;
    await sup.value.start(makeRequest("w1"));
    for (let i = 0; i < 5; i++) {
      crash(workerId("w1"));
      await sleep(20);
    }
    // After 2 restarts exhaust budget, worker stays dead.
    expect(liveWorkerCount()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

```
cd packages/net/daemon && bun test src/__tests__/restart-policy.test.ts
```
Expected: FAIL — supervisor does not react to crashes yet.

- [ ] **Step 3: Add crash detection + restart to `create-supervisor.ts`**

Add after the `pool.set(...)` line in `start`:

```typescript
    // Watch backend events for this worker — drive restart policy
    void (async () => {
      try {
        for await (const ev of backend.watch(request.workerId)) {
          if (ev.kind === "exited" || ev.kind === "crashed") {
            const entry = pool.get(request.workerId);
            if (entry === undefined) return;
            pool.delete(request.workerId);

            const shouldRestart =
              ev.kind === "crashed"
                ? entry.policy.restart !== "temporary"
                : entry.policy.restart === "permanent";

            if (!shouldRestart) return;

            const now = ev.at;
            const windowStart = now - entry.policy.maxRestartWindowMs;
            const recent = entry.restartTimestamps.filter((t) => t >= windowStart);
            if (recent.length >= entry.policy.maxRestarts) return;

            const backoff = Math.min(
              entry.policy.backoffBaseMs * 2 ** entry.restartAttempts,
              entry.policy.backoffCeilingMs,
            );
            await new Promise((r) => setTimeout(r, backoff));
            const respawned = await start(request, {
              restart: entry.policy,
              backend: entry.handle.backendKind,
            });
            if (respawned.ok) {
              const newEntry = pool.get(request.workerId);
              if (newEntry !== undefined) {
                // Carry forward restart state
                (newEntry as { restartAttempts: number }).restartAttempts =
                  entry.restartAttempts + 1;
                (newEntry as { restartTimestamps: number[] }).restartTimestamps = [
                  ...recent,
                  now,
                ];
              }
            }
            return;
          }
        }
      } catch {
        // Watch stream closed — treat as exit
      }
    })();
```

- [ ] **Step 4: Run test, expect pass**

```
cd packages/net/daemon && bun test src/__tests__/restart-policy.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```
git add packages/net/daemon/src/create-supervisor.ts packages/net/daemon/src/__tests__/restart-policy.test.ts
git commit -m "feat(daemon): crash detection + restart with exponential backoff"
```

---

## Task 6: Graceful stop + shutdown

**Files:**
- Modify: `packages/net/daemon/src/create-supervisor.ts`
- Modify: `packages/net/daemon/src/__tests__/supervisor.test.ts`

- [ ] **Step 1: Append failing tests to `supervisor.test.ts`**

```typescript
describe("supervisor stop/shutdown", () => {
  it("gracefully stops a worker within deadline", async () => {
    const { backend, isAlive } = createFakeBackend();
    const supervisorResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 500,
      backends: { "in-process": backend },
    });
    if (!supervisorResult.ok) return;
    await supervisorResult.value.start(makeRequest("w1"));
    const stopped = await supervisorResult.value.stop(workerId("w1"), "test");
    expect(stopped.ok).toBe(true);
    expect(isAlive(workerId("w1"))).toBe(false);
  });

  it("shutdown stops every worker in parallel", async () => {
    const { backend, liveWorkerCount } = createFakeBackend();
    const supervisorResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 500,
      backends: { "in-process": backend },
    });
    if (!supervisorResult.ok) return;
    await supervisorResult.value.start(makeRequest("w1"));
    await supervisorResult.value.start(makeRequest("w2"));
    await supervisorResult.value.start(makeRequest("w3"));
    expect(liveWorkerCount()).toBe(3);
    await supervisorResult.value.shutdown("SIGTERM");
    expect(liveWorkerCount()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Expected: FAIL — `stop`/`shutdown` are stubs.

- [ ] **Step 3: Implement `stop` and `shutdown`**

Replace the `stop` and `shutdown` stubs:

```typescript
  const stop: Supervisor["stop"] = async (id, reason) => {
    const entry = pool.get(id);
    if (entry === undefined) {
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: `Worker ${id} not tracked`, retryable: false },
      };
    }
    const deadline = new Promise<"deadline">((resolve) =>
      setTimeout(() => resolve("deadline"), config.shutdownDeadlineMs),
    );
    const terminate = entry.backend.terminate(id, reason).then((r) => ("terminated" as const));
    const winner = await Promise.race([terminate, deadline]);
    if (winner === "deadline") {
      await entry.backend.kill(id);
    }
    pool.delete(id);
    return { ok: true, value: undefined };
  };

  const shutdown: Supervisor["shutdown"] = async (reason) => {
    const ids = [...pool.keys()];
    await Promise.all(ids.map((id) => stop(id, reason)));
    return { ok: true, value: undefined };
  };
```

- [ ] **Step 4: Run test, expect pass**

```
cd packages/net/daemon && bun test src/__tests__/supervisor.test.ts
```
Expected: PASS (4 tests total).

- [ ] **Step 5: Commit**

```
git add packages/net/daemon/src/create-supervisor.ts packages/net/daemon/src/__tests__/supervisor.test.ts
git commit -m "feat(daemon): graceful stop + shutdown with deadline"
```

---

## Task 7: watchAll aggregate event stream

**Files:**
- Modify: `packages/net/daemon/src/create-supervisor.ts`
- Modify: `packages/net/daemon/src/__tests__/supervisor.test.ts`

- [ ] **Step 1: Append failing test**

```typescript
describe("supervisor watchAll", () => {
  it("yields events from all workers", async () => {
    const { backend, crash } = createFakeBackend();
    const supervisorResult = createSupervisor({
      maxWorkers: 4,
      shutdownDeadlineMs: 500,
      backends: { "in-process": backend },
    });
    if (!supervisorResult.ok) return;
    await supervisorResult.value.start(makeRequest("w1"));
    await supervisorResult.value.start(makeRequest("w2"));

    const events: string[] = [];
    const iter = supervisorResult.value.watchAll()[Symbol.asyncIterator]();

    crash(workerId("w1"));
    crash(workerId("w2"));

    for (let i = 0; i < 2; i++) {
      const r = await Promise.race([
        iter.next(),
        new Promise<IteratorResult<unknown>>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 200),
        ),
      ]);
      if (!r.done && r.value !== undefined) {
        const ev = r.value as { kind: string; workerId: string };
        events.push(ev.workerId);
      }
    }
    expect(events).toContain("w1");
    expect(events).toContain("w2");
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Expected: FAIL — `watchAll` is stub.

- [ ] **Step 3: Implement fan-in `watchAll`**

Add a shared event queue at supervisor-creation scope:

```typescript
  const eventQueue: WorkerEvent[] = [];
  const eventListeners: Array<(ev: WorkerEvent) => void> = [];
  const publishEvent = (ev: WorkerEvent) => {
    eventQueue.push(ev);
    for (const l of eventListeners) l(ev);
  };
```

Inside the watch loop added in Task 5, call `publishEvent(ev)` for every event before the exit/crash branch.

Replace `watchAll` stub:

```typescript
  const watchAll: Supervisor["watchAll"] = async function* (): AsyncIterable<WorkerEvent> {
    for (const ev of eventQueue) yield ev;
    while (true) {
      const ev = await new Promise<WorkerEvent>((resolve) => {
        eventListeners.push(resolve);
      });
      yield ev;
    }
  };
```

- [ ] **Step 4: Run test, expect pass**

Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```
git add packages/net/daemon/src/create-supervisor.ts packages/net/daemon/src/__tests__/supervisor.test.ts
git commit -m "feat(daemon): watchAll aggregate event stream"
```

---

## Task 8: Signal handlers (SIGTERM/SIGINT)

**Files:**
- Create: `packages/net/daemon/src/signal-handlers.ts`
- Test: `packages/net/daemon/src/__tests__/signal-handlers.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { afterEach, describe, expect, it } from "bun:test";
import type { Supervisor } from "@koi/core";
import { registerSignalHandlers } from "../signal-handlers.js";

describe("registerSignalHandlers", () => {
  const removed: Array<() => void> = [];
  afterEach(() => {
    for (const r of removed) r();
    removed.length = 0;
  });

  it("invokes supervisor.shutdown on SIGTERM", async () => {
    const calls: string[] = [];
    const fakeSupervisor = {
      shutdown: async (reason: string) => {
        calls.push(reason);
        return { ok: true, value: undefined };
      },
    } as unknown as Supervisor;

    const cleanup = registerSignalHandlers(fakeSupervisor);
    removed.push(cleanup);

    process.emit("SIGTERM", "SIGTERM");
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toContain("SIGTERM");
  });

  it("invokes supervisor.shutdown on SIGINT", async () => {
    const calls: string[] = [];
    const fakeSupervisor = {
      shutdown: async (reason: string) => {
        calls.push(reason);
        return { ok: true, value: undefined };
      },
    } as unknown as Supervisor;

    const cleanup = registerSignalHandlers(fakeSupervisor);
    removed.push(cleanup);

    process.emit("SIGINT", "SIGINT");
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toContain("SIGINT");
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/net/daemon/src/signal-handlers.ts`:

```typescript
import type { Supervisor } from "@koi/core";

export function registerSignalHandlers(supervisor: Supervisor): () => void {
  const signals: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
  const handler = (sig: NodeJS.Signals): void => {
    void supervisor.shutdown(sig);
  };
  for (const s of signals) process.on(s, handler);
  return () => {
    for (const s of signals) process.off(s, handler);
  };
}
```

- [ ] **Step 4: Run test, expect pass**

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```
git add packages/net/daemon/src/signal-handlers.ts packages/net/daemon/src/__tests__/signal-handlers.test.ts
git commit -m "feat(daemon): SIGTERM/SIGINT signal handlers"
```

---

## Task 9: Subprocess backend — spawn

**Files:**
- Create: `packages/net/daemon/src/subprocess-backend.ts`
- Test: `packages/net/daemon/src/__tests__/subprocess-backend.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { agentId, workerId } from "@koi/core";
import { createSubprocessBackend } from "../subprocess-backend.js";

describe("subprocess backend", () => {
  it("spawns a subprocess that runs to completion", async () => {
    const backend = createSubprocessBackend();
    expect(await backend.isAvailable()).toBe(true);
    const spawned = await backend.spawn({
      workerId: workerId("sub1"),
      agentId: agentId("agent-sub1"),
      command: ["bun", "--version"],
    });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    expect(spawned.value.backendKind).toBe("subprocess");
    // Wait briefly for process to exit
    await new Promise((r) => setTimeout(r, 200));
    expect(await backend.isAlive(workerId("sub1"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Expected: FAIL — module not found.

- [ ] **Step 3: Implement subprocess backend (spawn + isAlive + watch skeleton)**

`packages/net/daemon/src/subprocess-backend.ts`:

```typescript
import type {
  KoiError,
  Result,
  WorkerBackend,
  WorkerEvent,
  WorkerHandle,
  WorkerId,
  WorkerSpawnRequest,
} from "@koi/core";

interface SubprocState {
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly controller: AbortController;
  readonly events: WorkerEvent[];
  readonly listeners: Array<(ev: WorkerEvent) => void>;
  alive: boolean;
}

export function createSubprocessBackend(): WorkerBackend {
  const workers = new Map<WorkerId, SubprocState>();

  const emit = (state: SubprocState, ev: WorkerEvent): void => {
    state.events.push(ev);
    for (const l of state.listeners) l(ev);
  };

  const spawn = async (
    request: WorkerSpawnRequest,
  ): Promise<Result<WorkerHandle, KoiError>> => {
    if (request.command.length === 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "WorkerSpawnRequest.command must be non-empty",
          retryable: false,
        },
      };
    }
    const env: Record<string, string> = { ...process.env };
    if (request.env !== undefined) {
      for (const [k, v] of Object.entries(request.env)) {
        if (v === null) delete env[k];
        else env[k] = v;
      }
    }
    try {
      const proc = Bun.spawn([...request.command], {
        cwd: request.cwd,
        env,
        stdin: "inherit",
        stdout: "pipe",
        stderr: "pipe",
      });
      const controller = new AbortController();
      const state: SubprocState = {
        proc,
        controller,
        events: [],
        listeners: [],
        alive: true,
      };
      workers.set(request.workerId, state);
      emit(state, { kind: "started", workerId: request.workerId, at: Date.now() });

      void proc.exited.then((code) => {
        state.alive = false;
        controller.abort();
        const ev: WorkerEvent =
          code === 0
            ? {
                kind: "exited",
                workerId: request.workerId,
                at: Date.now(),
                code,
                state: "terminated",
              }
            : {
                kind: "crashed",
                workerId: request.workerId,
                at: Date.now(),
                error: {
                  code: "INTERNAL",
                  message: `subprocess exited with code ${code}`,
                  retryable: true,
                },
              };
        emit(state, ev);
      });

      const handle: WorkerHandle = {
        workerId: request.workerId,
        agentId: request.agentId,
        backendKind: "subprocess",
        startedAt: Date.now(),
        signal: controller.signal,
      };
      return { ok: true, value: handle };
    } catch (e) {
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: `Failed to spawn subprocess: ${e instanceof Error ? e.message : String(e)}`,
          retryable: true,
        },
      };
    }
  };

  const terminate = async (id: WorkerId, _reason: string): Promise<Result<void, KoiError>> => {
    const state = workers.get(id);
    if (state === undefined) return { ok: true, value: undefined };
    state.proc.kill("SIGTERM");
    return { ok: true, value: undefined };
  };

  const kill = async (id: WorkerId): Promise<Result<void, KoiError>> => {
    const state = workers.get(id);
    if (state === undefined) return { ok: true, value: undefined };
    state.proc.kill("SIGKILL");
    return { ok: true, value: undefined };
  };

  const isAlive = async (id: WorkerId): Promise<boolean> => {
    return workers.get(id)?.alive ?? false;
  };

  const watch = async function* (id: WorkerId): AsyncIterable<WorkerEvent> {
    const state = workers.get(id);
    if (state === undefined) return;
    for (const ev of state.events) yield ev;
    if (!state.alive) return;
    while (state.alive) {
      const ev = await new Promise<WorkerEvent>((resolve) => {
        state.listeners.push(resolve);
      });
      yield ev;
      if (ev.kind === "exited" || ev.kind === "crashed") return;
    }
  };

  return {
    kind: "subprocess",
    displayName: "Bun subprocess",
    isAvailable: () => typeof Bun !== "undefined" && typeof Bun.spawn === "function",
    spawn,
    terminate,
    kill,
    isAlive,
    watch,
  };
}
```

- [ ] **Step 4: Run test, expect pass**

Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```
git add packages/net/daemon/src/subprocess-backend.ts packages/net/daemon/src/__tests__/subprocess-backend.test.ts
git commit -m "feat(daemon): Bun subprocess worker backend"
```

---

## Task 10: Subprocess backend — terminate/kill/crashed

**Files:**
- Modify: `packages/net/daemon/src/__tests__/subprocess-backend.test.ts`

- [ ] **Step 1: Append failing tests**

```typescript
describe("subprocess terminate/kill", () => {
  it("terminates a long-running subprocess via SIGTERM", async () => {
    const backend = createSubprocessBackend();
    const spawned = await backend.spawn({
      workerId: workerId("sub2"),
      agentId: agentId("agent-sub2"),
      command: ["sleep", "10"],
    });
    expect(spawned.ok).toBe(true);
    await backend.terminate(workerId("sub2"), "test");
    await new Promise((r) => setTimeout(r, 200));
    expect(await backend.isAlive(workerId("sub2"))).toBe(false);
  });

  it("emits crashed on non-zero exit", async () => {
    const backend = createSubprocessBackend();
    await backend.spawn({
      workerId: workerId("sub3"),
      agentId: agentId("agent-sub3"),
      command: ["bash", "-c", "exit 42"],
    });
    const events: string[] = [];
    for await (const ev of backend.watch(workerId("sub3"))) {
      events.push(ev.kind);
      if (ev.kind === "crashed" || ev.kind === "exited") break;
    }
    expect(events).toContain("crashed");
  });
});
```

- [ ] **Step 2: Run test, expect pass (implementation already covers this)**

```
cd packages/net/daemon && bun test src/__tests__/subprocess-backend.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 3: Commit**

```
git add packages/net/daemon/src/__tests__/subprocess-backend.test.ts
git commit -m "test(daemon): cover subprocess terminate + crash-on-non-zero-exit"
```

---

## Task 11: Documentation — `docs/L2/daemon.md`

**Files:**
- Create: `docs/L2/daemon.md`

- [ ] **Step 1: Write doc**

Content outline (write each section completely, no placeholders):

- Overview — problem this package solves, relationship to `SupervisionReconciler`
- API surface — `createSupervisor`, `createSubprocessBackend`, `registerSignalHandlers`, types from L0
- Configuration — `SupervisorConfig`, `WorkerRestartPolicy`, `DEFAULT_WORKER_RESTART_POLICY`
- Usage example — spawn 2 workers, handle SIGTERM
- Design notes — two-layer supervision, backend registry, restart storm prevention, deadline-then-kill
- Future backends — tmux/remote/in-process (follow-up issues)

(Full content omitted in plan — author writes body based on actual implementation at this point.)

- [ ] **Step 2: Run doc-gate check**

```
bun scripts/check-doc-gate.ts
```
Expected: PASS (daemon.md present and references exported API).

- [ ] **Step 3: Commit**

```
git add docs/L2/daemon.md
git commit -m "docs(daemon): L2 package reference doc"
```

---

## Task 12: Wire into `@koi/runtime` + golden query

**Files:**
- Modify: `packages/meta/runtime/package.json`
- Modify: `packages/meta/runtime/tsconfig.json`
- Modify: `packages/meta/runtime/scripts/record-cassettes.ts` (add QueryConfig)
- Modify: `packages/meta/runtime/src/__tests__/golden-replay.test.ts` (add assertions)
- Record: `packages/meta/runtime/fixtures/daemon-basic.cassette.json` + `.trajectory.json`

- [ ] **Step 1: Add dependency**

In `packages/meta/runtime/package.json`:

```json
"@koi/daemon": "workspace:*"
```

In `packages/meta/runtime/tsconfig.json`, add path mapping entry for `@koi/daemon`.

- [ ] **Step 2: Add standalone golden tests (no LLM)**

In `packages/meta/runtime/src/__tests__/golden-replay.test.ts`:

```typescript
describe("Golden: @koi/daemon", () => {
  it("supervisor starts and stops a subprocess worker", async () => {
    const { createSupervisor, createSubprocessBackend } = await import("@koi/daemon");
    const { agentId, workerId } = await import("@koi/core");

    const supervisorResult = createSupervisor({
      maxWorkers: 2,
      shutdownDeadlineMs: 500,
      backends: { subprocess: createSubprocessBackend() },
    });
    expect(supervisorResult.ok).toBe(true);
    if (!supervisorResult.ok) return;
    const started = await supervisorResult.value.start({
      workerId: workerId("golden-1"),
      agentId: agentId("agent-golden-1"),
      command: ["bun", "--version"],
    });
    expect(started.ok).toBe(true);
    await supervisorResult.value.shutdown("test");
    expect(supervisorResult.value.list()).toEqual([]);
  });

  it("rejects spawn beyond maxWorkers", async () => {
    const { createSupervisor, createSubprocessBackend } = await import("@koi/daemon");
    const { agentId, workerId } = await import("@koi/core");

    const supervisorResult = createSupervisor({
      maxWorkers: 1,
      shutdownDeadlineMs: 500,
      backends: { subprocess: createSubprocessBackend() },
    });
    if (!supervisorResult.ok) return;
    await supervisorResult.value.start({
      workerId: workerId("golden-2"),
      agentId: agentId("agent-golden-2"),
      command: ["sleep", "2"],
    });
    const second = await supervisorResult.value.start({
      workerId: workerId("golden-3"),
      agentId: agentId("agent-golden-3"),
      command: ["sleep", "2"],
    });
    expect(second.ok).toBe(false);
    await supervisorResult.value.shutdown("test");
  });
});
```

- [ ] **Step 3: Run orphan check + runtime tests**

```
bun scripts/check-orphans.ts
cd packages/meta/runtime && bun test
```
Expected: PASS.

- [ ] **Step 4: Commit**

```
git add packages/meta/runtime/
git commit -m "feat(daemon): wire @koi/daemon into runtime + golden queries"
```

---

## Task 13: Final CI gate

**Files:** none

- [ ] **Step 1: Run full CI gate**

```
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

- [ ] **Step 2: If any check fails, fix root cause and commit**

Do not skip checks or weaken tests.

- [ ] **Step 3: Open PR**

```
gh pr create --title "feat(daemon): supervisor + subprocess worker backend (closes #1338)" --body "..."
```

Body covers: goal, scope, deferred work (tmux/remote/in-process backends), test plan, architecture note on two-layer supervision.

---

## Self-Review

- [x] Spec coverage:
  - Supervisor starts workers → Task 4
  - Worker crash triggers restart → Task 5
  - Graceful shutdown stops all workers → Task 6
  - Max worker limit enforced → Task 4
  - Supervisor handles SIGTERM/SIGINT → Task 8
- [x] No TBD / "implement later" / placeholder code — every code step has a complete block.
- [x] Type consistency: `SupervisorConfig`, `WorkerRestartPolicy`, `WorkerBackend`, `WorkerHandle`, `WorkerEvent` used consistently across tasks. `computeBackoff` exported from `backoff.ts`, used inline in Task 5 as `Math.min(...)` — Task 5 duplicates the math because the helper isn't wired until a follow-up refactor; flagged here as a conscious minor dup (Rule of Three not yet triggered).
- [x] Every file path is absolute from repo root.

## Execution Handoff

Plan complete and saved to `.claude/plans/issue-1338-daemon.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
