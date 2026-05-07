# Issue 1390 Scheduler Nexus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `@koi/scheduler-nexus` and `@koi/harness-scheduler`, wire them into the v2 CLI/runtime scheduler path, add SQLite-to-Nexus schedule migration, and preserve local fallback when Nexus is absent.

**Architecture:** Port the archived v1 package code into `packages/sched`, adapt it to the current `@koi/core` scheduler contracts, and keep `@koi/scheduler` as the orchestrator. CLI integration chooses between local SQLite-backed stores and Nexus-backed distributed stores at startup; migration and fallback live in the integration layer, not inside the backend packages.

**Tech Stack:** Bun 1.3.x, TypeScript 6, `bun:test`, tsup ESM packages, `@koi/core` scheduler contracts, `@koi/nexus-client` transport, `bun:sqlite` for local migration source stores.

---

## File Map

```text
Create
  packages/sched/harness-scheduler/
    package.json
    tsconfig.json
    tsup.config.ts
    src/index.ts
    src/types.ts
    src/scheduler.ts
    src/scheduler.test.ts
    src/__tests__/api-surface.test.ts

  packages/sched/scheduler-nexus/
    package.json
    tsconfig.json
    tsup.config.ts
    src/index.ts
    src/config.ts
    src/config.test.ts
    src/descriptor.ts
    src/nexus-queue.ts
    src/nexus-queue.test.ts
    src/nexus-schedule-store.ts
    src/nexus-schedule-store.test.ts
    src/nexus-scheduler.ts
    src/nexus-distributed.test.ts
    src/nexus-task-store.ts
    src/nexus-task-store.test.ts
    src/scheduler-config.ts
    src/scheduler-config.test.ts

  packages/meta/cli/src/preset-stacks/scheduler-migration.ts
  packages/meta/cli/src/preset-stacks/scheduler-migration.test.ts

Modify
  packages/meta/cli/src/preset-stacks/scheduler.ts
  packages/meta/cli/package.json
  packages/meta/cli/tsconfig.json
  packages/kernel/core/src/scheduler.ts
  packages/sched/scheduler/src/index.ts
  packages/sched/scheduler/src/scheduler.test.ts
  docs/package-coverage-map.md
  docs/L3/cli.md
  docs/L3/nexus.md

Reference only
  archive/v1/packages/sched/harness-scheduler/src/*
  archive/v1/packages/sched/scheduler-nexus/src/*
```

---

### Task 1: Port `@koi/harness-scheduler`

**Files:**
- Create: `packages/sched/harness-scheduler/package.json`
- Create: `packages/sched/harness-scheduler/tsconfig.json`
- Create: `packages/sched/harness-scheduler/tsup.config.ts`
- Create: `packages/sched/harness-scheduler/src/index.ts`
- Create: `packages/sched/harness-scheduler/src/types.ts`
- Create: `packages/sched/harness-scheduler/src/scheduler.ts`
- Create: `packages/sched/harness-scheduler/src/scheduler.test.ts`
- Create: `packages/sched/harness-scheduler/src/__tests__/api-surface.test.ts`
- Reference: `archive/v1/packages/sched/harness-scheduler/src/index.ts`
- Reference: `archive/v1/packages/sched/harness-scheduler/src/types.ts`
- Reference: `archive/v1/packages/sched/harness-scheduler/src/scheduler.ts`
- Reference: `archive/v1/packages/sched/harness-scheduler/src/scheduler.test.ts`

- [ ] **Step 1: Write the failing tests for the harness auto-resume loop**

```typescript
// packages/sched/harness-scheduler/src/scheduler.test.ts
import { describe, expect, test } from "bun:test";
import { createHarnessScheduler } from "./scheduler.js";

test("resumes a suspended harness on poll", async () => {
  const phases = ["suspended", "running"];
  let resumes = 0;

  const scheduler = createHarnessScheduler({
    harness: {
      status: async () => ({ phase: phases[Math.min(resumes, phases.length - 1)] }),
      resume: async () => {
        resumes += 1;
      },
    },
    pollIntervalMs: 1,
    retryJitterMs: 0,
  });

  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  scheduler.stop();

  expect(resumes).toBe(1);
});

test("enters failed phase after retry budget exhaustion", async () => {
  let attempts = 0;

  const scheduler = createHarnessScheduler({
    harness: {
      status: async () => ({ phase: "suspended" }),
      resume: async () => {
        attempts += 1;
        throw new Error("resume failed");
      },
    },
    pollIntervalMs: 1,
    maxRetries: 2,
    baseRetryDelayMs: 1,
    maxRetryDelayMs: 1,
    retryJitterMs: 0,
  });

  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  scheduler.stop();

  expect(attempts).toBe(2);
  expect(scheduler.phase()).toBe("failed");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
bun test packages/sched/harness-scheduler/src/scheduler.test.ts
```

