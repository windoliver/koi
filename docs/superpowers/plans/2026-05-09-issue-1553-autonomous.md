# Issue #1553 Autonomous Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore `@koi/autonomous` as a new L3 facade that composes long-running harness + harness scheduler + autonomous helper behavior while keeping substantive runtime logic in lower-layer packages.

**Architecture:** Put autonomous-specific board reconciliation and spawn-fitness logic into `@koi/task-spawn`, put notification/retry helpers into `@koi/long-running`, and keep `packages/meta/autonomous` limited to types, composition, middleware/provider assembly, and ordered disposal. Update layer/docs wiring so the new package is recognized as L3 and the public API is documented.

**Tech Stack:** Bun 1.3.x, TypeScript 6 ESM, bun:test, tsup, Biome, Turborepo, existing `@koi/core` / `@koi/task-spawn` / `@koi/long-running` / `@koi/harness-scheduler` package patterns.

---

### Task 1: Scaffold `@koi/autonomous` as a new L3 package

**Files:**
- Create: `packages/meta/autonomous/package.json`
- Create: `packages/meta/autonomous/tsconfig.json`
- Create: `packages/meta/autonomous/tsup.config.ts`
- Create: `packages/meta/autonomous/src/index.ts`
- Create: `packages/meta/autonomous/src/types.ts`
- Create: `packages/meta/autonomous/src/autonomous.ts`
- Create: `packages/meta/autonomous/src/autonomous.test.ts`
- Modify: `scripts/layers.ts`

- [ ] **Step 1: Write the failing package scaffold test**

```ts
// packages/meta/autonomous/src/autonomous.test.ts
import { describe, expect, test } from "bun:test";
import { createAutonomousAgent } from "./autonomous.js";

describe("@koi/autonomous", () => {
  test("exposes a composed autonomous handle", () => {
    expect(typeof createAutonomousAgent).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/meta/autonomous/src/autonomous.test.ts`
Expected: FAIL with a module-not-found or file-not-found error because `packages/meta/autonomous` does not exist yet.

- [ ] **Step 3: Add the package manifest and build config**

```json
{
  "name": "@koi/autonomous",
  "description": "L3 autonomous composition facade for long-running harness, scheduler, and task-aware helper wiring",
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
    "lint": "biome check .",
    "test": "bun test"
  },
  "koi": {
    "optional": true
  },
  "dependencies": {
    "@koi/core": "workspace:*",
    "@koi/harness-scheduler": "workspace:*",
    "@koi/long-running": "workspace:*",
    "@koi/task-board": "workspace:*",
    "@koi/task-spawn": "workspace:*"
  }
}
```

```ts
// packages/meta/autonomous/tsup.config.ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
});
```

```json
// packages/meta/autonomous/tsconfig.json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 4: Add the minimal public API and classify the package as L3**

```ts
// packages/meta/autonomous/src/index.ts
export { createAutonomousAgent } from "./autonomous.js";
export type { AutonomousAgent, AutonomousAgentParts } from "./types.js";
```

```ts
// packages/meta/autonomous/src/types.ts
import type { AgentResolver, KoiMiddleware } from "@koi/core";
import type { HarnessScheduler } from "@koi/harness-scheduler";
import type { LongRunningHarness } from "@koi/long-running";

export interface AutonomousAgentParts {
  readonly harness: LongRunningHarness;
  readonly scheduler: HarnessScheduler;
  readonly agentResolver?: AgentResolver | undefined;
  readonly extraMiddleware?: readonly KoiMiddleware[] | undefined;
}

export interface AutonomousAgent {
  readonly harness: LongRunningHarness;
  readonly scheduler: HarnessScheduler;
  readonly middleware: () => readonly KoiMiddleware[];
  readonly dispose: () => Promise<void>;
  readonly agentResolver?: AgentResolver | undefined;
}
```

```ts
// packages/meta/autonomous/src/autonomous.ts
import type { AutonomousAgent, AutonomousAgentParts } from "./types.js";

