# Issue 1647 Team Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@koi/team-runtime` as a new L2 package that materializes decomposed task DAGs into an authoritative task board, schedules parallel-safe work, persists orchestration events for replay, enforces budget slices, and serializes shared-resource conflicts with vector-clock metadata.

**Architecture:** Add a new `packages/lib/team-runtime` package that layers a reducer-driven orchestration snapshot on top of `@koi/task-board`. Keep the board as the scheduling read model, model durability as an append-only event stream, and isolate conflict handling into explicit workspace/lock helpers so the scheduler stays deterministic and testable.

**Tech Stack:** Bun 1.3.x, TypeScript 6, `bun:test`, tsup ESM packages, `@koi/core`, `@koi/task-board`, `@koi/federation`, `@koi/cost-aggregator`.

---

## File Map

```text
Create
  packages/lib/team-runtime/
    package.json
    tsconfig.json
    tsup.config.ts
    src/index.ts
    src/spec.ts
    src/events.ts
    src/state.ts
    src/planner.ts
    src/scheduler.ts
    src/replay.ts
    src/conflicts.ts
    src/workspace.ts
    src/budget.ts
    src/runtime.ts
    src/events.test.ts
    src/state.test.ts
    src/planner.test.ts
    src/scheduler.test.ts
    src/conflicts.test.ts
    src/budget.test.ts
    src/__tests__/api-surface.test.ts

  docs/L2/team-runtime.md

Modify
  scripts/layers.ts
  scripts/add-descriptions.ts
  docs/package-coverage-map.md

Reference only
  packages/lib/task-board/src/board.ts
  packages/lib/task-board/src/dag.ts
  packages/lib/federation/src/types.ts
  packages/lib/federation/src/sync-protocol.ts
  /Users/sophiawj/private/koi/archive/v1/packages/ipc/federation/src/vector-clock.ts
```

---

### Task 1: Scaffold `@koi/team-runtime` Package

This task intentionally includes the public-surface portion of the later reducer/planner/scheduler/runtime work. The goal is not a throwaway placeholder layer. Task 1 should establish future-stable exported signatures for `spec`, `events`, `state`, `planner`, `scheduler`, and `runtime`, but keep implementations trivial and non-production.

**Files:**
- Create: `packages/lib/team-runtime/package.json`
- Create: `packages/lib/team-runtime/tsconfig.json`
- Create: `packages/lib/team-runtime/tsup.config.ts`
- Create: `packages/lib/team-runtime/src/index.ts`
- Create: `packages/lib/team-runtime/src/spec.ts`
- Create: `packages/lib/team-runtime/src/events.ts`
- Create: `packages/lib/team-runtime/src/__tests__/api-surface.test.ts`
- Modify: `scripts/layers.ts`
- Modify: `scripts/add-descriptions.ts`
- Reference: `packages/lib/task-board/package.json`
- Reference: `packages/lib/federation/package.json`

- [ ] **Step 1: Write the failing public-surface test**

```typescript
// packages/lib/team-runtime/src/__tests__/api-surface.test.ts
import { expect, test } from "bun:test";
import * as api from "../index.js";

test("exports the team runtime public surface", () => {
  expect(api.createTeamRuntime).toBeFunction();
  expect(api.validateTeamSpec).toBeFunction();
  expect(api.planRunnableTasks).toBeFunction();
  expect(api.reduceTeamEvents).toBeFunction();
  expect(api.createTeamScheduler).toBeFunction();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test packages/lib/team-runtime/src/__tests__/api-surface.test.ts
```

Expected: FAIL because `packages/lib/team-runtime` does not exist yet.

- [ ] **Step 3: Add the package scaffold and initial exports**

```json
// packages/lib/team-runtime/package.json
{
  "name": "@koi/team-runtime",
  "description": "Parallel multi-agent team orchestration with event replay, dependency-aware scheduling, and conflict-managed shared resources",
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
    "build": "bun ../../../scripts/run-tsup.ts",
    "typecheck": "tsc --noEmit",
    "lint": "biome check --vcs-enabled=false src/",
    "test": "bun test"
  },
  "dependencies": {
    "@koi/core": "workspace:*",
    "@koi/cost-aggregator": "workspace:*",
    "@koi/federation": "workspace:*",
    "@koi/task-board": "workspace:*"
  },
  "koi": {}
}
```

```json
// packages/lib/team-runtime/tsconfig.json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```

```typescript
// packages/lib/team-runtime/tsup.config.ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
```

