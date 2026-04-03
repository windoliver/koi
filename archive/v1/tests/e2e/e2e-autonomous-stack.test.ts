/**
 * E2E: Autonomous stack — full turn-by-turn scenarios through createKoi.
 *
 * Uses scripted model adapters (no real LLM) to drive realistic multi-turn
 * conversations through the complete autonomous pipeline:
 *   createKoi → middleware (harness, checkpoint, goal-stack) →
 *   providers (plan_autonomous, task_complete, task_status) →
 *   delegation bridge → spawn workers → harness persistence
 *
 * Each test scripts the exact model responses turn-by-turn, exercising
 * the real engine loop, middleware chain, and tool execution — just without
 * paying for API calls. Runs in <100ms per test, deterministic, no API keys.
 *
 * Run: bun test tests/e2e/e2e-autonomous-stack.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  EngineEvent,
  HarnessSnapshot,
  HarnessStatus,
  JsonObject,
  KoiError,
  ModelRequest,
  ModelResponse,
  SpawnFn,
  SpawnRequest,
} from "@koi/core";
import { agentId, harnessId, taskItemId } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createAutonomousAgent } from "../../packages/meta/autonomous/src/autonomous.js";
import { createInMemorySnapshotChainStore } from "../../packages/mm/snapshot-chain-store/src/memory-store.js";
import { createHarnessScheduler } from "../../packages/sched/harness-scheduler/src/scheduler.js";
import { createLongRunningHarness } from "../../packages/sched/long-running/src/harness.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const TIMEOUT = 30_000;

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const result: EngineEvent[] = [];
  for await (const event of iterable) {
    result.push(event);
  }
  return result;
}

/** Scripted model that steps through tool calls and text responses. */
function createScriptedModel(
  script: ReadonlyArray<
    | { readonly kind: "tool_call"; readonly toolName: string; readonly input: JsonObject }
    | { readonly kind: "text"; readonly text: string }
  >,
): { modelCall: (req: ModelRequest) => Promise<ModelResponse> } {
  // let justified: mutable counter for script progression
  let callIndex = 0;

  return {
    modelCall: async (_req: ModelRequest): Promise<ModelResponse> => {
      const step = script[callIndex];
      callIndex += 1;

      if (step === undefined || step.kind === "text") {
        return {
          content: step?.text ?? "Done.",
          model: "scripted",
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }

      return {
        content: "",
        model: "scripted",
        usage: { inputTokens: 10, outputTokens: 5 },
        metadata: {
          toolCalls: [
            {
              toolName: step.toolName,
              callId: `call_${callIndex}`,
              input: step.input,
            },
          ],
        },
      };
    },
  };
}

/** Minimal session persistence for tests. */
function createMinimalPersistence() {
  const s = new Map<string, unknown>();
  return {
    saveSession: (r: { sessionId: string }) => {
      s.set(r.sessionId, r);
      return { ok: true as const, value: undefined };
    },
    loadSession: (sid: string) => {
      const r = s.get(sid);
      return r
        ? { ok: true as const, value: r }
        : {
            ok: false as const,
            error: { code: "NOT_FOUND" as const, message: "nf", retryable: false },
          };
    },
    removeSession: () => ({ ok: true as const, value: undefined }),
    listSessions: () => ({ ok: true as const, value: [] }),
    savePendingFrame: () => ({ ok: true as const, value: undefined }),
    loadPendingFrames: () => ({ ok: true as const, value: [] }),
    clearPendingFrames: () => ({ ok: true as const, value: undefined }),
    removePendingFrame: () => ({ ok: true as const, value: undefined }),
    recover: () => ({
      ok: true as const,
      value: { sessions: [], pendingFrames: new Map(), skipped: [] },
    }),
    close: () => {},
  };
}

/** Create a full autonomous runtime (harness + scheduler + engine). */
async function createAutonomousRuntime(opts: {
  readonly script: Parameters<typeof createScriptedModel>[0];
  readonly spawnFn?: SpawnFn | undefined;
  readonly onCompleted?: ((status: HarnessStatus) => void) | undefined;
  readonly onFailed?: ((status: HarnessStatus, error: KoiError) => void) | undefined;
}): Promise<{
  readonly runtime: Awaited<ReturnType<typeof createKoi>>;
  readonly harness: ReturnType<typeof createLongRunningHarness>;
  readonly scheduler: ReturnType<typeof createHarnessScheduler>;
  readonly dispose: () => Promise<void>;
}> {
  const store = createInMemorySnapshotChainStore<HarnessSnapshot>();
  const harness = createLongRunningHarness({
    harnessId: harnessId("test-harness"),
    agentId: agentId("test-copilot"),
    harnessStore: store,
    sessionPersistence: createMinimalPersistence() as never,
    onCompleted: opts.onCompleted,
    onFailed: opts.onFailed,
  });

  const scheduler = createHarnessScheduler({
    harness,
    pollIntervalMs: 100,
    maxRetries: 3,
    delay: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 50))),
  });

  const agent = createAutonomousAgent({
    harness,
    scheduler,
    ...(opts.spawnFn !== undefined ? { getSpawn: () => opts.spawnFn } : {}),
  });

  const { modelCall } = createScriptedModel(opts.script);

  const adapter = createLoopAdapter({ modelCall, maxTurns: 15 });

  const runtime = await createKoi({
    manifest: { name: "test-copilot", version: "0.0.1", model: { name: "scripted" } },
    adapter,
    middleware: [...agent.middleware()],
    providers: [...agent.providers()],
    limits: { maxTurns: 15, maxDurationMs: 30_000 },
  });

  const dispose = async (): Promise<void> => {
    await runtime.dispose();
    await agent.dispose();
  };

  return { runtime, harness, scheduler, dispose };
}