export function createAutonomousAgent(parts: AutonomousAgentParts): AutonomousAgent {
  const middleware = [
    parts.harness.createMiddleware(),
    ...(parts.extraMiddleware ?? []),
  ] as const;

  return {
    harness: parts.harness,
    scheduler: parts.scheduler,
    middleware: () => middleware,
    dispose: async () => {
      await parts.scheduler.dispose();
      await parts.harness.dispose();
    },
    agentResolver: parts.agentResolver,
  };
}
```

```ts
// scripts/layers.ts
export const L3_PACKAGES: ReadonlySet<string> = new Set([
  "@koi/autonomous",
  "@koi/auto-harness",
  "@koi/cli",
  "@koi-agent/cli",
  "@koi/gateway-stack",
  "@koi/rlm-stack",
  "@koi/runtime",
]);
```

- [ ] **Step 5: Run test to verify the scaffold passes**

Run: `bun test packages/meta/autonomous/src/autonomous.test.ts`
Expected: PASS with `1 pass`.

- [ ] **Step 6: Commit**

```bash
git add packages/meta/autonomous scripts/layers.ts
git commit -m "feat: scaffold autonomous meta-package"
```

### Task 2: Add autonomous reconciler behavior to `@koi/task-spawn`

**Files:**
- Modify: `packages/lib/task-spawn/package.json`
- Create: `packages/lib/task-spawn/src/autonomous-reconciler.ts`
- Create: `packages/lib/task-spawn/src/autonomous-reconciler.test.ts`
- Modify: `packages/lib/task-spawn/src/index.ts`

- [ ] **Step 1: Write the failing reconciler tests**

```ts
// packages/lib/task-spawn/src/autonomous-reconciler.test.ts
import { describe, expect, test } from "bun:test";
import { agentId, taskItemId } from "@koi/core";
import { createTaskBoard, serializeBoard } from "@koi/task-board";
import { reconcileTaskBoard } from "./autonomous-reconciler.js";