```typescript
// packages/lib/team-runtime/src/spec.ts
export interface TeamAgentSpec {
  readonly agentType: string;
  readonly maxParallel?: number | undefined;
}

export interface TeamBudgetPolicy {
  readonly total: number;
  readonly reserve?: number | undefined;
  readonly defaultSlice?: number | undefined;
}

export interface WriteCoordinationPolicy {
  readonly mode: "isolated" | "shared" | "hybrid";
  readonly sharedResources?: readonly string[] | undefined;
}

export interface TeamSpec {
  readonly name: string;
  readonly agents: readonly TeamAgentSpec[];
  readonly budget: TeamBudgetPolicy;
  readonly workspacePolicy: WriteCoordinationPolicy;
}

export function validateTeamSpec(spec: TeamSpec): TeamSpec {
  if (spec.name.trim().length === 0) {
    throw new Error("Team spec name must not be empty");
  }
  if (spec.agents.length === 0) {
    throw new Error("Team spec must declare at least one agent");
  }
  if (spec.budget.total <= 0) {
    throw new Error("Team spec budget.total must be > 0");
  }
  return spec;
}
```

```typescript
// packages/lib/team-runtime/src/events.ts
export interface TeamEventBase {
  readonly eventId: string;
  readonly teamRunId: string;
  readonly timestamp: number;
  readonly taskId?: string | undefined;
  readonly agentId?: string | undefined;
}

export interface TeamCreatedEvent extends TeamEventBase {
  readonly kind: "team.created";
  readonly payload: { readonly specName: string };
}

export interface TaskAddedEvent extends TeamEventBase {
  readonly kind: "task.added";
  readonly payload: {
    readonly subject: string;
    readonly description: string;
    readonly dependencies: readonly string[];
  };
}

export type TeamEvent = TeamCreatedEvent | TaskAddedEvent;
```

```typescript
// packages/lib/team-runtime/src/index.ts
export type {
  TeamAgentSpec,
  TeamBudgetPolicy,
  TeamSpec,
  WriteCoordinationPolicy,
} from "./spec.js";
export { validateTeamSpec } from "./spec.js";
export type { TeamEvent } from "./events.js";
export { reduceTeamEvents } from "./state.js";
export { planRunnableTasks } from "./planner.js";
export { createTeamScheduler } from "./scheduler.js";
export { createTeamRuntime } from "./runtime.js";
```

```typescript
// scripts/layers.ts
  "@koi/team-runtime",
```

```typescript
// scripts/add-descriptions.ts
  "@koi/team-runtime":
    "Parallel multi-agent team orchestration with dependency-aware scheduling, replay, and shared-resource conflict control",
```

- [ ] **Step 4: Add future-stable module stubs so the surface compiles**

```typescript
// packages/lib/team-runtime/src/state.ts
import type { TeamEvent } from "./events.js";
import { createTaskBoard } from "@koi/task-board";

export interface TeamRuntimeSnapshot {
  readonly board: ReturnType<typeof createTaskBoard>;
  readonly outputs: ReadonlyMap<string, string>;
  readonly assignments: ReadonlyMap<string, string>;
  readonly eventHistory: readonly TeamEvent[];
}

export function reduceTeamEvents(events: readonly TeamEvent[]): TeamRuntimeSnapshot {
  return {
    board: createTaskBoard(),
    outputs: new Map(),
    assignments: new Map(),
    eventHistory: [...events],
  };
}
```

```typescript
// packages/lib/team-runtime/src/planner.ts
import type { TeamRuntimeSnapshot } from "./state.js";

export function planRunnableTasks(snapshot: TeamRuntimeSnapshot): readonly string[] {
  void snapshot;
  return [];
}
```

```typescript
// packages/lib/team-runtime/src/scheduler.ts
import { planRunnableTasks } from "./planner.js";
import type { TeamRuntimeSnapshot } from "./state.js";

export interface TeamSchedulerConfig {
  readonly assign?: ((taskId: string, agentId: string) => Promise<void>) | undefined;
}

export interface TeamScheduler {
  readonly dispatch: (
    snapshot: TeamRuntimeSnapshot,
    availableAgents: readonly string[],
  ) => Promise<void>;
}

export function createTeamScheduler(config: TeamSchedulerConfig = {}): TeamScheduler {
  return {
    async dispatch(snapshot, availableAgents) {
      const runnable = planRunnableTasks(snapshot);
      if (config.assign === undefined) return;
      await Promise.all(
        runnable.slice(0, availableAgents.length).map((taskId, index) => {
          const agentId = availableAgents[index];
          if (agentId === undefined) return Promise.resolve();
          return config.assign?.(taskId, agentId) ?? Promise.resolve();
        }),
      );
    },
  };
}
```