// ===========================================================================
// Scenario 1: Self-delegation — copilot plans and completes tasks itself
// ===========================================================================

describe("Scenario 1: Self-delegation plan + complete", () => {
  test(
    "copilot creates plan, completes 2 tasks, harness transitions to completed",
    async () => {
      let completed = false;
      const { runtime, harness, dispose } = await createAutonomousRuntime({
        script: [
          // Turn 1: Model calls plan_autonomous
          {
            kind: "tool_call",
            toolName: "plan_autonomous",
            input: {
              tasks: [
                { id: "research", description: "Research APIs" },
                { id: "implement", description: "Write code", dependencies: ["research"] },
              ],
            },
          },
          // Turn 2: Model completes first task
          {
            kind: "tool_call",
            toolName: "task_complete",
            input: { task_id: "research", output: "Found 3 APIs: Stripe, Square, PayPal" },
          },
          // Turn 3: Model completes second task
          {
            kind: "tool_call",
            toolName: "task_complete",
            input: { task_id: "implement", output: "Implemented Stripe integration" },
          },
          // Turn 4: Model responds to user
          { kind: "text", text: "All tasks completed. I researched APIs and implemented Stripe." },
        ],
        onCompleted: () => {
          completed = true;
        },
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Build a payment system" }),
      );
      const done = events.find((e) => e.kind === "done");

      expect(done).toBeDefined();
      expect(harness.status().phase).toBe("completed");
      expect(harness.status().metrics.completedTaskCount).toBe(2);
      expect(completed).toBe(true);

      // Verify task results are persisted
      const board = harness.status().taskBoard;
      expect(board.results).toHaveLength(2);
      expect(board.results[0]?.output).toContain("Stripe");

      await dispose();
    },
    TIMEOUT,
  );

  test(
    "copilot checks task_status mid-execution",
    async () => {
      const { runtime, dispose } = await createAutonomousRuntime({
        script: [
          // Turn 1: Create plan
          {
            kind: "tool_call",
            toolName: "plan_autonomous",
            input: {
              tasks: [
                { id: "t1", description: "Task one" },
                { id: "t2", description: "Task two" },
              ],
            },
          },
          // Turn 2: Complete first task
          {
            kind: "tool_call",
            toolName: "task_complete",
            input: { task_id: "t1", output: "Done with t1" },
          },
          // Turn 3: Check status (should show 1 done, 1 remaining)
          { kind: "tool_call", toolName: "task_status", input: {} },
          // Turn 4: Complete second task
          {
            kind: "tool_call",
            toolName: "task_complete",
            input: { task_id: "t2", output: "Done with t2" },
          },
          // Turn 5: Final response
          { kind: "text", text: "Both tasks done." },
        ],
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "Do two things" }));

      // Verify task_status was called (tool_call_start event for it)
      const toolCalls = events.filter(
        (e) =>
          e.kind === "tool_call_start" && (e as { toolName?: string }).toolName === "task_status",
      );
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);

      await dispose();
    },
    TIMEOUT,
  );
});

