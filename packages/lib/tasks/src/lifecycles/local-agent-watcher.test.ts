/**
 * Corner-case tests for the local_agent watcher pattern used in spawn.ts.
 *
 * The watcher (startLocalAgentRunner) is a store.watch() callback that:
 *   1. Filters to pending local_agent tasks
 *   2. Claims the task ID synchronously (idempotency guard)
 *   3. Calls runner.start() with a config whose run() invokes spawnFn
 *
 * Key implementation notes:
 *   - Tasks must be added via board.add() (not store.put()) so the board's
 *     internal state knows about them — the board does NOT subscribe to the
 *     store for external changes.
 *   - board.add() writes through to the store, which fires the watcher.
 *   - The board allows only ONE in_progress task at a time, so sequential
 *     tests wait for completion before adding the next task.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentId, ManagedTaskBoard, TaskBoardStore } from "@koi/core";
import { taskItemId } from "@koi/core";
import { createManagedTaskBoard } from "../managed-board.js";
import { createMemoryTaskBoardStore } from "../memory-store.js";
import { createTaskRegistry } from "../task-registry.js";
import { createTaskRunner, type TaskRunner } from "../task-runner.js";
import { createLocalAgentLifecycle, type LocalAgentConfig } from "./local-agent.js";

// ---------------------------------------------------------------------------
// Types mirrored from spawn.ts (avoid importing from meta/cli)
// ---------------------------------------------------------------------------

type SpawnResult =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly error: { readonly message: string } };

type SpawnFn = (req: {
  readonly agentName: string;
  readonly description: string;
  readonly signal: AbortSignal;
  readonly nonInteractive: boolean;
}) => Promise<SpawnResult>;

// ---------------------------------------------------------------------------
// Watcher factory — reproduces startLocalAgentRunner from spawn.ts
// ---------------------------------------------------------------------------

function installWatcher(store: TaskBoardStore, runner: TaskRunner, spawnFn: SpawnFn): () => void {
  const claimedTaskIds = new Set<string>();

  return store.watch((event) => {
    if (event.kind !== "put") return;
    const { item } = event;
    if (item.status !== "pending") return;
    if (item.metadata?.kind !== "local_agent") return;
    if (claimedTaskIds.has(item.id)) return;

    claimedTaskIds.add(item.id);

    const rawAgentType: unknown = item.metadata?.agentType;
    const localAgentType = typeof rawAgentType === "string" ? rawAgentType : item.subject;
    const localInputs: unknown = item.metadata?.inputs ?? item.description;

    const taskConfig: LocalAgentConfig = {
      agentType: localAgentType,
      inputs: localInputs,
      run(_runAgentType: string, runInputs: unknown, signal: AbortSignal) {
        return (async function* () {
          const result = await spawnFn({
            agentName: _runAgentType,
            description: typeof runInputs === "string" ? runInputs : JSON.stringify(runInputs),
            signal,
            nonInteractive: true,
          });
          if (!result.ok) throw new Error(result.error.message);
          yield result.output;
        })();
      },
    };

    void runner.start(item.id, "local_agent", taskConfig);
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const AGENT_ID = "agent_watcher_test" as AgentId;
let store: TaskBoardStore;
let board: ManagedTaskBoard;
let runner: TaskRunner;
let unsubscribes: Array<() => void>;

beforeEach(async () => {
  store = createMemoryTaskBoardStore();
  board = await createManagedTaskBoard({ store });

  const registry = createTaskRegistry();
  registry.register(
    createLocalAgentLifecycle() as unknown as import("../task-registry.js").TaskKindLifecycle,
  );

  runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
  unsubscribes = [];
});

afterEach(async () => {
  for (const unsub of unsubscribes) unsub();
  await runner[Symbol.asyncDispose]();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("local_agent watcher — idempotency guard", () => {
  test("duplicate store puts for same pending task call spawnFn exactly once", async () => {
    let callCount = 0;
    const spawnFn: SpawnFn = mock(async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true as const, output: "done" };
    });

    unsubscribes.push(installWatcher(store, runner, spawnFn));

    // board.add() writes through to the store, triggering the watcher
    await board.add({
      id: taskItemId("task_idem1"),
      description: "idempotency test",
      metadata: { kind: "local_agent", agentType: "worker", inputs: "do it" },
    });

    const now = Date.now();
    const baseFields = { dependencies: [], retries: 0, createdAt: now, updatedAt: now } as const;
    // Force extra store put for the same ID (simulating runner status writes or
    // any other update that rewrites the pending item before the runner claims it)
    store.put({
      ...baseFields,
      version: 2,
      id: taskItemId("task_idem1"),
      status: "pending",
      subject: "task_idem1",
      description: "idempotency test",
      metadata: { kind: "local_agent", agentType: "worker", inputs: "do it" },
    });
    store.put({
      ...baseFields,
      version: 3,
      id: taskItemId("task_idem1"),
      status: "pending",
      subject: "task_idem1",
      description: "idempotency test (third put)",
      metadata: { kind: "local_agent", agentType: "worker", inputs: "do it" },
    });

    await new Promise((r) => setTimeout(r, 200));
    expect(callCount).toBe(1);
  });

  test("two distinct tasks each trigger exactly one spawnFn call (sequential)", async () => {
    let callCount = 0;
    // Resolve each call's promise so the board can advance to completed
    const resolvers: Array<() => void> = [];
    const spawnFn: SpawnFn = mock(async () => {
      callCount++;
      await new Promise<void>((r) => resolvers.push(r));
      return { ok: true as const, output: "done" };
    });

    unsubscribes.push(installWatcher(store, runner, spawnFn));

    // Add first task — board allows it (nothing in_progress)
    await board.add({
      id: taskItemId("task_seq1"),
      description: "first",
      metadata: { kind: "local_agent", agentType: "worker", inputs: "first job" },
    });

    // Wait for spawnFn to be called and resolve it
    await new Promise((r) => setTimeout(r, 100));
    expect(callCount).toBe(1);
    resolvers[0]?.();

    // Wait for first task to complete so board allows a second
    await new Promise((r) => setTimeout(r, 100));

    // Add second task
    await board.add({
      id: taskItemId("task_seq2"),
      description: "second",
      metadata: { kind: "local_agent", agentType: "worker", inputs: "second job" },
    });

    await new Promise((r) => setTimeout(r, 100));
    resolvers[1]?.();
    await new Promise((r) => setTimeout(r, 100));

    expect(callCount).toBe(2);
  });
});

describe("local_agent watcher — task filtering", () => {
  test("non-local_agent kind tasks are ignored", async () => {
    let callCount = 0;
    const spawnFn: SpawnFn = mock(async () => {
      callCount++;
      return { ok: true as const, output: "done" };
    });

    unsubscribes.push(installWatcher(store, runner, spawnFn));

    const base = { dependencies: [], retries: 0, version: 1, updatedAt: Date.now() } as const;
    // Write directly to store with wrong kind (bypasses board so no board start)
    store.put({
      ...base,
      id: taskItemId("task_filt1"),
      status: "pending",
      subject: "task_filt1",
      description: "shell task",
      metadata: { kind: "local_shell", inputs: "echo hi" },
      createdAt: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(callCount).toBe(0);
  });

  test("tasks with no metadata.kind are ignored", async () => {
    let callCount = 0;
    const spawnFn: SpawnFn = mock(async () => {
      callCount++;
      return { ok: true as const, output: "done" };
    });

    unsubscribes.push(installWatcher(store, runner, spawnFn));

    const base = { dependencies: [], retries: 0, version: 1, updatedAt: Date.now() } as const;
    store.put({
      ...base,
      id: taskItemId("task_filt2"),
      status: "pending",
      subject: "task_filt2",
      description: "no kind",
      metadata: {},
      createdAt: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(callCount).toBe(0);
  });

  test("non-pending status tasks are ignored", async () => {
    let callCount = 0;
    const spawnFn: SpawnFn = mock(async () => {
      callCount++;
      return { ok: true as const, output: "done" };
    });

    unsubscribes.push(installWatcher(store, runner, spawnFn));

    const base = { dependencies: [], retries: 0, version: 1, updatedAt: Date.now() } as const;
    for (const status of ["in_progress", "completed", "failed"] as const) {
      store.put({
        ...base,
        id: taskItemId(`task_filt_${status}`),
        status,
        subject: `task_filt_${status}`,
        description: "wrong status",
        metadata: { kind: "local_agent" },
        createdAt: Date.now(),
      });
    }

    await new Promise((r) => setTimeout(r, 100));
    expect(callCount).toBe(0);
  });
});

describe("local_agent watcher — agentType fallback", () => {
  test("uses metadata.agentType when present", async () => {
    let capturedAgentName: string | undefined;
    const spawnFn: SpawnFn = mock(async (req) => {
      capturedAgentName = req.agentName;
      return { ok: true as const, output: "done" };
    });

    unsubscribes.push(installWatcher(store, runner, spawnFn));

    await board.add({
      id: taskItemId("task_atype1"),
      description: "specialist task",
      subject: "fallback-subject",
      metadata: { kind: "local_agent", agentType: "specialist", inputs: "work" },
    });

    await new Promise((r) => setTimeout(r, 200));
    expect(capturedAgentName).toBe("specialist");
  });

  test("falls back to item.subject when agentType absent from metadata", async () => {
    let capturedAgentName: string | undefined;
    const spawnFn: SpawnFn = mock(async (req) => {
      capturedAgentName = req.agentName;
      return { ok: true as const, output: "done" };
    });

    unsubscribes.push(installWatcher(store, runner, spawnFn));

    await board.add({
      id: taskItemId("task_atype2"),
      description: "no agentType",
      subject: "my-agent-type",
      metadata: { kind: "local_agent" }, // no agentType
    });

    await new Promise((r) => setTimeout(r, 200));
    expect(capturedAgentName).toBe("my-agent-type");
  });

  test("falls back to item.subject when agentType is non-string", async () => {
    let capturedAgentName: string | undefined;
    const spawnFn: SpawnFn = mock(async (req) => {
      capturedAgentName = req.agentName;
      return { ok: true as const, output: "done" };
    });

    unsubscribes.push(installWatcher(store, runner, spawnFn));

    await board.add({
      id: taskItemId("task_atype3"),
      description: "non-string agentType",
      subject: "subject-fallback",
      metadata: { kind: "local_agent", agentType: 42 }, // non-string
    });

    await new Promise((r) => setTimeout(r, 200));
    expect(capturedAgentName).toBe("subject-fallback");
  });
});

describe("local_agent watcher — spawnFn failure", () => {
  test("spawnFn returning ok:false transitions task to failed without crashing runner", async () => {
    const spawnFn: SpawnFn = mock(async () => ({
      ok: false as const,
      error: { message: "child agent rejected" },
    }));

    unsubscribes.push(installWatcher(store, runner, spawnFn));

    await board.add({
      id: taskItemId("task_fail1"),
      description: "spawn failure",
      metadata: { kind: "local_agent", agentType: "worker", inputs: "fail" },
    });

    await new Promise((r) => setTimeout(r, 300));

    const task = board.snapshot().get(taskItemId("task_fail1"));
    expect(task?.status).toBe("failed");
  });

  test("runner remains operational after one spawn failure", async () => {
    let callCount = 0;

    // First watcher: failing spawnFn
    const failSpawn: SpawnFn = mock(async () => ({
      ok: false as const,
      error: { message: "rejected" },
    }));
    unsubscribes.push(installWatcher(store, runner, failSpawn));

    await board.add({
      id: taskItemId("task_alive1"),
      description: "fail first",
      metadata: { kind: "local_agent", agentType: "worker", inputs: "fail" },
    });

    // Wait for failure + board to settle
    await new Promise((r) => setTimeout(r, 300));

    // Second task with a working spawnFn on a fresh watcher
    for (const unsub of unsubscribes) unsub();
    unsubscribes.length = 0;

    const okSpawn: SpawnFn = mock(async () => {
      callCount++;
      return { ok: true as const, output: "success" };
    });
    unsubscribes.push(installWatcher(store, runner, okSpawn));

    await board.add({
      id: taskItemId("task_alive2"),
      description: "second task after failure",
      metadata: { kind: "local_agent", agentType: "worker", inputs: "go" },
    });

    await new Promise((r) => setTimeout(r, 300));
    expect(callCount).toBe(1);
  });
});