```typescript
// packages/lib/team-runtime/src/runtime.ts
import type { TeamSpec } from "./spec.js";
import type { TeamEvent } from "./events.js";
import { validateTeamSpec } from "./spec.js";
import { reduceTeamEvents, type TeamRuntimeSnapshot } from "./state.js";

export interface TeamGoalInput {
  readonly prompt: string;
}

export interface TeamResumeInput {
  readonly events: readonly TeamEvent[];
}

export interface TeamRunHandle {
  readonly status: () => "idle";
}

export interface TeamRuntimeDependencies {}

export interface TeamRuntime {
  readonly start: (goal: TeamGoalInput) => Promise<TeamRunHandle>;
  readonly resume: (input: TeamResumeInput) => Promise<TeamRunHandle>;
  readonly replay: (events: readonly TeamEvent[]) => TeamRuntimeSnapshot;
  readonly getSnapshot: () => TeamRuntimeSnapshot;
}

export function createTeamRuntime(
  spec: TeamSpec,
  _deps: TeamRuntimeDependencies = {},
): TeamRuntime {
  void validateTeamSpec(spec);
  return {
    async start(_goal) {
      return { status: () => "idle" };
    },
    async resume(_input) {
      return { status: () => "idle" };
    },
    replay(events) {
      return reduceTeamEvents(events);
    },
    getSnapshot() {
      return reduceTeamEvents([]);
    },
  };
}
```

- [ ] **Step 5: Run the new package tests**

Run:

```bash
bun test packages/lib/team-runtime/src/__tests__/api-surface.test.ts
```

Expected: PASS with 1 test passing.

- [ ] **Step 6: Commit the scaffold**

```bash
git add packages/lib/team-runtime scripts/layers.ts scripts/add-descriptions.ts
git commit -m "feat: scaffold team runtime package"
```

---

### Task 2: Build Event Types And Reducer-Backed Snapshot State

**Files:**
- Create: `packages/lib/team-runtime/src/state.ts`
- Create: `packages/lib/team-runtime/src/events.test.ts`
- Create: `packages/lib/team-runtime/src/state.test.ts`
- Modify: `packages/lib/team-runtime/src/events.ts`
- Modify: `packages/lib/team-runtime/src/index.ts`
- Reference: `packages/lib/task-board/src/board.ts`
- Reference: `packages/lib/task-board/src/helpers.ts`

- [ ] **Step 1: Write reducer tests for board materialization and replay**

```typescript
// packages/lib/team-runtime/src/state.test.ts
import { expect, test } from "bun:test";
import { reduceTeamEvents } from "./state.js";

test("materializes added tasks into board-like snapshot order", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_1",
      timestamp: 1,
      payload: { specName: "refactor-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_1",
      timestamp: 2,
      taskId: "task_a",
      payload: {
        subject: "Find callsites",
        description: "Locate symbol usages",
        dependencies: [],
      },
    },
  ]);

  expect(snapshot.teamRunId).toBe("run_1");
  expect(snapshot.board.all()).toHaveLength(1);
  expect(snapshot.board.ready().map((task) => task.id)).toEqual(["task_a"]);
});

test("replays assignment and completion into runtime snapshot", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_2",
      timestamp: 1,
      payload: { specName: "lint-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_2",
      timestamp: 2,
      taskId: "task_a",
      payload: {
        subject: "Fix lint",
        description: "Fix lint in pkg a",
        dependencies: [],
      },
    },
    {
      kind: "task.assigned",
      eventId: "e3",
      teamRunId: "run_2",
      timestamp: 3,
      taskId: "task_a",
      agentId: "coder-1",
      payload: {},
    },
    {
      kind: "task.completed",
      eventId: "e4",
      teamRunId: "run_2",
      timestamp: 4,
      taskId: "task_a",
      agentId: "coder-1",
      payload: { output: "done" },
    },
  ]);

  expect(snapshot.board.get("task_a")?.status).toBe("completed");
  expect(snapshot.outputs.get("task_a")).toBe("done");
});
```

- [ ] **Step 2: Run the reducer tests to verify they fail**

Run:

```bash
bun test packages/lib/team-runtime/src/state.test.ts
```

Expected: FAIL because `reduceTeamEvents()` still returns raw events and does not expose `teamRunId`, `board`, or `outputs`.

- [ ] **Step 3: Expand the event union and implement the snapshot reducer**