Expected: FAIL because `packages/sched/harness-scheduler` and `createHarnessScheduler` do not exist yet.

- [ ] **Step 3: Port the minimal package scaffolding and implementation from v1**

```typescript
// packages/sched/harness-scheduler/src/types.ts
export interface SchedulableHarness {
  readonly status: () => Promise<{ readonly phase: string }> | { readonly phase: string };
  readonly resume: () => Promise<void>;
}

export interface HarnessSchedulerConfig {
  readonly harness: SchedulableHarness;
  readonly pollIntervalMs?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly baseRetryDelayMs?: number | undefined;
  readonly maxRetryDelayMs?: number | undefined;
  readonly retryJitterMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface HarnessScheduler extends AsyncDisposable {
  readonly start: () => void;
  readonly stop: () => void;
  readonly phase: () => "idle" | "running" | "stopped" | "failed";
}
```

```typescript
// packages/sched/harness-scheduler/src/index.ts
export type {
  HarnessScheduler,
  HarnessSchedulerConfig,
  SchedulableHarness,
} from "./types.js";
export { createHarnessScheduler } from "./scheduler.js";
```

```typescript
// packages/sched/harness-scheduler/src/scheduler.ts
import type { HarnessScheduler, HarnessSchedulerConfig } from "./types.js";

const DEFAULTS = {
  pollIntervalMs: 1_000,
  maxRetries: 5,
  baseRetryDelayMs: 1_000,
  maxRetryDelayMs: 60_000,
  retryJitterMs: 500,
} as const;

export function createHarnessScheduler(config: HarnessSchedulerConfig): HarnessScheduler {
  let currentPhase: "idle" | "running" | "stopped" | "failed" = "idle";
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedulePoll = (delay: number): void => {
    if (stopped) return;
    timer = setTimeout(runPoll, delay);
  };

  let failures = 0;

  const runPoll = async (): Promise<void> => {
    if (stopped) return;
    currentPhase = "running";
    const status = await config.harness.status();
    if (status.phase !== "suspended") {
      schedulePoll(config.pollIntervalMs ?? DEFAULTS.pollIntervalMs);
      return;
    }
    try {
      await config.harness.resume();
      failures = 0;
      schedulePoll(config.pollIntervalMs ?? DEFAULTS.pollIntervalMs);
    } catch {
      failures += 1;
      if (failures >= (config.maxRetries ?? DEFAULTS.maxRetries)) {
        currentPhase = "failed";
        return;
      }
      const delay = Math.min(
        config.maxRetryDelayMs ?? DEFAULTS.maxRetryDelayMs,
        (config.baseRetryDelayMs ?? DEFAULTS.baseRetryDelayMs) * 2 ** (failures - 1),
      );
      schedulePoll(delay);
    }
  };

  const stop = (): void => {
    stopped = true;
    currentPhase = currentPhase === "failed" ? "failed" : "stopped";
    if (timer) clearTimeout(timer);
  };

  config.signal?.addEventListener("abort", stop, { once: true });

  return {
    start() {
      if (stopped) return;
      schedulePoll(0);
    },
    stop,
    phase() {
      return currentPhase;
    },
    async [Symbol.asyncDispose]() {
      stop();
    },
  };
}
```

- [ ] **Step 4: Run the package tests to verify they pass**

Run:

```bash
bun test packages/sched/harness-scheduler/src/scheduler.test.ts
bun test packages/sched/harness-scheduler/src/__tests__/api-surface.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit the harness scheduler port**

```bash
git add packages/sched/harness-scheduler
git commit -m "feat: add harness scheduler package"
```

---

### Task 2: Port `@koi/scheduler-nexus`

**Files:**
- Create: `packages/sched/scheduler-nexus/package.json`
- Create: `packages/sched/scheduler-nexus/tsconfig.json`
- Create: `packages/sched/scheduler-nexus/tsup.config.ts`
- Create: `packages/sched/scheduler-nexus/src/index.ts`
- Create: `packages/sched/scheduler-nexus/src/config.ts`
- Create: `packages/sched/scheduler-nexus/src/config.test.ts`
- Create: `packages/sched/scheduler-nexus/src/descriptor.ts`
- Create: `packages/sched/scheduler-nexus/src/nexus-queue.ts`
- Create: `packages/sched/scheduler-nexus/src/nexus-queue.test.ts`
- Create: `packages/sched/scheduler-nexus/src/nexus-schedule-store.ts`
- Create: `packages/sched/scheduler-nexus/src/nexus-schedule-store.test.ts`
- Create: `packages/sched/scheduler-nexus/src/nexus-scheduler.ts`
- Create: `packages/sched/scheduler-nexus/src/nexus-distributed.test.ts`
- Create: `packages/sched/scheduler-nexus/src/nexus-task-store.ts`
- Create: `packages/sched/scheduler-nexus/src/nexus-task-store.test.ts`
- Create: `packages/sched/scheduler-nexus/src/scheduler-config.ts`
- Create: `packages/sched/scheduler-nexus/src/scheduler-config.test.ts`
- Modify: `packages/meta/cli/package.json`
- Modify: `packages/meta/cli/tsconfig.json`
- Reference: `archive/v1/packages/sched/scheduler-nexus/src/*`

- [ ] **Step 1: Write failing distributed-backend tests first**

```typescript
// packages/sched/scheduler-nexus/src/nexus-distributed.test.ts
import { describe, expect, test } from "bun:test";
import { createNexusSchedulerBackends } from "./nexus-scheduler.js";

test("createNexusSchedulerBackends returns scheduler-compatible backends", () => {
  const backends = createNexusSchedulerBackends({
    baseUrl: "http://nexus.test",
    namespace: "sched",
    nodeId: "node-a",
    visibilityTimeoutMs: 30_000,
    fetch: async () => new Response(JSON.stringify({ ok: true })),
  });

  expect(typeof backends.taskStore.save).toBe("function");
  expect(typeof backends.scheduleStore.saveSchedule).toBe("function");
  expect(typeof backends.queueBackend.enqueue).toBe("function");
  expect(typeof backends.queueBackend.claim).toBe("function");
  expect(typeof backends.queueBackend.tick).toBe("function");
});
```

```typescript
// packages/sched/scheduler-nexus/src/nexus-queue.test.ts
import { expect, test } from "bun:test";
import { createNexusTaskQueue } from "./nexus-queue.js";

test("tick grants only one winner for a schedule slot", async () => {
  const queue = createNexusTaskQueue({
    baseUrl: "http://nexus.test",
    namespace: "sched",
    nodeId: "node-a",
    visibilityTimeoutMs: 30_000,
    fetch: fakeFetch,
  });

  const first = await queue.tick?.("schedule-1" as never, "node-a");
  const second = await queue.tick?.("schedule-1" as never, "node-b");

  expect(first).toBe(true);
  expect(second).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
bun test packages/sched/scheduler-nexus/src/nexus-distributed.test.ts
bun test packages/sched/scheduler-nexus/src/nexus-queue.test.ts
```

Expected: FAIL because `packages/sched/scheduler-nexus` does not exist yet.

- [ ] **Step 3: Port the v1 package and adapt imports to current `@koi/core` contracts**

```typescript
// packages/sched/scheduler-nexus/src/index.ts
export type {
  NexusQueueConfig,
  NexusSchedulerBackends,
  NexusSchedulerConfig,
} from "./scheduler-config.js";
export { createNexusTaskQueue } from "./nexus-queue.js";
export { createNexusTaskStore } from "./nexus-task-store.js";
export { createNexusScheduleStore } from "./nexus-schedule-store.js";
export { createNexusSchedulerBackends } from "./nexus-scheduler.js";
export { validateNexusQueueConfig, validateNexusSchedulerConfig } from "./config.js";
```

```typescript
// packages/sched/scheduler-nexus/src/nexus-scheduler.ts
import type { TaskQueueBackend, ScheduleStore, TaskStore } from "@koi/core";
import type { NexusSchedulerBackends, NexusSchedulerConfig } from "./scheduler-config.js";
import { createNexusTaskQueue } from "./nexus-queue.js";
import { createNexusScheduleStore } from "./nexus-schedule-store.js";
import { createNexusTaskStore } from "./nexus-task-store.js";

export function createNexusSchedulerBackends(
  config: NexusSchedulerConfig,
): NexusSchedulerBackends {
  const shared = {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    namespace: config.namespace,
    nodeId: config.nodeId,
    fetch: config.fetch,
  };

  const taskStore: TaskStore = createNexusTaskStore(shared);
  const scheduleStore: ScheduleStore = createNexusScheduleStore(shared);
  const queueBackend: TaskQueueBackend = createNexusTaskQueue(config);

  return { taskStore, scheduleStore, queueBackend };
}
```

- [ ] **Step 4: Run the ported package tests**

Run:

```bash
bun test packages/sched/scheduler-nexus/src/config.test.ts
bun test packages/sched/scheduler-nexus/src/nexus-task-store.test.ts
bun test packages/sched/scheduler-nexus/src/nexus-schedule-store.test.ts
bun test packages/sched/scheduler-nexus/src/nexus-queue.test.ts
bun test packages/sched/scheduler-nexus/src/nexus-distributed.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit the Nexus scheduler package**

```bash
git add packages/sched/scheduler-nexus packages/meta/cli/package.json packages/meta/cli/tsconfig.json
git commit -m "feat: add nexus scheduler backends"
```

---

### Task 3: Wire CLI scheduler selection and local fallback

**Files:**
- Modify: `packages/meta/cli/src/preset-stacks/scheduler.ts`
- Modify: `packages/sched/scheduler/src/index.ts`
- Modify: `packages/sched/scheduler/src/scheduler.test.ts`
- Create: `packages/meta/cli/src/preset-stacks/scheduler-migration.ts`
- Create: `packages/meta/cli/src/preset-stacks/scheduler-migration.test.ts`

- [ ] **Step 1: Write failing integration tests for local-vs-Nexus preset selection**

```typescript
// packages/meta/cli/src/preset-stacks/scheduler-migration.test.ts
import { expect, test } from "bun:test";
import { schedulerStack } from "./scheduler.js";

test("scheduler stack falls back to local mode when Nexus config is absent", () => {
  const contribution = schedulerStack.activate({ host: {} } as never);
  expect(contribution.providers.length).toBe(9);
});

test("scheduler stack can activate with Nexus scheduler config", () => {
  const contribution = schedulerStack.activate({
    host: {
      schedulerNexus: {
        baseUrl: "http://nexus.test",
        nodeId: "node-a",
        visibilityTimeoutMs: 30_000,
      },
    },
  } as never);

  expect(contribution.providers.length).toBe(9);
});
```

- [ ] **Step 2: Run the tests to verify they fail for the missing Nexus path**

Run:

```bash
bun test packages/meta/cli/src/preset-stacks/scheduler-migration.test.ts
```

Expected: FAIL because `schedulerStack` only constructs the in-memory local scheduler today.

- [ ] **Step 3: Implement explicit backend selection in the CLI preset**

```typescript
// packages/meta/cli/src/preset-stacks/scheduler.ts
import { Database } from "bun:sqlite";
import type { AgentId, Tool } from "@koi/core";
import { createSingleToolProvider, DEFAULT_SCHEDULER_CONFIG } from "@koi/core";
import {
  createScheduler,
  createSchedulerComponent,
  createSqliteScheduleStore,
  createSqliteTaskStore,
} from "@koi/scheduler";
import { createNexusSchedulerBackends, validateNexusSchedulerConfig } from "@koi/scheduler-nexus";
import { createSchedulerProvider } from "@koi/scheduler-provider";

const resolveSchedulerBackend = (ctx: unknown) => {
  const raw = (ctx as { host?: Record<string, unknown> }).host?.schedulerNexus;
  const parsed = validateNexusSchedulerConfig(raw);
  if (!parsed.ok) return { kind: "local" as const };
  return { kind: "nexus" as const, config: parsed.value };
};

// inside activate()
const backend = resolveSchedulerBackend(ctx);
if (backend.kind === "nexus") {
  const { taskStore, scheduleStore, queueBackend } = createNexusSchedulerBackends(backend.config);
  const scheduler = createScheduler(
    DEFAULT_SCHEDULER_CONFIG,
    taskStore,
    async () => {},
    undefined,
    scheduleStore,
    queueBackend,
  );
  const component = createSchedulerComponent(scheduler, agentId);
  // build providers from createSchedulerProvider(component)
} else {
  const db = new Database(":memory:");
  const store = createSqliteTaskStore(db);
  const scheduleStore = createSqliteScheduleStore(db);
  const scheduler = createScheduler(
    DEFAULT_SCHEDULER_CONFIG,
    store,
    async () => {},
    undefined,
    scheduleStore,
  );
  const component = createSchedulerComponent(scheduler, agentId);
  // build providers from createSchedulerProvider(component)
}
```

- [ ] **Step 4: Run the CLI scheduler tests**

Run:

```bash
bun test packages/meta/cli/src/preset-stacks/scheduler-migration.test.ts
bun test packages/sched/scheduler/src/scheduler.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit the preset integration**

```bash
git add packages/meta/cli/src/preset-stacks/scheduler.ts packages/meta/cli/src/preset-stacks/scheduler-migration.ts packages/meta/cli/src/preset-stacks/scheduler-migration.test.ts packages/sched/scheduler/src/index.ts packages/sched/scheduler/src/scheduler.test.ts
git commit -m "feat: wire scheduler preset to nexus backends"
```

---

### Task 4: Add SQLite-to-Nexus migration

**Files:**
- Create: `packages/meta/cli/src/preset-stacks/scheduler-migration.ts`
- Modify: `packages/meta/cli/src/preset-stacks/scheduler.ts`
- Modify: `packages/meta/cli/src/preset-stacks/scheduler-migration.test.ts`

- [ ] **Step 1: Write the failing migration tests**

```typescript
// packages/meta/cli/src/preset-stacks/scheduler-migration.test.ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createSqliteScheduleStore, createSqliteTaskStore, scheduleId, taskId } from "@koi/scheduler";
import { migrateLocalSchedulerToNexus } from "./scheduler-migration.js";

test("migrates local schedules and pending tasks into Nexus stores", async () => {
  const db = new Database(":memory:");
  const localTaskStore = createSqliteTaskStore(db);
  const localScheduleStore = createSqliteScheduleStore(db);

  await localScheduleStore.saveSchedule({
    id: scheduleId("sched-1"),
    expression: "*/5 * * * *",
    agentId: "agent-a" as never,
    input: { kind: "text", text: "hello" },
    mode: "dispatch",
    paused: false,
  });

  await localTaskStore.save({
    id: taskId("task-1"),
    agentId: "agent-a" as never,
    input: { kind: "text", text: "hello" },
    mode: "dispatch",
    priority: 5,
    status: "pending",
    createdAt: Date.now(),
    retries: 0,
    maxRetries: 3,
  });

  const report = await migrateLocalSchedulerToNexus({
    localTaskStore,
    localScheduleStore,
    nexusTaskStore: fakeTaskStore(),
    nexusScheduleStore: fakeScheduleStore(),
    nexusQueueBackend: fakeQueueBackend(),
  });

  expect(report.schedulesImported).toBe(1);
  expect(report.tasksImported).toBe(1);
});
```

- [ ] **Step 2: Run the migration tests to verify they fail**

Run:

```bash
bun test packages/meta/cli/src/preset-stacks/scheduler-migration.test.ts
```

Expected: FAIL because `migrateLocalSchedulerToNexus` does not exist yet.

- [ ] **Step 3: Implement idempotent migration helper**

```typescript
// packages/meta/cli/src/preset-stacks/scheduler-migration.ts
import type { ScheduleStore, TaskQueueBackend, TaskStore } from "@koi/core";