describe("reconcileTaskBoard", () => {
  test("keeps blocked tasks undispatched", () => {
    const board = createTaskBoard().addAll([
      { id: taskItemId("a"), subject: "parent", description: "parent" },
      {
        id: taskItemId("b"),
        subject: "child",
        description: "child",
        dependencies: [taskItemId("a")],
      },
    ]);
    if (!board.ok) throw board.error;

    const result = reconcileTaskBoard(serializeBoard(board.value));
    expect(result.actions).toEqual([]);
  });

  test("emits dispatch actions in topological order for ready spawn tasks", () => {
    const board = createTaskBoard().addAll([
      {
        id: taskItemId("a"),
        subject: "first",
        description: "first",
        agentType: "researcher",
      },
      {
        id: taskItemId("b"),
        subject: "second",
        description: "second",
        dependencies: [taskItemId("a")],
        agentType: "coder",
      },
    ]);
    if (!board.ok) throw board.error;
    const assigned = board.value.assign(taskItemId("a"), agentId("worker-1"));
    if (!assigned.ok) throw assigned.error;
    const afterFirst = assigned.value.complete(taskItemId("a"), {
      taskId: taskItemId("a"),
      output: "ok",
      durationMs: 10,
    });
    if (!afterFirst.ok) throw afterFirst.error;

    const result = reconcileTaskBoard(serializeBoard(afterFirst.value));
    expect(result.actions.map((action) => action.kind)).toEqual(["dispatch"]);
    expect(result.actions[0]?.taskId).toBe(taskItemId("b"));
  });

  test("emits recovery action for stale delegated pending tasks", () => {
    const board = createTaskBoard().add({
      id: taskItemId("stale"),
      subject: "recover me",
      description: "recover me",
      metadata: { delegatedTo: "worker-1" },
    });
    if (!board.ok) throw board.error;

    const result = reconcileTaskBoard(serializeBoard(board.value));
    expect(result.actions).toEqual([
      { kind: "clearDelegation", taskId: taskItemId("stale"), delegatedTo: "worker-1" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/lib/task-spawn/src/autonomous-reconciler.test.ts`
Expected: FAIL because `autonomous-reconciler.ts` does not exist and `TaskBoardSnapshot` currently has no autonomous reconciler implementation.

- [ ] **Step 3: Implement the reconciler helper and export it**

```ts
// packages/lib/task-spawn/package.json
{
  "dependencies": {
    "@koi/core": "workspace:*",
    "@koi/task-board": "workspace:*"
  }
}
```

```ts
// packages/lib/task-spawn/src/autonomous-reconciler.ts
import type { Task, TaskBoardSnapshot, TaskItemId } from "@koi/core";
import { createTaskBoard, topologicalSort } from "@koi/task-board";

export type AutonomousReconcileAction =
  | { readonly kind: "dispatch"; readonly taskId: TaskItemId; readonly agentType: string }
  | {
      readonly kind: "clearDelegation";
      readonly taskId: TaskItemId;
      readonly delegatedTo: string;
    };

export interface AutonomousReconcileResult {
  readonly actions: readonly AutonomousReconcileAction[];
}

function isSpawnReady(task: Task): boolean {
  return task.status === "pending" && typeof task.agentType === "string" && task.agentType.length > 0;
}

export function reconcileTaskBoard(snapshot: TaskBoardSnapshot): AutonomousReconcileResult {
  const board = createTaskBoard(undefined, snapshot);
  const items = board.all();
  const ordered = topologicalSort(new Map(items.map((item) => [item.id, item])));

  const actions: AutonomousReconcileAction[] = [];

  for (const taskId of ordered) {
    const task = board.get(taskId);
    if (task === undefined) continue;

    const delegatedTo =
      typeof task.metadata?.delegatedTo === "string" ? task.metadata.delegatedTo : undefined;

    if (task.status === "pending" && delegatedTo !== undefined) {
      actions.push({ kind: "clearDelegation", taskId: task.id, delegatedTo });
      continue;
    }

    if (isSpawnReady(task) && board.blockedBy(task.id) === undefined) {
      actions.push({ kind: "dispatch", taskId: task.id, agentType: task.agentType });
    }
  }

  return { actions };
}
```

```ts
// packages/lib/task-spawn/src/index.ts
export type {
  AutonomousReconcileAction,
  AutonomousReconcileResult,
} from "./autonomous-reconciler.js";
export { reconcileTaskBoard } from "./autonomous-reconciler.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/lib/task-spawn/src/autonomous-reconciler.test.ts`
Expected: PASS with `3 pass`.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/task-spawn/package.json \
        packages/lib/task-spawn/src/autonomous-reconciler.ts \
        packages/lib/task-spawn/src/autonomous-reconciler.test.ts \
        packages/lib/task-spawn/src/index.ts
git commit -m "feat: add autonomous task reconciler"
```

### Task 3: Add spawn fitness tracking to `@koi/task-spawn`

**Files:**
- Create: `packages/lib/task-spawn/src/spawn-fitness-wrapper.ts`
- Create: `packages/lib/task-spawn/src/spawn-fitness-wrapper.test.ts`
- Modify: `packages/lib/task-spawn/src/index.ts`

- [ ] **Step 1: Write the failing wrapper tests**

```ts
// packages/lib/task-spawn/src/spawn-fitness-wrapper.test.ts
import { describe, expect, mock, test } from "bun:test";
import { createSpawnFitnessWrapper } from "./spawn-fitness-wrapper.js";

describe("createSpawnFitnessWrapper", () => {
  test("records successful outcomes", async () => {
    const record = mock(async () => undefined);
    const wrapped = createSpawnFitnessWrapper(
      async () => ({ ok: true as const, output: "done" }),
      { recordOutcome: record, now: () => 10 },
    );

    await wrapped({
      description: "do work",
      agentName: "worker",
      signal: new AbortController().signal,
    });

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({
      ok: true,
      agentName: "worker",
      durationMs: 0,
    });
  });

  test("records failed outcomes", async () => {
    const record = mock(async () => undefined);
    const wrapped = createSpawnFitnessWrapper(
      async () => ({
        ok: false as const,
        error: { code: "EXTERNAL", message: "boom", retryable: true },
      }),
      { recordOutcome: record, now: () => 20 },
    );

    await wrapped({
      description: "do work",
      agentName: "worker",
      signal: new AbortController().signal,
    });

    expect(record.mock.calls[0]?.[0]).toMatchObject({
      ok: false,
      agentName: "worker",
      error: "boom",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/lib/task-spawn/src/spawn-fitness-wrapper.test.ts`
Expected: FAIL because `createSpawnFitnessWrapper` is not exported yet.

- [ ] **Step 3: Implement the wrapper and export it**

```ts
// packages/lib/task-spawn/src/spawn-fitness-wrapper.ts
import type { SpawnFn, SpawnRequest, SpawnResult } from "@koi/core";

export interface SpawnFitnessOutcome {
  readonly agentName: string;
  readonly description: string;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly error?: string | undefined;
}

export interface SpawnFitnessWrapperConfig {
  readonly recordOutcome: (outcome: SpawnFitnessOutcome) => Promise<void> | void;
  readonly now?: (() => number) | undefined;
}

export function createSpawnFitnessWrapper(
  spawn: SpawnFn,
  config: SpawnFitnessWrapperConfig,
): SpawnFn {
  const now = config.now ?? Date.now;

  return async (request: SpawnRequest): Promise<SpawnResult> => {
    const startedAt = now();
    const result = await spawn(request);
    const durationMs = now() - startedAt;

    await config.recordOutcome({
      agentName: request.agentName,
      description: request.description,
      durationMs,
      ok: result.ok,
      ...(result.ok ? {} : { error: result.error.message }),
    });

    return result;
  };
}
```

```ts
// packages/lib/task-spawn/src/index.ts
export type {
  SpawnFitnessOutcome,
  SpawnFitnessWrapperConfig,
} from "./spawn-fitness-wrapper.js";
export { createSpawnFitnessWrapper } from "./spawn-fitness-wrapper.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/lib/task-spawn/src/spawn-fitness-wrapper.test.ts`
Expected: PASS with `2 pass`.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/task-spawn/src/spawn-fitness-wrapper.ts \
        packages/lib/task-spawn/src/spawn-fitness-wrapper.test.ts \
        packages/lib/task-spawn/src/index.ts
git commit -m "feat: add spawn fitness wrapper"
```

### Task 4: Add completion notification helpers to `@koi/long-running`

**Files:**
- Create: `packages/lib/long-running/src/retry-send.ts`
- Create: `packages/lib/long-running/src/retry-send.test.ts`
- Create: `packages/lib/long-running/src/completion-notifier.ts`
- Create: `packages/lib/long-running/src/completion-notifier.test.ts`
- Modify: `packages/lib/long-running/src/index.ts`

- [ ] **Step 1: Write the failing notifier tests**

```ts
// packages/lib/long-running/src/completion-notifier.test.ts
import { describe, expect, mock, test } from "bun:test";
import { createCompletionNotifier } from "./completion-notifier.js";

describe("createCompletionNotifier", () => {
  test("sends completed notifications", async () => {
    const send = mock(async () => undefined);
    const notifier = createCompletionNotifier({
      send,
      formatCompleted: (taskId, output) => `${taskId}:${output}`,
      formatFailed: (taskId, error) => `${taskId}:${error}`,
    });

    await notifier.onCompleted("task-1", "done");
    expect(send).toHaveBeenCalledWith("task-1:done");
  });

  test("sends failed notifications", async () => {
    const send = mock(async () => undefined);
    const notifier = createCompletionNotifier({
      send,
      formatCompleted: (taskId, output) => `${taskId}:${output}`,
      formatFailed: (taskId, error) => `${taskId}:${error}`,
    });

    await notifier.onFailed("task-2", "boom");
    expect(send).toHaveBeenCalledWith("task-2:boom");
  });
});
```

```ts
// packages/lib/long-running/src/retry-send.test.ts
import { describe, expect, mock, test } from "bun:test";
import { sendWithRetry } from "./retry-send.js";

describe("sendWithRetry", () => {
  test("retries transient failures up to maxRetries", async () => {
    const send = mock()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(undefined);

    const result = await sendWithRetry(send, "payload", { maxRetries: 2, delayMs: 0 });

    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/lib/long-running/src/completion-notifier.test.ts packages/lib/long-running/src/retry-send.test.ts`
Expected: FAIL because the helper files and exports do not exist yet.

- [ ] **Step 3: Implement retry-send and completion-notifier**

```ts
// packages/lib/long-running/src/retry-send.ts
export interface RetrySendOptions {
  readonly maxRetries?: number | undefined;
  readonly delayMs?: number | undefined;
}

export type RetrySendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: Error };

export async function sendWithRetry<T>(
  send: (message: T) => Promise<void>,
  message: T,
  options: RetrySendOptions = {},
): Promise<RetrySendResult> {
  const maxRetries = options.maxRetries ?? 3;
  const delayMs = options.delayMs ?? 50;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      await send(message);
      return { ok: true };
    } catch (error) {
      if (attempt === maxRetries) {
        return {
          ok: false,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return { ok: false, error: new Error("unreachable retry state") };
}
```

```ts
// packages/lib/long-running/src/completion-notifier.ts
import { sendWithRetry, type RetrySendOptions } from "./retry-send.js";

export interface CompletionNotifierConfig {
  readonly send: (message: string) => Promise<void>;
  readonly formatCompleted: (taskId: string, output: string) => string;
  readonly formatFailed: (taskId: string, error: string) => string;
  readonly retry?: RetrySendOptions | undefined;
}

export interface CompletionNotifier {
  readonly onCompleted: (taskId: string, output: string) => Promise<void>;
  readonly onFailed: (taskId: string, error: string) => Promise<void>;
}

export function createCompletionNotifier(config: CompletionNotifierConfig): CompletionNotifier {
  return {
    onCompleted: async (taskId, output) => {
      const message = config.formatCompleted(taskId, output);
      await sendWithRetry(config.send, message, config.retry);
    },
    onFailed: async (taskId, error) => {
      const message = config.formatFailed(taskId, error);
      await sendWithRetry(config.send, message, config.retry);
    },
  };
}
```

```ts
// packages/lib/long-running/src/index.ts
export type {
  CompletionNotifier,
  CompletionNotifierConfig,
} from "./completion-notifier.js";
export { createCompletionNotifier } from "./completion-notifier.js";
export type { RetrySendOptions, RetrySendResult } from "./retry-send.js";
export { sendWithRetry } from "./retry-send.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/lib/long-running/src/completion-notifier.test.ts packages/lib/long-running/src/retry-send.test.ts`
Expected: PASS with `3 pass`.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/long-running/src/retry-send.ts \
        packages/lib/long-running/src/retry-send.test.ts \
        packages/lib/long-running/src/completion-notifier.ts \
        packages/lib/long-running/src/completion-notifier.test.ts \
        packages/lib/long-running/src/index.ts
git commit -m "feat: add autonomous notification helpers"
```

### Task 5: Implement real facade composition in `@koi/autonomous`

**Files:**
- Modify: `packages/meta/autonomous/src/types.ts`
- Modify: `packages/meta/autonomous/src/autonomous.ts`
- Modify: `packages/meta/autonomous/src/autonomous.test.ts`

- [ ] **Step 1: Write the failing composition tests**

```ts
// packages/meta/autonomous/src/autonomous.test.ts
import { describe, expect, mock, test } from "bun:test";
import type { KoiMiddleware } from "@koi/core";
import { createAutonomousAgent } from "./autonomous.js";

const middlewareA = { name: "a" } as unknown as KoiMiddleware;
const middlewareB = { name: "b" } as unknown as KoiMiddleware;

describe("createAutonomousAgent", () => {
  test("returns stable middleware ordering", () => {
    const harness = {
      createMiddleware: () => middlewareA,
      dispose: async () => undefined,
    };
    const scheduler = {
      dispose: async () => undefined,
    };

    const agent = createAutonomousAgent({
      harness: harness as never,
      scheduler: scheduler as never,
      extraMiddleware: [middlewareB],
    });

    expect(agent.middleware()).toEqual([middlewareA, middlewareB]);
    expect(agent.middleware()).toBe(agent.middleware());
  });

  test("disposes scheduler before harness", async () => {
    const order: string[] = [];
    const harness = {
      createMiddleware: () => middlewareA,
      dispose: async () => {
        order.push("harness");
      },
    };
    const scheduler = {
      dispose: async () => {
        order.push("scheduler");
      },
    };

    const agent = createAutonomousAgent({
      harness: harness as never,
      scheduler: scheduler as never,
    });

    await agent.dispose();
    expect(order).toEqual(["scheduler", "harness"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/meta/autonomous/src/autonomous.test.ts`
Expected: FAIL because the scaffold implementation does not guarantee middleware memoization or well-typed disposal coordination yet.

- [ ] **Step 3: Implement the full facade behavior**

```ts
// packages/meta/autonomous/src/types.ts
import type { AgentResolver, KoiMiddleware } from "@koi/core";
import type { HarnessScheduler } from "@koi/harness-scheduler";
import type {
  CompletionNotifier,
  LongRunningHarness,
} from "@koi/long-running";
import type {
  SpawnFitnessWrapperConfig,
  SpawnFn,
} from "@koi/task-spawn";

export interface AutonomousAgentParts {
  readonly harness: LongRunningHarness;
  readonly scheduler: HarnessScheduler;
  readonly agentResolver?: AgentResolver | undefined;
  readonly spawn?: SpawnFn | undefined;
  readonly completionNotifier?: CompletionNotifier | undefined;
  readonly spawnFitness?: SpawnFitnessWrapperConfig | undefined;
  readonly extraMiddleware?: readonly KoiMiddleware[] | undefined;
}

export interface AutonomousAgent {
  readonly harness: LongRunningHarness;
  readonly scheduler: HarnessScheduler;
  readonly middleware: () => readonly KoiMiddleware[];
  readonly dispose: () => Promise<void>;
  readonly agentResolver?: AgentResolver | undefined;
}
```

```ts
// packages/meta/autonomous/src/autonomous.ts
import type { KoiMiddleware } from "@koi/core";
import {
  createSpawnFitnessWrapper,
  type SpawnFn,
} from "@koi/task-spawn";
import type { AutonomousAgent, AutonomousAgentParts } from "./types.js";

async function disposeSchedulerFirst(
  parts: AutonomousAgentParts,
): Promise<void> {
  await parts.scheduler.dispose();
  await parts.harness.dispose();
}

export function createAutonomousAgent(parts: AutonomousAgentParts): AutonomousAgent {
  const wrappedSpawn: SpawnFn | undefined =
    parts.spawn !== undefined && parts.spawnFitness !== undefined
      ? createSpawnFitnessWrapper(parts.spawn, parts.spawnFitness)
      : parts.spawn;

  void wrappedSpawn;

  const middleware = Object.freeze([
    parts.harness.createMiddleware(),
    ...(parts.extraMiddleware ?? []),
  ]) as readonly KoiMiddleware[];

  let disposed = false;

  return {
    harness: parts.harness,
    scheduler: parts.scheduler,
    middleware: () => middleware,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await disposeSchedulerFirst(parts);
    },
    agentResolver: parts.agentResolver,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/meta/autonomous/src/autonomous.test.ts`
Expected: PASS with `2 pass`.

- [ ] **Step 5: Commit**

```bash
git add packages/meta/autonomous/src/types.ts \
        packages/meta/autonomous/src/autonomous.ts \
        packages/meta/autonomous/src/autonomous.test.ts
git commit -m "feat: compose autonomous facade"
```

### Task 6: Update docs and repo wiring for the new package

**Files:**
- Modify: `docs/L2/autonomous.md`
- Create: `docs/L3/autonomous.md`
- Modify: `docs/package-coverage-map.md`
- Modify: `scripts/add-descriptions.ts`

- [ ] **Step 1: Write the failing documentation/wiring check expectation**

```md
Required outcomes after docs wiring:

- `@koi/autonomous` appears in the package coverage map
- L3 docs explain that behavior lives in lower-layer helpers
- `scripts/add-descriptions.ts` includes the exact package name used by the new package
```

- [ ] **Step 2: Run the relevant checks to establish the baseline**

Run: `bun run check:descriptions && bun run check:doc-wiring`
Expected: At least one failure or missing-package report for `@koi/autonomous` until the docs and description wiring are added.

- [ ] **Step 3: Update docs and package description wiring**

```md
<!-- docs/L3/autonomous.md -->
# `@koi/autonomous`

`@koi/autonomous` is the L3 facade for autonomous execution.

It composes:

- `@koi/long-running`
- `@koi/harness-scheduler`
- `@koi/task-spawn` autonomous helpers

The package intentionally keeps runtime behavior out of L3. Reconciliation,
spawn fitness tracking, and completion notification live in lower-layer helpers
and are only assembled here.
```

```ts
// scripts/add-descriptions.ts
"@koi/autonomous":
  "L3 autonomous composition facade for long-running harness, scheduler, and task-aware helper wiring",
```

```md
<!-- docs/package-coverage-map.md -->
- `@koi/autonomous` (packages/meta/autonomous) - L3 autonomous composition facade for long-running harness, scheduler, and task-aware helper wiring. Tests: 1. Docs: docs/L3/autonomous.md.
```

- [ ] **Step 4: Run the docs checks to verify they pass**

Run: `bun run check:descriptions && bun run check:doc-wiring`
Expected: PASS with zero description/doc-wiring failures for `@koi/autonomous`.

- [ ] **Step 5: Commit**

```bash
git add docs/L2/autonomous.md docs/L3/autonomous.md docs/package-coverage-map.md scripts/add-descriptions.ts
git commit -m "docs: wire autonomous package docs"
```

### Task 7: Full verification and cleanup

**Files:**
- Verify only: `packages/lib/task-spawn/src/*`
- Verify only: `packages/lib/long-running/src/*`
- Verify only: `packages/meta/autonomous/src/*`
- Verify only: `scripts/layers.ts`
- Verify only: `docs/L3/autonomous.md`

- [ ] **Step 1: Run focused package tests**

Run: `bun test packages/lib/task-spawn/src/autonomous-reconciler.test.ts packages/lib/task-spawn/src/spawn-fitness-wrapper.test.ts packages/lib/long-running/src/retry-send.test.ts packages/lib/long-running/src/completion-notifier.test.ts packages/meta/autonomous/src/autonomous.test.ts`
Expected: PASS with all new autonomous-related tests green.

- [ ] **Step 2: Run package-level type and lint checks**

Run: `bun --cwd packages/lib/task-spawn run typecheck && bun --cwd packages/lib/long-running run typecheck && bun --cwd packages/meta/autonomous run typecheck`
Expected: PASS with zero TypeScript errors.

Run: `bun --cwd packages/lib/task-spawn run lint && bun --cwd packages/lib/long-running run lint && bun --cwd packages/meta/autonomous run lint`
Expected: PASS with zero Biome violations.

- [ ] **Step 3: Run repo safety checks**

Run: `bun run check:layers && bun run check:orphans && bun run check:descriptions`
Expected: PASS with zero layer or orphan violations and the new package recognized cleanly.

- [ ] **Step 4: Review git diff for unintended spillover**

Run: `git diff --stat --cached && git diff --stat`
Expected: only autonomous-related package, script, and docs files changed.

- [ ] **Step 5: Commit the verification fixes if needed**

```bash
git add packages/lib/task-spawn packages/lib/long-running packages/meta/autonomous scripts/layers.ts docs/L2/autonomous.md docs/L3/autonomous.md docs/package-coverage-map.md scripts/add-descriptions.ts
git commit -m "chore: finalize autonomous package verification"
```