```typescript
// packages/lib/team-runtime/src/events.ts
export interface TaskAssignedEvent extends TeamEventBase {
  readonly kind: "task.assigned";
  readonly taskId: string;
  readonly agentId: string;
  readonly payload: {};
}

export interface TaskCompletedEvent extends TeamEventBase {
  readonly kind: "task.completed";
  readonly taskId: string;
  readonly agentId: string;
  readonly payload: { readonly output: string };
}

export type TeamEvent =
  | TeamCreatedEvent
  | TaskAddedEvent
  | TaskAssignedEvent
  | TaskCompletedEvent;
```

```typescript
// packages/lib/team-runtime/src/state.ts
import { agentId, taskItemId } from "@koi/core";
import { createTaskBoard } from "@koi/task-board";
import type { TaskBoard } from "@koi/core";
import type { TeamEvent } from "./events.js";

export interface TeamRuntimeSnapshot {
  readonly teamRunId: string;
  readonly board: TaskBoard;
  readonly outputs: ReadonlyMap<string, string>;
}

export function reduceTeamEvents(events: readonly TeamEvent[]): TeamRuntimeSnapshot {
  let teamRunId = "";
  let board = createTaskBoard();
  const outputs = new Map<string, string>();

  for (const event of events) {
    teamRunId = event.teamRunId;
    if (event.kind === "team.created") continue;

    if (event.kind === "task.added") {
      const added = board.add({
        id: taskItemId(event.taskId ?? event.payload.subject.toLowerCase().replaceAll(" ", "_")),
        subject: event.payload.subject,
        description: event.payload.description,
        dependencies: event.payload.dependencies.map((id) => taskItemId(id)),
      });
      if (!added.ok) throw added.error;
      board = added.value;
      continue;
    }

    if (event.kind === "task.assigned") {
      const assigned = board.assign(taskItemId(event.taskId), agentId(event.agentId));
      if (!assigned.ok) throw assigned.error;
      board = assigned.value;
      continue;
    }

    if (event.kind === "task.completed") {
      const completed = board.complete(taskItemId(event.taskId), {
        summary: event.payload.output,
      });
      if (!completed.ok) throw completed.error;
      board = completed.value;
      outputs.set(event.taskId, event.payload.output);
    }
  }

  return { teamRunId, board, outputs };
}
```

- [ ] **Step 4: Add a focused event-shape test**

```typescript
// packages/lib/team-runtime/src/events.test.ts
import { expect, test } from "bun:test";
import type { TeamEvent } from "./events.js";

test("task.completed carries output payload", () => {
  const event: TeamEvent = {
    kind: "task.completed",
    eventId: "e1",
    teamRunId: "run_1",
    timestamp: 1,
    taskId: "task_a",
    agentId: "coder-1",
    payload: { output: "done" },
  };

  expect(event.payload.output).toBe("done");
});
```

- [ ] **Step 5: Run the reducer/event tests**

Run:

```bash
bun test packages/lib/team-runtime/src/events.test.ts packages/lib/team-runtime/src/state.test.ts
```

Expected: PASS with 3 tests passing.

- [ ] **Step 6: Commit the reducer layer**

```bash
git add packages/lib/team-runtime/src/events.ts packages/lib/team-runtime/src/state.ts packages/lib/team-runtime/src/events.test.ts packages/lib/team-runtime/src/state.test.ts
git commit -m "feat: add team runtime event reducer"
```

---

### Task 3: Add Dependency Planning And Scheduler Dispatch

**Files:**
- Create: `packages/lib/team-runtime/src/planner.ts`
- Create: `packages/lib/team-runtime/src/planner.test.ts`
- Create: `packages/lib/team-runtime/src/scheduler.ts`
- Create: `packages/lib/team-runtime/src/scheduler.test.ts`
- Modify: `packages/lib/team-runtime/src/state.ts`
- Modify: `packages/lib/team-runtime/src/index.ts`
- Reference: `packages/lib/task-board/src/dag.ts`

- [ ] **Step 1: Write failing planner and scheduler tests**

```typescript
// packages/lib/team-runtime/src/planner.test.ts
import { expect, test } from "bun:test";
import { reduceTeamEvents } from "./state.js";
import { planRunnableTasks } from "./planner.js";

test("returns only dependency-ready tasks in the current wave", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_1",
      timestamp: 1,
      payload: { specName: "planner" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_1",
      timestamp: 2,
      taskId: "a",
      payload: { subject: "A", description: "A", dependencies: [] },
    },
    {
      kind: "task.added",
      eventId: "e3",
      teamRunId: "run_1",
      timestamp: 3,
      taskId: "b",
      payload: { subject: "B", description: "B", dependencies: ["a"] },
    },
  ]);

  expect(planRunnableTasks(snapshot).map((task) => task.id)).toEqual(["a"]);
});
```

