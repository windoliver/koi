/**
 * E2E: Delegation consolidation — task-board, delegation-bridge,
 * reconciler-hook, and task tools through the full L1 runtime.
 *
 * Tier 1: Full component integration (simulated model) — validates
 *   task board + delegation bridge + reconciler + task tools + createKoi
 *   with a scripted model that drives tool calls through the engine.
 *
 * Tier 2: Real Anthropic API — validates createKoi + createLoopAdapter
 *   produce correct events with a live LLM call.
 *
 * Tier 3: Full stack — delegation bridge dispatches spawn tasks,
 *   reconciler modifies the board, and results flow through createKoi.
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1 for Tier 2.
 * Tier 1 and Tier 3 always run (no API key needed).
 *
 * Run:
 *   E2E_TESTS=1 bun test tests/e2e/e2e-delegation-consolidation.test.ts
 *
 * Cost: ~$0.01 per run (haiku, minimal prompts, maxTokens: 50).
 */

import { describe, expect, test } from "bun:test";
import type {
  EngineEvent,
  JsonObject,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  SpawnFn,
  SpawnRequest,
  TaskBoard,
  TaskBoardSnapshot,
  TaskReconcileAction,
  TaskReconciler,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { agentId, taskItemId } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createAnthropicAdapter } from "@koi/model-router";
import { createTaskBoard } from "@koi/task-board";
import { createDelegationBridge } from "../../packages/sched/long-running/src/delegation-bridge.js";
import { createReconcilerHook } from "../../packages/sched/long-running/src/reconciler-hook.js";
import { createTaskTools } from "../../packages/sched/long-running/src/task-tools.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_ANTHROPIC = ANTHROPIC_KEY.length > 0;
const E2E_ENABLED = HAS_ANTHROPIC && process.env.E2E_TESTS === "1";
const describeE2E = E2E_ENABLED ? describe : describe.skip;

const MODEL = "claude-haiku-4-5-20251001";
const TIMEOUT = 60_000;

// let justified: lazy singleton — avoids creating adapter when skipped
let anthropic: ReturnType<typeof createAnthropicAdapter> | undefined;
function getAdapter(): ReturnType<typeof createAnthropicAdapter> {
  if (anthropic === undefined) {
    anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
  }
  return anthropic;
}