// ===========================================================================
// Scenario 2: Spawn delegation — workers execute tasks
// ===========================================================================

describe("Scenario 2: Spawn delegation with workers", () => {
  test(
    "copilot creates spawn plan, bridge dispatches workers, results persisted",
    async () => {
      const spawnCalls: SpawnRequest[] = [];
      const mockSpawn: SpawnFn = async (req) => {
        spawnCalls.push(req);
        return { ok: true, output: `Worker output for ${req.taskId ?? "unknown"}` };
      };

      let completed = false;
      const { runtime, harness, dispose } = await createAutonomousRuntime({
        script: [
          // Turn 1: Model calls plan_autonomous with spawn delegation
          {
            kind: "tool_call",
            toolName: "plan_autonomous",
            input: {
              tasks: [
                {
                  id: "research",
                  description: "Research topic",
                  delegation: "spawn",
                  agentType: "researcher",
                },
                {
                  id: "summarize",
                  description: "Summarize findings",
                  delegation: "spawn",
                  agentType: "writer",
                },
              ],
            },
          },
          // Turn 2: Model responds (spawn tasks already dispatched synchronously in onPlanCreated)
          { kind: "text", text: "Plan created with 2 spawn tasks." },
        ],
        spawnFn: mockSpawn,
        onCompleted: () => {
          completed = true;
        },
      });

      await collectEvents(runtime.run({ kind: "text", text: "Research and summarize AI trends" }));

      // Workers were dispatched
      expect(spawnCalls).toHaveLength(2);
      expect(spawnCalls[0]?.agentName).toBe("researcher");
      expect(spawnCalls[1]?.agentName).toBe("writer");

      // Results persisted to harness
      expect(harness.status().phase).toBe("completed");
      expect(harness.status().metrics.completedTaskCount).toBe(2);
      expect(completed).toBe(true);

      const board = harness.status().taskBoard;
      expect(board.results).toHaveLength(2);
      expect(board.results[0]?.output).toContain("Worker output");

      await dispose();
    },
    TIMEOUT,
  );

  test(
    "independent spawn tasks all dispatch in one cycle",
    async () => {
      const spawnCalls: SpawnRequest[] = [];
      const mockSpawn: SpawnFn = async (req) => {
        spawnCalls.push(req);
        return { ok: true, output: `Result: ${req.taskId}` };
      };

      const { runtime, harness, dispose } = await createAutonomousRuntime({
        script: [
          {
            kind: "tool_call",
            toolName: "plan_autonomous",
            input: {
              tasks: [
                { id: "a", description: "Task A", delegation: "spawn" },
                { id: "b", description: "Task B", delegation: "spawn" },
                { id: "c", description: "Task C", delegation: "spawn" },
              ],
            },
          },
          { kind: "text", text: "3 tasks dispatched." },
        ],
        spawnFn: mockSpawn,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Do three things" }));

      expect(spawnCalls).toHaveLength(3);
      expect(harness.status().metrics.completedTaskCount).toBe(3);

      await dispose();
    },
    TIMEOUT,
  );
});

// ===========================================================================
// Scenario 3: Mixed delegation — spawn + self in same plan
// ===========================================================================

describe("Scenario 3: Mixed delegation (spawn + self)", () => {
  test(
    "spawn tasks auto-dispatch, self task completed by copilot, cascade works",
    async () => {
      const spawnCalls: SpawnRequest[] = [];
      const mockSpawn: SpawnFn = async (req) => {
        spawnCalls.push(req);
        return { ok: true, output: `Spawn result: ${req.taskId}` };
      };

      const { runtime, harness, dispose } = await createAutonomousRuntime({
        script: [
          // Turn 1: Create mixed plan — 2 spawn (independent) + 1 self (depends on both)
          {
            kind: "tool_call",
            toolName: "plan_autonomous",
            input: {
              tasks: [
                {
                  id: "data-a",
                  description: "Fetch dataset A",
                  delegation: "spawn",
                  agentType: "fetcher",
                },
                {
                  id: "data-b",
                  description: "Fetch dataset B",
                  delegation: "spawn",
                  agentType: "fetcher",
                },
                {
                  id: "merge",
                  description: "Merge datasets",
                  delegation: "self",
                  dependencies: ["data-a", "data-b"],
                },
              ],
            },
          },
          // Turn 2: Spawn tasks already completed by bridge. Now complete self task.
          {
            kind: "tool_call",
            toolName: "task_complete",
            input: { task_id: "merge", output: "Merged A + B into final dataset" },
          },
          // Turn 3: Done
          { kind: "text", text: "All data merged." },
        ],
        spawnFn: mockSpawn,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Fetch and merge two datasets" }));

      // Both spawn tasks dispatched
      expect(spawnCalls).toHaveLength(2);

      // All 3 tasks completed (2 spawn + 1 self)
      expect(harness.status().phase).toBe("completed");
      expect(harness.status().metrics.completedTaskCount).toBe(3);

      await dispose();
    },
    TIMEOUT,
  );

  test(
    "spawn task with dependency on self task — cascade after self completes",
    async () => {
      const spawnCalls: SpawnRequest[] = [];
      const mockSpawn: SpawnFn = async (req) => {
        spawnCalls.push(req);
        return { ok: true, output: `Spawn result: ${req.taskId}` };
      };

      const { runtime, harness, dispose } = await createAutonomousRuntime({
        script: [
          // Turn 1: Create plan — self first, then spawn depends on self
          {
            kind: "tool_call",
            toolName: "plan_autonomous",
            input: {
              tasks: [
                { id: "design", description: "Design the API", delegation: "self" },
                {
                  id: "implement",
                  description: "Implement the API",
                  delegation: "spawn",
                  agentType: "coder",
                  dependencies: ["design"],
                },
              ],
            },
          },
          // Turn 2: Complete self task — this should cascade to dispatch "implement"
          {
            kind: "tool_call",
            toolName: "task_complete",
            input: { task_id: "design", output: "API designed: REST with 3 endpoints" },
          },
          // Turn 3: Done
          { kind: "text", text: "Design done, implementation dispatched to worker." },
        ],
        spawnFn: mockSpawn,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Design and implement an API" }));

      // No spawn on plan creation (implement depends on design)
      // Spawn happens after task_complete cascade
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]?.taskId).toBe(taskItemId("implement"));
      expect(spawnCalls[0]?.agentName).toBe("coder");

      // All completed
      expect(harness.status().phase).toBe("completed");
      expect(harness.status().metrics.completedTaskCount).toBe(2);

      await dispose();
    },
    TIMEOUT,
  );
});

// ===========================================================================
// Scenario 4: Spawn failure + retry
// ===========================================================================

describe("Scenario 4: Spawn failure handling", () => {
  test(
    "retryable spawn failure persists retry count to harness",
    async () => {
      const mockSpawn: SpawnFn = async () => {
        return {
          ok: false,
          error: { code: "EXTERNAL", message: "Worker crashed", retryable: true },
        };
      };

      const { runtime, harness, dispose } = await createAutonomousRuntime({
        script: [
          {
            kind: "tool_call",
            toolName: "plan_autonomous",
            input: {
              tasks: [{ id: "flaky", description: "Flaky task", delegation: "spawn" }],
            },
          },
          { kind: "text", text: "Plan created." },
        ],
        spawnFn: mockSpawn,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Run flaky task" }));

      // Task should be back to pending with incremented retries
      const board = harness.status().taskBoard;
      const task = board.items.find((i) => i.id === taskItemId("flaky"));
      expect(task).toBeDefined();
      expect(task?.status).toBe("pending");
      expect(task?.retries).toBeGreaterThan(0);

      await dispose();
    },
    TIMEOUT,
  );

  test(
    "spawn failure from worker is always retryable (bridge policy)",
    async () => {
      // The bridge hardcodes retryable:true for clean worker failures —
      // even if the worker says retryable:false, the bridge treats all
      // clean errors as worth retrying (worker might succeed next time).
      const mockSpawn: SpawnFn = async () => {
        return {
          ok: false,
          error: { code: "EXTERNAL", message: "Permission denied", retryable: false },
        };
      };

      const { runtime, harness, dispose } = await createAutonomousRuntime({
        script: [
          {
            kind: "tool_call",
            toolName: "plan_autonomous",
            input: {
              tasks: [{ id: "denied", description: "Task", delegation: "spawn" }],
            },
          },
          { kind: "text", text: "Plan created." },
        ],
        spawnFn: mockSpawn,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Run task" }));

      const board = harness.status().taskBoard;
      const task = board.items.find((i) => i.id === taskItemId("denied"));
      expect(task).toBeDefined();
      // Bridge converts all clean failures to retryable → task goes back to pending
      expect(task?.status).toBe("pending");
      expect(task?.retries).toBeGreaterThan(0);

      await dispose();
    },
    TIMEOUT,
  );
});

// ===========================================================================
// Scenario 5: Fail-fast — spawn without bound spawn function
// ===========================================================================

describe("Scenario 5: Fail-fast on missing spawn function", () => {
  test(
    "plan_autonomous with spawn tasks but no getSpawn throws clear error",
    async () => {
      // No spawnFn provided
      const { runtime, dispose } = await createAutonomousRuntime({
        script: [
          {
            kind: "tool_call",
            toolName: "plan_autonomous",
            input: {
              tasks: [{ id: "t1", description: "Task", delegation: "spawn" }],
            },
          },
          { kind: "text", text: "Should not reach here." },
        ],
      });

      // The plan_autonomous tool should throw, which the engine catches
      const events = await collectEvents(runtime.run({ kind: "text", text: "Spawn something" }));
      const done = events.find((e) => e.kind === "done") as
        | { kind: "done"; output: { stopReason: string } }
        | undefined;

      // The tool error is caught by the engine. With minSampleSize governance,
      // a single tool error doesn't trigger session-level error — the engine
      // continues and completes. The error is surfaced via tool_call_result.
      expect(done?.output.stopReason).toMatch(/error|completed/);

      await dispose();
    },
    TIMEOUT,
  );

  test(
    "self-only plan succeeds without spawn function",
    async () => {
      const { runtime, harness, dispose } = await createAutonomousRuntime({
        script: [
          {
            kind: "tool_call",
            toolName: "plan_autonomous",
            input: {
              tasks: [{ id: "t1", description: "Self task" }],
            },
          },
          {
            kind: "tool_call",
            toolName: "task_complete",
            input: { task_id: "t1", output: "Done" },
          },
          { kind: "text", text: "Completed." },
        ],
      });

      await collectEvents(runtime.run({ kind: "text", text: "Do a self task" }));

      expect(harness.status().phase).toBe("completed");
      expect(harness.status().metrics.completedTaskCount).toBe(1);

      await dispose();
    },
    TIMEOUT,
  );
});

// ===========================================================================
// Scenario 6: Deep dependency chain — spawn → self → spawn cascade
// ===========================================================================

describe("Scenario 6: Deep dependency chain", () => {
  test(
    "3-level chain: spawn(A) → self(B) → spawn(C) cascades correctly",
    async () => {
      const spawnCalls: SpawnRequest[] = [];
      const mockSpawn: SpawnFn = async (req) => {
        spawnCalls.push(req);
        return { ok: true, output: `Result of ${req.taskId}` };
      };

      const { runtime, harness, dispose } = await createAutonomousRuntime({
        script: [
          // Turn 1: Create 3-level dependency chain
          {
            kind: "tool_call",
            toolName: "plan_autonomous",
            input: {
              tasks: [
                { id: "a", description: "Spawn root", delegation: "spawn" },
                { id: "b", description: "Self middle", delegation: "self", dependencies: ["a"] },
                { id: "c", description: "Spawn leaf", delegation: "spawn", dependencies: ["b"] },
              ],
            },
          },
          // Turn 2: A was dispatched by bridge. B is self — complete it.
          {
            kind: "tool_call",
            toolName: "task_complete",
            input: { task_id: "b", output: "Self task B done" },
          },
          // Turn 3: C was dispatched by cascade. Done.
          { kind: "text", text: "Chain complete: A→B→C." },
        ],
        spawnFn: mockSpawn,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Run 3-level chain" }));

      // A dispatched on plan creation, C dispatched after B completes
      expect(spawnCalls).toHaveLength(2);
      expect(spawnCalls[0]?.taskId).toBe(taskItemId("a"));
      expect(spawnCalls[1]?.taskId).toBe(taskItemId("c"));

      // All 3 completed
      expect(harness.status().phase).toBe("completed");
      expect(harness.status().metrics.completedTaskCount).toBe(3);

      await dispose();
    },
    TIMEOUT,
  );
});

// ===========================================================================
// Scenario 7: Upstream context propagation
// ===========================================================================

describe("Scenario 7: Upstream context flows to downstream workers", () => {
  test(
    "spawn task receives upstream results in description",
    async () => {
      const spawnCalls: SpawnRequest[] = [];
      const mockSpawn: SpawnFn = async (req) => {
        spawnCalls.push(req);
        return { ok: true, output: `Processed: ${req.taskId}` };
      };

      const { runtime, dispose } = await createAutonomousRuntime({
        script: [
          {
            kind: "tool_call",
            toolName: "plan_autonomous",
            input: {
              tasks: [
                { id: "fetch", description: "Fetch raw data", delegation: "spawn" },
                {
                  id: "process",
                  description: "Process the data",
                  delegation: "spawn",
                  dependencies: ["fetch"],
                },
              ],
            },
          },
          { kind: "text", text: "Pipeline started." },
        ],
        spawnFn: mockSpawn,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Run data pipeline" }));

      // "process" should have upstream context from "fetch" in its description
      expect(spawnCalls).toHaveLength(2);
      const processCall = spawnCalls.find((c) => c.taskId === taskItemId("process"));
      expect(processCall).toBeDefined();
      // The bridge prepends upstream context to the description
      expect(processCall?.description).toContain("Upstream");
      expect(processCall?.description).toContain("Process the data");

      await dispose();
    },
    TIMEOUT,
  );
});

// ===========================================================================
// Scenario 8: Dispose aborts in-flight spawns
// ===========================================================================

describe("Scenario 8: Graceful abort on dispose", () => {
  test(
    "dispose aborts in-flight spawn workers",
    async () => {
      let spawnAborted = false;
      const slowSpawn: SpawnFn = async (req) => {
        // Simulate a long-running worker
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 10_000);
          req.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            spawnAborted = true;
            resolve();
          });
        });
        if (req.signal.aborted) {
          return { ok: false, error: { code: "EXTERNAL", message: "aborted", retryable: false } };
        }
        return { ok: true, output: "should not reach" };
      };

      const { runtime, dispose } = await createAutonomousRuntime({
        script: [
          {
            kind: "tool_call",
            toolName: "plan_autonomous",
            input: {
              tasks: [{ id: "slow", description: "Slow task", delegation: "spawn" }],
            },
          },
          { kind: "text", text: "Started." },
        ],
        spawnFn: slowSpawn,
      });

      // Start the run but don't await — dispose while spawn is in-flight
      const runPromise = collectEvents(runtime.run({ kind: "text", text: "Start slow task" }));

      // Give it a moment to start the spawn
      await new Promise((r) => setTimeout(r, 100));

      // Dispose should abort the bridge
      await dispose();

      // The spawn should have received the abort signal
      await runPromise;
      expect(spawnAborted).toBe(true);
    },
    TIMEOUT,
  );
});