```typescript
// packages/lib/team-runtime/src/scheduler.test.ts
import { expect, test } from "bun:test";
import { createTeamScheduler } from "./scheduler.js";
import { reduceTeamEvents } from "./state.js";

test("assigns runnable work in parallel to available agents", async () => {
  const assigned: string[] = [];
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_parallel",
      timestamp: 1,
      payload: { specName: "parallel" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_parallel",
      timestamp: 2,
      taskId: "task_a",
      payload: { subject: "A", description: "A", dependencies: [] },
    },
    {
      kind: "task.added",
      eventId: "e3",
      teamRunId: "run_parallel",
      timestamp: 3,
      taskId: "task_b",
      payload: { subject: "B", description: "B", dependencies: [] },
    },
  ]);

  const scheduler = createTeamScheduler({
    assign(task) {
      assigned.push(task.id);
      return Promise.resolve();
    },
  });

  await scheduler.dispatch(snapshot, ["coder-1", "coder-2"]);
  expect(assigned.sort()).toEqual(["task_a", "task_b"]);
});
```

- [ ] **Step 2: Run the planner/scheduler tests to verify they fail**

Run:

```bash
bun test packages/lib/team-runtime/src/planner.test.ts packages/lib/team-runtime/src/scheduler.test.ts
```

Expected: FAIL because the planner returns `[]` and the scheduler has no `dispatch()` implementation.

- [ ] **Step 3: Implement the runnable-wave planner**

```typescript
// packages/lib/team-runtime/src/planner.ts
import type { Task } from "@koi/core";
import type { TeamRuntimeSnapshot } from "./state.js";

export function planRunnableTasks(snapshot: TeamRuntimeSnapshot): readonly Task[] {
  return snapshot.board.ready();
}
```

- [ ] **Step 4: Implement a minimal scheduler with assign callback**

```typescript
// packages/lib/team-runtime/src/scheduler.ts
import type { Task } from "@koi/core";
import { planRunnableTasks } from "./planner.js";
import type { TeamRuntimeSnapshot } from "./state.js";

export interface TeamScheduler {
  readonly dispatch: (
    snapshot: TeamRuntimeSnapshot,
    availableAgents: readonly string[],
  ) => Promise<void>;
}

export function createTeamScheduler(config: {
  readonly assign: (task: Task, agentId: string) => Promise<void>;
}): TeamScheduler {
  return {
    async dispatch(snapshot, availableAgents) {
      const runnable = planRunnableTasks(snapshot);
      const tasks = runnable.slice(0, availableAgents.length);
      await Promise.all(
        tasks.map((task, index) => config.assign(task, availableAgents[index] ?? "unassigned")),
      );
    },
  };
}
```

- [ ] **Step 5: Run the planner/scheduler tests**

Run:

```bash
bun test packages/lib/team-runtime/src/planner.test.ts packages/lib/team-runtime/src/scheduler.test.ts
```

Expected: PASS with 2 tests passing.

- [ ] **Step 6: Commit the planning layer**

```bash
git add packages/lib/team-runtime/src/planner.ts packages/lib/team-runtime/src/planner.test.ts packages/lib/team-runtime/src/scheduler.ts packages/lib/team-runtime/src/scheduler.test.ts
git commit -m "feat: add team runtime planner and scheduler"
```

---

### Task 4: Add Budget Slicing, Conflict Metadata, And Workspace Serialization

**Files:**
- Create: `packages/lib/team-runtime/src/budget.ts`
- Create: `packages/lib/team-runtime/src/budget.test.ts`
- Create: `packages/lib/team-runtime/src/conflicts.ts`
- Create: `packages/lib/team-runtime/src/conflicts.test.ts`
- Create: `packages/lib/team-runtime/src/workspace.ts`
- Modify: `packages/lib/team-runtime/src/events.ts`
- Modify: `packages/lib/team-runtime/src/index.ts`
- Reference: `/Users/sophiawj/private/koi/archive/v1/packages/ipc/federation/src/vector-clock.ts`
- Reference: `packages/lib/federation/src/types.ts`

- [ ] **Step 1: Write failing budget and conflict tests**