const realModelCall = (request: ModelRequest): Promise<ModelResponse> =>
  getAdapter().complete({ ...request, model: MODEL, maxTokens: 50 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const result: EngineEvent[] = []; // let justified: test accumulator
  for await (const event of iterable) {
    result.push(event);
  }
  return result;
}

/**
 * Creates a scripted model call that returns tool_use blocks in sequence.
 * Each entry in `script` is either a tool call or a text response.
 */
function createScriptedModelCall(
  script: ReadonlyArray<
    | { readonly kind: "tool_call"; readonly toolName: string; readonly input: JsonObject }
    | { readonly kind: "text"; readonly text: string }
  >,
): ModelRequest[] & { modelCall: (req: ModelRequest) => Promise<ModelResponse> } {
  const requests: ModelRequest[] = [];
  // let justified: mutable counter for script progression
  let callIndex = 0;

  const modelCall = async (req: ModelRequest): Promise<ModelResponse> => {
    requests.push(req);
    const step = script[callIndex];
    callIndex += 1;

    if (step === undefined || step.kind === "text") {
      return {
        content: step?.text ?? "Done.",
        model: "scripted",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }

    // Return a tool_use response that the loop adapter will parse
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
  };

  // Attach modelCall as a property for convenience
  return Object.assign(requests, { modelCall });
}

// ===========================================================================
// TIER 1: Full component integration (no real LLM)
// ===========================================================================

describe("Tier 1: delegation consolidation — component integration", () => {
  test("task board round-trips delegation + agentType fields", () => {
    const board = createTaskBoard({ maxRetries: 3 });
    const result = board.addAll([
      {
        id: taskItemId("t1"),
        description: "Research task",
        dependencies: [],
        delegation: "spawn",
        agentType: "researcher",
      },
      {
        id: taskItemId("t2"),
        description: "Self task",
        dependencies: [],
        delegation: "self",
      },
      {
        id: taskItemId("t3"),
        description: "No delegation",
        dependencies: [],
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const t1 = result.value.get(taskItemId("t1"));
    expect(t1?.delegation).toBe("spawn");
    expect(t1?.agentType).toBe("researcher");

    const t2 = result.value.get(taskItemId("t2"));
    expect(t2?.delegation).toBe("self");
    expect(t2?.agentType).toBeUndefined();

    const t3 = result.value.get(taskItemId("t3"));
    expect(t3?.delegation).toBeUndefined();
  });

  test(
    "delegation bridge dispatches spawn tasks and cascades dependencies",
    async () => {
      const spawnLog: SpawnRequest[] = []; // let justified: test accumulator
      const spawn: SpawnFn = async (req) => {
        spawnLog.push(req);
        return { ok: true, output: `Result of ${req.taskId}` };
      };

      const board = createTaskBoard({ maxRetries: 3 });
      const addResult = board.addAll([
        { id: taskItemId("a"), description: "First", dependencies: [], delegation: "spawn" },
        {
          id: taskItemId("b"),
          description: "Second",
          dependencies: [taskItemId("a")],
          delegation: "spawn",
        },
        {
          id: taskItemId("c"),
          description: "Third",
          dependencies: [taskItemId("b")],
          delegation: "spawn",
        },
      ]);
      expect(addResult.ok).toBe(true);
      if (!addResult.ok) return;

      const bridge = createDelegationBridge({ spawn, maxConcurrency: 2 });
      const finalBoard = await bridge.dispatchReady(addResult.value);

      // All 3 tasks dispatched and completed via cascade
      expect(spawnLog).toHaveLength(3);
      expect(finalBoard.get(taskItemId("a"))?.status).toBe("completed");
      expect(finalBoard.get(taskItemId("b"))?.status).toBe("completed");
      expect(finalBoard.get(taskItemId("c"))?.status).toBe("completed");

      // Upstream context prepended to dependent tasks
      const bReq = spawnLog.find((r) => r.taskId === taskItemId("b"));
      expect(bReq?.description).toContain("Upstream Context");

      // DEFERRED delivery policy
      expect(spawnLog[0]?.delivery?.kind).toBe("deferred");
    },
    TIMEOUT,
  );

  test("delegation bridge handles spawn failure with retry", async () => {
    // let justified: counter for simulating failure then success
    let callCount = 0;
    const spawn: SpawnFn = async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: false,
          error: { code: "EXTERNAL", message: "transient error", retryable: true },
        };
      }
      return { ok: true, output: "success on retry" };
    };

    const board = createTaskBoard({ maxRetries: 3 });
    const addResult = board.add({
      id: taskItemId("retry-task"),
      description: "Retryable task",
      dependencies: [],
      delegation: "spawn",
    });
    expect(addResult.ok).toBe(true);
    if (!addResult.ok) return;

    const bridge = createDelegationBridge({ spawn });

    // First dispatch: fails, task goes back to pending with retries=1
    const afterFail = await bridge.dispatchReady(addResult.value);
    const failedItem = afterFail.get(taskItemId("retry-task"));
    expect(failedItem?.status).toBe("pending");
    expect(failedItem?.retries).toBe(1);

    // Second dispatch: succeeds
    const afterRetry = await bridge.dispatchReady(afterFail);
    expect(afterRetry.get(taskItemId("retry-task"))?.status).toBe("completed");
  });

  test("delegation bridge handles abnormal failure with backoff context", async () => {
    const spawn: SpawnFn = async () => {
      throw new Error("kaboom");
    };

    const board = createTaskBoard({ maxRetries: 3 });
    const addResult = board.add({
      id: taskItemId("crash-task"),
      description: "Crashing task",
      dependencies: [],
      delegation: "spawn",
    });
    expect(addResult.ok).toBe(true);
    if (!addResult.ok) return;

    const bridge = createDelegationBridge({ spawn });
    const result = await bridge.dispatchReady(addResult.value);

    const item = result.get(taskItemId("crash-task"));
    expect(item?.status).toBe("pending");
    expect(item?.retries).toBe(1);
    expect(item?.error?.context?.abnormal).toBe(true);
    expect(item?.error?.context?.backoffMs).toBe(10_000); // 10s * 2^0
  });

  test("reconciler hook applies cancel/update/add actions", async () => {
    const board = createTaskBoard({ maxRetries: 3 });
    const addResult = board.addAll([
      { id: taskItemId("keep"), description: "Keep this", dependencies: [] },
      { id: taskItemId("cancel-me"), description: "Cancel this", dependencies: [] },
      { id: taskItemId("update-me"), description: "Old description", dependencies: [] },
    ]);
    expect(addResult.ok).toBe(true);
    if (!addResult.ok) return;

    const actions: readonly TaskReconcileAction[] = [
      { kind: "cancel", taskId: taskItemId("cancel-me"), reason: "no longer needed" },
      { kind: "update", taskId: taskItemId("update-me"), description: "New description" },
      {
        kind: "add",
        task: { id: taskItemId("new-task"), description: "Dynamically added", dependencies: [] },
      },
    ];

    const hook = createReconcilerHook({
      reconciler: { check: async () => actions },
      intervalTurns: 1,
    });

    expect(hook.shouldCheck(0)).toBe(true);
    expect(hook.shouldCheck(1)).toBe(true);

    const result = await hook.reconcile(addResult.value);

    expect(result.get(taskItemId("cancel-me"))?.status).toBe("failed");
    expect(result.get(taskItemId("cancel-me"))?.error?.message).toContain("no longer needed");
    expect(result.get(taskItemId("update-me"))?.description).toBe("New description");
    expect(result.get(taskItemId("new-task"))?.description).toBe("Dynamically added");
    expect(result.size()).toBe(4);
  });

  test("reconciler hook is fault-tolerant on timeout", async () => {
    const board = createTaskBoard({ maxRetries: 3 });
    const addResult = board.add({
      id: taskItemId("safe"),
      description: "Should survive timeout",
      dependencies: [],
    });
    expect(addResult.ok).toBe(true);
    if (!addResult.ok) return;

    const hook = createReconcilerHook({
      reconciler: {
        check: async () => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return [{ kind: "cancel" as const, taskId: taskItemId("safe"), reason: "late" }];
        },
      },
      timeoutMs: 50,
    });

    const result = await hook.reconcile(addResult.value);
    // Task should be untouched — reconciler timed out
    expect(result.get(taskItemId("safe"))?.status).toBe("pending");
    expect(result.get(taskItemId("safe"))?.description).toBe("Should survive timeout");
  });

  test(
    "task tools work through createKoi with scripted model",
    async () => {
      // Setup a task board with one task
      const board = createTaskBoard({ maxRetries: 3 });
      const addResult = board.add({
        id: taskItemId("e2e-task"),
        description: "E2E test task",
        dependencies: [],
        delegation: "self",
      });
      expect(addResult.ok).toBe(true);
      if (!addResult.ok) return;

      // let justified: board mutated through immutable replacements
      let currentBoard: TaskBoard = addResult.value;

      // Create task tools
      const tools = createTaskTools({
        getTaskBoard: () => ({
          items: currentBoard.all(),
          results: currentBoard.completed(),
        }),
        completeTask: async (id, output) => {
          // Assign first (board requires assigned status before complete)
          const assignResult = currentBoard.assign(id, agentId("e2e-worker"));
          if (assignResult.ok) currentBoard = assignResult.value;
          const result = currentBoard.complete(id, {
            taskId: id,
            output,
            durationMs: 100,
            workerId: agentId("e2e-worker"),
          });
          if (result.ok) currentBoard = result.value;
        },
        updateTask: async (id, description) => {
          const result = currentBoard.update(id, { description });
          if (result.ok) currentBoard = result.value;
        },
      });

      // Build tool handler from task tools
      const toolMap = new Map(tools.map((t) => [t.descriptor.name, t]));
      const toolCall = async (req: ToolRequest): Promise<ToolResponse> => {
        const tool = toolMap.get(req.toolId);
        if (tool === undefined) {
          return { output: { error: `Unknown tool: ${req.toolId}` } };
        }
        const result = await tool.execute(req.input as JsonObject, {});
        return { output: result };
      };

      // Script: model calls task_status, then task_complete, then responds
      const script = createScriptedModelCall([
        { kind: "tool_call", toolName: "task_status", input: {} },
        {
          kind: "tool_call",
          toolName: "task_complete",
          input: { task_id: "e2e-task", output: "Task completed successfully via E2E" },
        },
        { kind: "text", text: "All tasks done." },
      ]);

      const adapter = createLoopAdapter({
        modelCall: script.modelCall,
        toolCall,
        maxTurns: 5,
      });

      const runtime = await createKoi({
        manifest: { name: "e2e-task-tools", version: "0.0.1", model: { name: "scripted" } },
        adapter,
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "Check task status and complete the task.",
          }),
        );

        // Verify done event
        const done = events.find((e) => e.kind === "done");
        expect(done).toBeDefined();
        if (done?.kind === "done") {
          expect(done.output.metrics.turns).toBeGreaterThan(0);
        }

        // Verify tool calls went through
        const toolCalls = events.filter((e) => e.kind === "tool_call_start");
        expect(toolCalls.length).toBeGreaterThanOrEqual(2);

        // Verify task was completed on the board
        expect(currentBoard.get(taskItemId("e2e-task"))?.status).toBe("completed");
        const taskResult = currentBoard.result(taskItemId("e2e-task"));
        expect(taskResult?.output).toBe("Task completed successfully via E2E");
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT,
  );

  test(
    "task_review and task_synthesize work through createKoi",
    async () => {
      const board = createTaskBoard({ maxRetries: 3 });
      const addResult = board.addAll([
        {
          id: taskItemId("research"),
          description: "Research the topic",
          dependencies: [],
          delegation: "self",
        },
        {
          id: taskItemId("write"),
          description: "Write the report",
          dependencies: [taskItemId("research")],
          delegation: "self",
        },
      ]);
      expect(addResult.ok).toBe(true);
      if (!addResult.ok) return;

      // let justified: board mutated through immutable replacements
      let currentBoard: TaskBoard = addResult.value;

      // Pre-complete both tasks so we can review + synthesize
      const c1 = currentBoard.assign(taskItemId("research"), agentId("w1"));
      if (c1.ok) currentBoard = c1.value;
      const c2 = currentBoard.complete(taskItemId("research"), {
        taskId: taskItemId("research"),
        output: "Found 3 key findings about delegation patterns.",
        durationMs: 50,
        workerId: agentId("w1"),
      });
      if (c2.ok) currentBoard = c2.value;

      const c3 = currentBoard.assign(taskItemId("write"), agentId("w2"));
      if (c3.ok) currentBoard = c3.value;
      const c4 = currentBoard.complete(taskItemId("write"), {
        taskId: taskItemId("write"),
        output: "Report drafted with executive summary and recommendations.",
        durationMs: 100,
        workerId: agentId("w2"),
      });
      if (c4.ok) currentBoard = c4.value;

      const tools = createTaskTools({
        getTaskBoard: () => ({
          items: currentBoard.all(),
          results: currentBoard.completed(),
        }),
        completeTask: async () => {},
        updateTask: async () => {},
        failTask: async (id, message) => {
          const result = currentBoard.fail(id, {
            code: "EXTERNAL",
            message,
            retryable: true,
          });
          if (result.ok) {
            currentBoard = result.value;
            return { items: currentBoard.all(), results: currentBoard.completed() };
          }
          return undefined;
        },
      });

      const toolMap = new Map(tools.map((t) => [t.descriptor.name, t]));
      const toolCall = async (req: ToolRequest): Promise<ToolResponse> => {
        const tool = toolMap.get(req.toolId);
        if (tool === undefined) return { output: { error: `Unknown tool: ${req.toolId}` } };
        const result = await tool.execute(req.input as JsonObject, {});
        return { output: result };
      };

      // Script: review research (accept), synthesize results
      const script = createScriptedModelCall([
        {
          kind: "tool_call",
          toolName: "task_review",
          input: { task_id: "research", verdict: "accept" },
        },
        {
          kind: "tool_call",
          toolName: "task_synthesize",
          input: { format: "structured" },
        },
        { kind: "text", text: "Synthesis complete." },
      ]);

      const adapter = createLoopAdapter({
        modelCall: script.modelCall,
        toolCall,
        maxTurns: 5,
      });

      const runtime = await createKoi({
        manifest: { name: "e2e-review-synth", version: "0.0.1", model: { name: "scripted" } },
        adapter,
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Review and synthesize." }),
        );

        const done = events.find((e) => e.kind === "done");
        expect(done).toBeDefined();

        // Verify tool calls executed
        const toolCalls = events.filter((e) => e.kind === "tool_call_start");
        expect(toolCalls.length).toBeGreaterThanOrEqual(2);

        // Verify tool names
        const toolNames = toolCalls.map((e) => (e.kind === "tool_call_start" ? e.toolName : ""));
        expect(toolNames).toContain("task_review");
        expect(toolNames).toContain("task_synthesize");
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT,
  );

  test(
    "full pipeline: board → bridge dispatch → reconciler → tool completion through createKoi",
    async () => {
      // Setup board with mixed delegation
      const board = createTaskBoard({ maxRetries: 3 });
      const addResult = board.addAll([
        {
          id: taskItemId("spawn-a"),
          description: "Spawned research",
          dependencies: [],
          delegation: "spawn",
          agentType: "researcher",
        },
        {
          id: taskItemId("self-b"),
          description: "Self-executed writing",
          dependencies: [taskItemId("spawn-a")],
          delegation: "self",
        },
      ]);
      expect(addResult.ok).toBe(true);
      if (!addResult.ok) return;

      // let justified: board mutated through immutable replacements
      let currentBoard: TaskBoard = addResult.value;

      // Delegation bridge with mock spawn
      const spawnLog: SpawnRequest[] = []; // let justified: test accumulator
      const bridge = createDelegationBridge({
        spawn: async (req) => {
          spawnLog.push(req);
          return { ok: true, output: `Spawned output for ${req.taskId}` };
        },
        onTaskDispatched: () => {},
        onTaskCompleted: () => {},
      });

      // Dispatch spawn tasks
      currentBoard = await bridge.dispatchReady(currentBoard);

      // Verify spawn-a completed, self-b still pending
      expect(currentBoard.get(taskItemId("spawn-a"))?.status).toBe("completed");
      expect(currentBoard.get(taskItemId("self-b"))?.status).toBe("pending");
      expect(spawnLog).toHaveLength(1);
      expect(spawnLog[0]?.agentName).toBe("researcher");

      // Reconciler adds a new task dynamically
      const reconciler: TaskReconciler = {
        check: async () => [
          {
            kind: "add" as const,
            task: {
              id: taskItemId("dynamic-c"),
              description: "Dynamically added by reconciler",
              dependencies: [taskItemId("self-b")],
            },
          },
        ],
      };
      const hook = createReconcilerHook({ reconciler, intervalTurns: 1 });
      currentBoard = await hook.reconcile(currentBoard);
      expect(currentBoard.size()).toBe(3);
      expect(currentBoard.get(taskItemId("dynamic-c"))).toBeDefined();

      // Now drive self-b through createKoi with task tools
      const tools = createTaskTools({
        getTaskBoard: () => ({
          items: currentBoard.all(),
          results: currentBoard.completed(),
        }),
        completeTask: async (id, output) => {
          const assignResult = currentBoard.assign(id, agentId("koi-agent"));
          if (assignResult.ok) currentBoard = assignResult.value;
          const result = currentBoard.complete(id, {
            taskId: id,
            output,
            durationMs: 50,
            workerId: agentId("koi-agent"),
          });
          if (result.ok) currentBoard = result.value;
        },
        updateTask: async (id, description) => {
          const result = currentBoard.update(id, { description });
          if (result.ok) currentBoard = result.value;
        },
      });

      const toolMap = new Map(tools.map((t) => [t.descriptor.name, t]));
      const toolCall = async (req: ToolRequest): Promise<ToolResponse> => {
        const tool = toolMap.get(req.toolId);
        if (tool === undefined) return { output: { error: `Unknown: ${req.toolId}` } };
        const result = await tool.execute(req.input as JsonObject, {});
        return { output: result };
      };

      const script = createScriptedModelCall([
        { kind: "tool_call", toolName: "task_status", input: {} },
        {
          kind: "tool_call",
          toolName: "task_complete",
          input: { task_id: "self-b", output: "Writing complete based on research." },
        },
        {
          kind: "tool_call",
          toolName: "task_complete",
          input: { task_id: "dynamic-c", output: "Dynamic task also done." },
        },
        {
          kind: "tool_call",
          toolName: "task_synthesize",
          input: { format: "summary" },
        },
        { kind: "text", text: "All done." },
      ]);

      const adapter = createLoopAdapter({
        modelCall: script.modelCall,
        toolCall,
        maxTurns: 8,
      });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-full-pipeline",
          version: "0.0.1",
          model: { name: "scripted" },
        },
        adapter,
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Complete remaining tasks and synthesize." }),
        );

        const done = events.find((e) => e.kind === "done");
        expect(done).toBeDefined();

        // All 3 tasks should be completed
        expect(currentBoard.get(taskItemId("spawn-a"))?.status).toBe("completed");
        expect(currentBoard.get(taskItemId("self-b"))?.status).toBe("completed");
        expect(currentBoard.get(taskItemId("dynamic-c"))?.status).toBe("completed");

        // Verify synthesize was called
        const toolCalls = events.filter((e) => e.kind === "tool_call_start");
        const toolNames = toolCalls.map((e) => (e.kind === "tool_call_start" ? e.toolName : ""));
        expect(toolNames).toContain("task_synthesize");
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT,
  );

  test("delegation bridge abort stops in-flight spawns", async () => {
    // let justified: counter for tracking spawn calls
    let spawnCalls = 0;
    const spawn: SpawnFn = async () => {
      spawnCalls += 1;
      // Simulate slow spawn
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { ok: true, output: "done" };
    };

    const board = createTaskBoard({ maxRetries: 3 });
    const addResult = board.add({
      id: taskItemId("abort-task"),
      description: "Will be aborted",
      dependencies: [],
      delegation: "spawn",
    });
    expect(addResult.ok).toBe(true);
    if (!addResult.ok) return;

    const bridge = createDelegationBridge({ spawn });
    bridge.abort();

    const result = await bridge.dispatchReady(addResult.value);
    expect(bridge.inFlightCount()).toBe(0);
    // Task was assigned but spawn saw abort — should not crash
    expect(result).toBeDefined();
    // spawnCalls may be 0 or 1 depending on timing — bridge should not hang
    expect(spawnCalls).toBeLessThanOrEqual(1);
  });

  test("lane semaphore limits per-agent-type concurrency", async () => {
    const concurrencyLog: string[] = []; // let justified: test accumulator
    // let justified: mutable counter for active fast-lane spawns
    let activeFast = 0;
    // let justified: tracks peak concurrency
    let peakFast = 0;

    const spawn: SpawnFn = async (req) => {
      const lane = req.agentName;
      if (lane === "fast") {
        activeFast += 1;
        peakFast = Math.max(peakFast, activeFast);
      }
      concurrencyLog.push(`start:${lane}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      concurrencyLog.push(`end:${lane}`);
      if (lane === "fast") activeFast -= 1;
      return { ok: true, output: `${lane} done` };
    };

    const board = createTaskBoard({ maxRetries: 3 });
    const addResult = board.addAll([
      {
        id: taskItemId("f1"),
        description: "Fast 1",
        dependencies: [],
        delegation: "spawn",
        agentType: "fast",
      },
      {
        id: taskItemId("f2"),
        description: "Fast 2",
        dependencies: [],
        delegation: "spawn",
        agentType: "fast",
      },
      {
        id: taskItemId("s1"),
        description: "Slow 1",
        dependencies: [],
        delegation: "spawn",
        agentType: "slow",
      },
    ]);
    expect(addResult.ok).toBe(true);
    if (!addResult.ok) return;

    const bridge = createDelegationBridge({
      spawn,
      maxConcurrency: 5,
      laneConcurrency: new Map([["fast", 1]]),
    });

    const result = await bridge.dispatchReady(addResult.value);

    // All tasks completed
    expect(result.get(taskItemId("f1"))?.status).toBe("completed");
    expect(result.get(taskItemId("f2"))?.status).toBe("completed");
    expect(result.get(taskItemId("s1"))?.status).toBe("completed");

    // Fast lane peak concurrency should be 1 (limited by lane semaphore)
    expect(peakFast).toBe(1);
  });
});

// ===========================================================================
// TIER 2: Real Anthropic API
// ===========================================================================

describeE2E("Tier 2: delegation consolidation — real Anthropic API", () => {
  test(
    "createKoi + createLoopAdapter produces done event with real LLM",
    async () => {
      const adapter = createLoopAdapter({ modelCall: realModelCall, maxTurns: 1 });
      const runtime = await createKoi({
        manifest: {
          name: "e2e-delegation-real-llm",
          version: "0.0.1",
          model: { name: MODEL },
        },
        adapter,
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Reply with one word: hello" }),
        );

        const done = events.find((e) => e.kind === "done");
        expect(done).toBeDefined();
        if (done?.kind === "done") {
          expect(done.output.metrics.turns).toBeGreaterThan(0);
          expect(done.output.metrics.totalTokens).toBeGreaterThan(0);
        }

        // Should have text_delta events with actual LLM output
        const textDeltas = events.filter((e) => e.kind === "text_delta");
        expect(textDeltas.length).toBeGreaterThan(0);
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT,
  );

  test(
    "middleware chain runs with real LLM + task tools registered",
    async () => {
      const board = createTaskBoard({ maxRetries: 3 });
      const addResult = board.add({
        id: taskItemId("llm-task"),
        description: "LLM integration test",
        dependencies: [],
        delegation: "self",
      });
      expect(addResult.ok).toBe(true);
      if (!addResult.ok) return;

      // let justified: board mutated through immutable replacements
      const currentBoard: TaskBoard = addResult.value;

      // Tracking middleware
      const middlewareLog: string[] = []; // let justified: test accumulator
      const trackingMw: KoiMiddleware = {
        name: "e2e-tracking",
        priority: 100,
        wrapModelCall: async (_ctx, req, next) => {
          middlewareLog.push("model:before");
          const res = await next(req);
          middlewareLog.push("model:after");
          return res;
        },
      };

      const adapter = createLoopAdapter({
        modelCall: realModelCall,
        maxTurns: 1,
      });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-delegation-middleware",
          version: "0.0.1",
          model: { name: MODEL },
        },
        adapter,
        middleware: [trackingMw],
      });

      try {
        const events = await collectEvents(runtime.run({ kind: "text", text: "Say hello." }));

        const done = events.find((e) => e.kind === "done");
        expect(done).toBeDefined();

        // Middleware was invoked
        expect(middlewareLog).toContain("model:before");
        expect(middlewareLog).toContain("model:after");

        // Task board is still intact
        expect(currentBoard.get(taskItemId("llm-task"))?.status).toBe("pending");
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT,
  );
});

// ===========================================================================
// TIER 3: Full stack — bridge + reconciler + tools + real LLM
// ===========================================================================

describeE2E("Tier 3: full stack — delegation bridge + reconciler + real LLM", () => {
  test(
    "spawn dispatch + reconciler + createKoi with real Anthropic call",
    async () => {
      // Build a task board with spawn + self tasks
      const board = createTaskBoard({ maxRetries: 2 });
      const addResult = board.addAll([
        {
          id: taskItemId("spawn-research"),
          description: "Research via spawn",
          dependencies: [],
          delegation: "spawn",
          agentType: "researcher",
        },
        {
          id: taskItemId("self-write"),
          description: "Write report (self)",
          dependencies: [taskItemId("spawn-research")],
          delegation: "self",
        },
      ]);
      expect(addResult.ok).toBe(true);
      if (!addResult.ok) return;

      // let justified: board mutated through immutable replacements
      let currentBoard: TaskBoard = addResult.value;

      // Mock spawn — simulates a worker agent returning results
      const spawnLog: SpawnRequest[] = []; // let justified: test accumulator
      const bridge = createDelegationBridge({
        spawn: async (req) => {
          spawnLog.push(req);
          return { ok: true, output: "Research findings: delegation works well." };
        },
      });

      // Dispatch spawn tasks
      currentBoard = await bridge.dispatchReady(currentBoard);
      expect(currentBoard.get(taskItemId("spawn-research"))?.status).toBe("completed");
      expect(spawnLog).toHaveLength(1);

      // Reconciler — verifies board state, adds no new actions
      const reconcilerChecks: TaskBoardSnapshot[] = []; // let justified: test accumulator
      const hook = createReconcilerHook({
        reconciler: {
          check: async (snapshot) => {
            reconcilerChecks.push(snapshot);
            return [];
          },
        },
        intervalTurns: 1,
      });
      currentBoard = await hook.reconcile(currentBoard);
      expect(reconcilerChecks).toHaveLength(1);
      expect(reconcilerChecks[0]?.items.length).toBe(2);

      // Now run the self task through createKoi with real LLM
      // The LLM just needs to respond (maxTurns: 1, no tool use)
      const adapter = createLoopAdapter({
        modelCall: realModelCall,
        maxTurns: 1,
      });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-full-stack",
          version: "0.0.1",
          model: { name: MODEL },
        },
        adapter,
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "Summarize the research findings about delegation patterns.",
          }),
        );

        const done = events.find((e) => e.kind === "done");
        expect(done).toBeDefined();
        if (done?.kind === "done") {
          expect(done.output.metrics.totalTokens).toBeGreaterThan(0);
        }

        // Complete self-write based on LLM output
        const assignResult = currentBoard.assign(taskItemId("self-write"), agentId("koi"));
        if (assignResult.ok) currentBoard = assignResult.value;

        const textEvents = events.filter((e) => e.kind === "text_delta");
        const llmOutput = textEvents.map((e) => (e.kind === "text_delta" ? e.delta : "")).join("");

        const completeResult = currentBoard.complete(taskItemId("self-write"), {
          taskId: taskItemId("self-write"),
          output: llmOutput.length > 0 ? llmOutput : "LLM generated report.",
          durationMs: 1000,
          workerId: agentId("koi"),
        });
        if (completeResult.ok) currentBoard = completeResult.value;

        // Verify final state
        expect(currentBoard.get(taskItemId("spawn-research"))?.status).toBe("completed");
        expect(currentBoard.get(taskItemId("self-write"))?.status).toBe("completed");

        // Verify result content
        const writeResult = currentBoard.result(taskItemId("self-write"));
        expect(writeResult?.output.length).toBeGreaterThan(0);
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT,
  );
});