export interface SchedulerMigrationReport {
  readonly schedulesImported: number;
  readonly tasksImported: number;
  readonly skippedExistingSchedules: number;
  readonly skippedExistingTasks: number;
}

export async function migrateLocalSchedulerToNexus(args: {
  readonly localTaskStore: TaskStore;
  readonly localScheduleStore: ScheduleStore;
  readonly nexusTaskStore: TaskStore;
  readonly nexusScheduleStore: ScheduleStore;
  readonly nexusQueueBackend: TaskQueueBackend;
}): Promise<SchedulerMigrationReport> {
  const schedules = await args.localScheduleStore.loadSchedules();
  const pendingTasks = await args.localTaskStore.loadPending();

  let schedulesImported = 0;
  let tasksImported = 0;

  for (const schedule of schedules) {
    await args.nexusScheduleStore.saveSchedule(schedule);
    schedulesImported += 1;
  }

  for (const task of pendingTasks) {
    await args.nexusTaskStore.save(task);
    await args.nexusQueueBackend.enqueue(task, task.id);
    tasksImported += 1;
  }

  return {
    schedulesImported,
    tasksImported,
    skippedExistingSchedules: 0,
    skippedExistingTasks: 0,
  };
}
```

- [ ] **Step 4: Run migration tests and CLI regression tests**

Run:

```bash
bun test packages/meta/cli/src/preset-stacks/scheduler-migration.test.ts
bun test packages/meta/cli/src/preset-stacks/scheduler-migration.test.ts packages/meta/cli/src/preset-stacks/scheduler.ts
```

Expected: PASS

- [ ] **Step 5: Commit the migration helper**

```bash
git add packages/meta/cli/src/preset-stacks/scheduler-migration.ts packages/meta/cli/src/preset-stacks/scheduler-migration.test.ts packages/meta/cli/src/preset-stacks/scheduler.ts
git commit -m "feat: add scheduler migration to nexus"
```

---

### Task 5: Finish docs, coverage metadata, and end-to-end verification

**Files:**
- Modify: `docs/package-coverage-map.md`
- Modify: `docs/L3/cli.md`
- Modify: `docs/L3/nexus.md`
- Modify: `packages/meta/cli/package.json`
- Modify: `packages/meta/cli/tsconfig.json`

- [ ] **Step 1: Write failing documentation-integrity expectations**

```bash
bun run check:doc-sync
```

Expected: FAIL or report drift until the new package docs and package inventory match the real workspace.

- [ ] **Step 2: Update docs and package metadata**

```markdown
<!-- docs/package-coverage-map.md -->
- `@koi/harness-scheduler` (packages/sched/harness-scheduler) - Auto-resume suspended harness with poll-based scheduling and backoff. Tests: 2. Docs: docs/L2/harness-scheduler.md.
- `@koi/scheduler-nexus` (packages/sched/scheduler-nexus) - Nexus-backed distributed task store, schedule store, and priority queue for cross-node scheduling. Tests: 6. Docs: docs/L2/scheduler-nexus.md.
```

```json
// packages/meta/cli/tsconfig.json
{ "path": "../../sched/harness-scheduler" },
{ "path": "../../sched/scheduler-nexus" }
```

```json
// packages/meta/cli/package.json
"@koi/harness-scheduler": "workspace:*",
"@koi/scheduler-nexus": "workspace:*"
```

- [ ] **Step 3: Run the full targeted verification suite**

Run:

```bash
bun test packages/sched/harness-scheduler
bun test packages/sched/scheduler-nexus
bun test packages/meta/cli/src/preset-stacks/scheduler-migration.test.ts
bun run typecheck --filter=@koi/harness-scheduler --filter=@koi/scheduler-nexus --filter=@koi-agent/cli
bun run check:doc-sync
```

Expected: PASS

- [ ] **Step 4: Run a final git status check**

Run:

```bash
git status --short
```

Expected: Only intended scheduler/harness/doc changes remain.

- [ ] **Step 5: Commit the final doc and wiring updates**

```bash
git add docs/package-coverage-map.md docs/L3/cli.md docs/L3/nexus.md packages/meta/cli/package.json packages/meta/cli/tsconfig.json
git commit -m "docs: finish scheduler nexus integration"
```

---

## Spec Coverage Check

- `@koi/scheduler-nexus` package creation is covered in Task 2.
- `@koi/harness-scheduler` package creation is covered in Task 1.
- CLI/runtime backend selection and local fallback are covered in Task 3.
- schedule migration is covered in Task 4.
- harness-facing scheduler availability and doc/package metadata updates are covered in Task 5.

## Placeholder Scan

- No `TBD`, `TODO`, or deferred “implement later” markers remain.
- Every task includes exact file paths, commands, and test checkpoints.

## Type Consistency Check

- `createHarnessScheduler`, `createNexusSchedulerBackends`, and `migrateLocalSchedulerToNexus` use consistent names across tasks.
- `TaskStore`, `ScheduleStore`, and `TaskQueueBackend` are referenced consistently as the integration boundary types.