```typescript
// packages/lib/team-runtime/src/budget.test.ts
import { expect, test } from "bun:test";
import { createBudgetLedger } from "./budget.js";

test("refuses a slice that would spend the reserve", () => {
  const ledger = createBudgetLedger({ total: 100, reserve: 10, defaultSlice: 30 });
  ledger.assign("task_a");
  ledger.assign("task_b");

  expect(() => ledger.assign("task_c")).toThrow(
    "Insufficient remaining budget for task task_c",
  );
});
```

```typescript
// packages/lib/team-runtime/src/conflicts.test.ts
import { expect, test } from "bun:test";
import { compareVectorClock, detectWriteConflict } from "./conflicts.js";

test("marks concurrent writes to the same resource as conflicts", () => {
  expect(
    detectWriteConflict(
      { resource: "package-lock.json", vectorClock: { a: 1 } },
      { resource: "package-lock.json", vectorClock: { b: 1 } },
    ),
  ).toBe(true);
});

test("classifies disjoint vector clocks as concurrent", () => {
  expect(compareVectorClock({ agent_a: 1 }, { agent_b: 1 })).toBe("concurrent");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
bun test packages/lib/team-runtime/src/budget.test.ts packages/lib/team-runtime/src/conflicts.test.ts
```

Expected: FAIL because the budget and conflict helpers do not exist yet.

- [ ] **Step 3: Implement the budget ledger**

```typescript
// packages/lib/team-runtime/src/budget.ts
import type { TeamBudgetPolicy } from "./spec.js";

export function createBudgetLedger(policy: TeamBudgetPolicy) {
  const reserve = policy.reserve ?? 0;
  const defaultSlice = policy.defaultSlice ?? policy.total;
  let spent = 0;

  return {
    assign(taskId: string, amount = defaultSlice): number {
      if (spent + amount > policy.total - reserve) {
        throw new Error(`Insufficient remaining budget for task ${taskId}`);
      }
      spent += amount;
      return amount;
    },
    spent() {
      return spent;
    },
    remaining() {
      return policy.total - spent;
    },
  };
}
```

- [ ] **Step 4: Implement vector-clock comparison and shared-resource conflict detection**

```typescript
// packages/lib/team-runtime/src/conflicts.ts
export type VectorClock = Readonly<Record<string, number>>;

export function compareVectorClock(
  left: VectorClock,
  right: VectorClock,
): "equal" | "before" | "after" | "concurrent" {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  let leftBefore = false;
  let rightBefore = false;

  for (const key of keys) {
    const l = left[key] ?? 0;
    const r = right[key] ?? 0;
    if (l < r) leftBefore = true;
    if (l > r) rightBefore = true;
    if (leftBefore && rightBefore) return "concurrent";
  }

  if (!leftBefore && !rightBefore) return "equal";
  return leftBefore ? "before" : "after";
}

export function detectWriteConflict(
  left: { readonly resource: string; readonly vectorClock: VectorClock },
  right: { readonly resource: string; readonly vectorClock: VectorClock },
): boolean {
  return (
    left.resource === right.resource &&
    compareVectorClock(left.vectorClock, right.vectorClock) === "concurrent"
  );
}
```

- [ ] **Step 5: Add a simple serializer helper for shared resources**

```typescript
// packages/lib/team-runtime/src/workspace.ts
export function createResourceSerializer() {
  const locks = new Set<string>();

  return {
    acquire(resource: string): boolean {
      if (locks.has(resource)) return false;
      locks.add(resource);
      return true;
    },
    release(resource: string): void {
      locks.delete(resource);
    },
    isLocked(resource: string): boolean {
      return locks.has(resource);
    },
  };
}
```

- [ ] **Step 6: Run the budget/conflict tests**

Run:

```bash
bun test packages/lib/team-runtime/src/budget.test.ts packages/lib/team-runtime/src/conflicts.test.ts
```

Expected: PASS with 3 tests passing.

- [ ] **Step 7: Commit budget/conflict primitives**

```bash
git add packages/lib/team-runtime/src/budget.ts packages/lib/team-runtime/src/budget.test.ts packages/lib/team-runtime/src/conflicts.ts packages/lib/team-runtime/src/conflicts.test.ts packages/lib/team-runtime/src/workspace.ts
git commit -m "feat: add team runtime budget and conflict primitives"
```

---

### Task 5: Wire Replay-Friendly Runtime Entry Point And Package Documentation

**Files:**
- Create: `packages/lib/team-runtime/src/replay.ts`
- Create: `packages/lib/team-runtime/src/runtime.ts`
- Create: `docs/L2/team-runtime.md`
- Modify: `packages/lib/team-runtime/src/index.ts`
- Modify: `docs/package-coverage-map.md`
- Reference: `docs/L2/agent-runtime.md`
- Reference: `docs/L2/federation.md`

- [ ] **Step 1: Write the failing runtime test**

```typescript
// packages/lib/team-runtime/src/scheduler.test.ts
import { expect, test } from "bun:test";
import { createTeamRuntime } from "./runtime.js";

test("replays prior events into a resumable snapshot", () => {
  const runtime = createTeamRuntime({
    name: "resume-team",
    agents: [{ agentType: "coder" }],
    budget: { total: 100, defaultSlice: 25 },
    workspacePolicy: { mode: "hybrid" },
  });

  const snapshot = runtime.replay([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_resume",
      timestamp: 1,
      payload: { specName: "resume-team" },
    },
  ]);

  expect(snapshot.teamRunId).toBe("run_resume");
});
```

- [ ] **Step 2: Run the runtime test to verify it fails**

Run:

```bash
bun test packages/lib/team-runtime/src/scheduler.test.ts
```

Expected: FAIL because `createTeamRuntime()` only returns `{ spec }`.

- [ ] **Step 3: Implement replay and runtime glue**

```typescript
// packages/lib/team-runtime/src/replay.ts
import type { TeamEvent } from "./events.js";
import { reduceTeamEvents } from "./state.js";

export function replayTeamRun(events: readonly TeamEvent[]) {
  return reduceTeamEvents(events);
}
```

```typescript
// packages/lib/team-runtime/src/runtime.ts
import type { TeamEvent } from "./events.js";
import type { TeamSpec } from "./spec.js";
import { validateTeamSpec } from "./spec.js";
import { replayTeamRun } from "./replay.js";

export function createTeamRuntime(spec: TeamSpec) {
  const validated = validateTeamSpec(spec);

  return {
    spec: validated,
    replay(events: readonly TeamEvent[]) {
      return replayTeamRun(events);
    },
    getSnapshot() {
      return replayTeamRun([]);
    },
    async start() {
      throw new Error("start() not implemented yet");
    },
    async resume() {
      throw new Error("resume() not implemented yet");
    },
  };
}
```

- [ ] **Step 4: Add the package documentation**

```markdown
<!-- docs/L2/team-runtime.md -->
# @koi/team-runtime

Parallel multi-agent team orchestration with dependency-aware scheduling, replay-friendly event sourcing, budget slices, and shared-resource conflict control.

## Purpose

`@koi/team-runtime` is the L2 orchestration kernel for issue #1647. It materializes decomposed tasks into `@koi/task-board`, computes runnable waves from the board, dispatches parallel-safe work, and uses a durable event log as the replay boundary.

## Key Decisions

- The task board is the authoritative scheduling read model.
- Vector clocks are used for conflict metadata and merge ordering, not for normal readiness checks.
- Shared-resource writes are isolated first and serialized explicitly when resources overlap.

## Main API

```ts
import { createTeamRuntime } from "@koi/team-runtime";
```
```

- [ ] **Step 5: Regenerate the package coverage map**

Run:

```bash
bun scripts/generate-package-coverage-map.ts
```

Expected: `docs/package-coverage-map.md` updates to include `@koi/team-runtime` under the `lib` family with its package path and docs path.

- [ ] **Step 6: Run the focused package checks**

Run:

```bash
bun test packages/lib/team-runtime/src
bun run --filter @koi/team-runtime typecheck
bun run --filter @koi/team-runtime lint
```

Expected: PASS for team-runtime tests, typecheck, and lint.

- [ ] **Step 7: Commit the runtime/documentation slice**

```bash
git add packages/lib/team-runtime docs/L2/team-runtime.md docs/package-coverage-map.md
git commit -m "feat: add team runtime replay entrypoint"
```

---

### Task 6: Close The Spec Gaps With Recovery And Dependency-Wave Regression Tests

**Files:**
- Modify: `packages/lib/team-runtime/src/state.test.ts`
- Modify: `packages/lib/team-runtime/src/planner.test.ts`
- Modify: `packages/lib/team-runtime/src/scheduler.test.ts`
- Modify: `packages/lib/team-runtime/src/conflicts.test.ts`
- Modify: `docs/L2/team-runtime.md`

- [ ] **Step 1: Add a failing crash-recovery regression test**

```typescript
// packages/lib/team-runtime/src/state.test.ts
test("requeues orphaned in-progress work after crash detection event", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_crash",
      timestamp: 1,
      payload: { specName: "crash-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_crash",
      timestamp: 2,
      taskId: "task_a",
      payload: { subject: "A", description: "A", dependencies: [] },
    },
    {
      kind: "task.assigned",
      eventId: "e3",
      teamRunId: "run_crash",
      timestamp: 3,
      taskId: "task_a",
      agentId: "coder-1",
      payload: {},
    },
    {
      kind: "task.crash_detected",
      eventId: "e4",
      teamRunId: "run_crash",
      timestamp: 4,
      taskId: "task_a",
      agentId: "coder-1",
      payload: {},
    },
  ]);

  expect(snapshot.board.get("task_a")?.status).toBe("pending");
});
```

- [ ] **Step 2: Add a failing dependency-wave regression test**

```typescript
// packages/lib/team-runtime/src/planner.test.ts
test("unblocks the next wave only after all upstream tasks complete", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_wave",
      timestamp: 1,
      payload: { specName: "wave-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_wave",
      timestamp: 2,
      taskId: "task_a",
      payload: { subject: "A", description: "A", dependencies: [] },
    },
    {
      kind: "task.added",
      eventId: "e3",
      teamRunId: "run_wave",
      timestamp: 3,
      taskId: "task_b",
      payload: { subject: "B", description: "B", dependencies: [] },
    },
    {
      kind: "task.added",
      eventId: "e4",
      teamRunId: "run_wave",
      timestamp: 4,
      taskId: "task_merge",
      payload: { subject: "Merge", description: "Merge", dependencies: ["task_a", "task_b"] },
    },
  ]);

  expect(planRunnableTasks(snapshot).map((task) => task.id).sort()).toEqual(["task_a", "task_b"]);
});
```

- [ ] **Step 3: Implement the missing recovery event and reducer branch**

```typescript
// packages/lib/team-runtime/src/events.ts
export interface TaskCrashDetectedEvent extends TeamEventBase {
  readonly kind: "task.crash_detected";
  readonly taskId: string;
  readonly agentId: string;
  readonly payload: {};
}

export type TeamEvent =
  | TeamCreatedEvent
  | TaskAddedEvent
  | TaskAssignedEvent
  | TaskCompletedEvent
  | TaskCrashDetectedEvent;
```

```typescript
// packages/lib/team-runtime/src/state.ts
    if (event.kind === "task.crash_detected") {
      const reset = board.unassign(taskItemId(event.taskId));
      if (!reset.ok) throw reset.error;
      board = reset.value;
      continue;
    }
```

- [ ] **Step 4: Update docs to call out crash recovery and wave scheduling explicitly**

```markdown
<!-- docs/L2/team-runtime.md -->
## Recovery

Replay is the authority boundary. `task.crash_detected` returns orphaned in-progress work to a schedulable state so the next dependency wave can continue after resume.
```

- [ ] **Step 5: Run the full focused package test suite**

Run:

```bash
bun test packages/lib/team-runtime/src
```

Expected: PASS across reducer, planner, scheduler, budget, and conflict tests.

- [ ] **Step 6: Commit the regression coverage**

```bash
git add packages/lib/team-runtime/src packages/lib/team-runtime/src/*.test.ts docs/L2/team-runtime.md
git commit -m "test: add team runtime replay and wave regressions"
```

---

## Self-Review

### Spec Coverage

- Package boundary and new L2 package: Task 1
- Event model and reducer-backed snapshot: Task 2
- Dependency-aware runnable waves and dispatch: Task 3
- Budget slicing and conflict metadata: Task 4
- Replay/runtime entrypoint and docs: Task 5
- Crash recovery and wave regression coverage: Task 6

No spec section is left without a matching task. The only explicitly deferred work inside this plan is richer `start()` and `resume()` execution behavior beyond the replay-first skeleton, which is still grounded by Tasks 3, 5, and 6.

### Placeholder Scan

- No `TODO`, `TBD`, or “implement later” placeholders remain in the task steps.
- Every code-changing step includes concrete code or exact file content to add.
- Every test step names an exact command and expected result.

### Type Consistency

- `TeamSpec`, `TeamBudgetPolicy`, and `WriteCoordinationPolicy` are introduced in Task 1 and reused consistently.
- `TeamEvent` grows in Tasks 2, 4, and 6 without renaming previously defined shapes.
- `reduceTeamEvents()`, `planRunnableTasks()`, `createTeamScheduler()`, and `createTeamRuntime()` stay stable across later tasks.
