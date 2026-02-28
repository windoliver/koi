/**
 * Orchestrator end-to-end validation through createKoi + createLoopAdapter.
 *
 * Tests the full L1 runtime path — middleware chain, tool resolution,
 * lifecycle hooks, and immutable board state transitions — with real
 * orchestrator tools and a two-phase model handler (deterministic tool
 * calls + real Anthropic LLM final answer).
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1 — tests are skipped when either is not set.
 *
 * Run:
 *   E2E_TESTS=1 bun test tests/e2e/orchestrator-e2e.test.ts
 *
 * Cost: ~$0.05-0.10 per run (haiku model, 5 minimal prompts).
 */

import { describe, expect, test } from "bun:test";
import type {
  ComponentProvider,
  EngineEvent,
  JsonObject,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  TaskBoardEvent,
  Tool,
  ToolHandler,
  ToolRequest,
} from "@koi/core";
import { toolToken } from "@koi/core/ecs";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import type { BoardHolder, OrchestratorConfig } from "@koi/orchestrator";
import {
  createTaskBoard,
  executeAssignWorker,
  executeOrchestrate,
  executeSynthesize,
} from "@koi/orchestrator";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeOrch = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 90_000;
const MODEL_NAME = "claude-haiku-4-5-20251001";

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

function createHolder(onEvent?: (event: TaskBoardEvent) => void): BoardHolder {
  // let justified: mutable board reference
  let board = createTaskBoard({ maxRetries: 3, onEvent });
  return {
    getBoard: () => board,
    setBoard: (b) => {
      board = b;
    },
  };
}

/**
 * Creates proper Tool objects (with descriptor.inputSchema) from orchestrator
 * execute functions. The engine's tool discovery expects this shape.
 */
function createOrchestratorTools(
  holder: BoardHolder,
  config: OrchestratorConfig,
  signal: AbortSignal,
): readonly Tool[] {
  return [
    {
      descriptor: {
        name: "orchestrate",
        description:
          "Manage the task board: add tasks with dependencies, query board status, or update tasks.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", description: "add | query | update" },
            tasks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  description: { type: "string" },
                  dependencies: { type: "array", items: { type: "string" } },
                  priority: { type: "number" },
                },
                required: ["id", "description"],
              },
            },
            taskId: { type: "string" },
            patch: { type: "object" },
            view: { type: "string" },
          },
          required: ["action"],
        },
      },
      trustTier: "sandbox",
      execute: async (args: JsonObject) => executeOrchestrate(args, holder),
    },
    {
      descriptor: {
        name: "assign_worker",
        description: "Assign a ready task to a worker agent.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "The task ID to assign" },
          },
          required: ["task_id"],
        },
      },
      trustTier: "sandbox",
      execute: async (args: JsonObject) => executeAssignWorker(args, holder, config, signal),
    },
    {
      descriptor: {
        name: "synthesize",
        description: "Synthesize all completed task results into a final output.",
        inputSchema: {
          type: "object",
          properties: {
            format: { type: "string", description: "summary | detailed | structured" },
          },
        },
      },
      trustTier: "sandbox",
      execute: async (args: JsonObject) => executeSynthesize(args, holder, 5000),
    },
  ];
}

function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-orchestrator-tools",
    attach: async () => {
      const components = new Map<string, unknown>();
      for (const tool of tools) {
        components.set(toolToken(tool.descriptor.name), tool);
      }
      return components;
    },
  };
}

// Lazy singleton for the Anthropic adapter (avoids re-creation per call)
// let justified: lazily initialized on first real LLM call
let cachedAnthropicAdapter:
  | { readonly complete: (request: ModelRequest) => Promise<ModelResponse> }
  | undefined;

async function getAnthropicAdapter(): Promise<{
  readonly complete: (request: ModelRequest) => Promise<ModelResponse>;
}> {
  if (cachedAnthropicAdapter === undefined) {
    const { createAnthropicAdapter } = await import("@koi/model-router");
    cachedAnthropicAdapter = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
  }
  return cachedAnthropicAdapter;
}

/**
 * Creates a two-phase model handler: deterministic tool calls followed by
 * a real Anthropic LLM call for the final answer.
 */
function createPhasedModelHandler(phases: readonly ModelResponse[]): {
  readonly modelCall: (request: ModelRequest) => Promise<ModelResponse>;
  readonly callCount: () => number;
} {
  // let justified: mutable counter tracking which phase we're in
  let count = 0;
  return {
    modelCall: async (request: ModelRequest): Promise<ModelResponse> => {
      const phase = count;
      count++;
      if (phase < phases.length) {
        const handler = phases[phase];
        if (handler !== undefined) return handler;
      }
      // Final phase: real Anthropic LLM call
      const anthropic = await getAnthropicAdapter();
      return anthropic.complete({ ...request, model: MODEL_NAME, maxTokens: 100 });
    },
    callCount: () => count,
  };
}

function createToolObserver(): {
  readonly middleware: KoiMiddleware;
  readonly interceptedToolIds: readonly string[];
} {
  const intercepted: string[] = []; // let justified: test accumulator
  return {
    middleware: {
      name: "e2e-orch-tool-observer",
      wrapToolCall: async (_ctx, request: ToolRequest, next: ToolHandler) => {
        intercepted.push(request.toolId);
        return next(request);
      },
    },
    interceptedToolIds: intercepted,
  };
}

/** Deterministic model response that calls a tool. */
function toolCallResponse(toolName: string, callId: string, input: JsonObject): ModelResponse {
  return {
    content: "",
    model: MODEL_NAME,
    usage: { inputTokens: 10, outputTokens: 15 },
    metadata: {
      toolCalls: [{ toolName, callId, input }],
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeOrch("e2e: orchestrator through createKoi + createLoopAdapter", () => {
  // ---------------------------------------------------------------------------
  // Test 1: Full loop — add → assign → complete → synthesize with onEvent
  // ---------------------------------------------------------------------------
  test(
    "full loop: add → assign → complete → synthesize with onEvent",
    async () => {
      const boardEvents: TaskBoardEvent[] = []; // let justified: test accumulator
      const holder = createHolder((event) => boardEvents.push(event));

      const config: OrchestratorConfig = {
        spawn: async (req) => ({ ok: true, output: `result-${req.taskId}` }),
      };
      const controller = new AbortController();
      const tools = createOrchestratorTools(holder, config, controller.signal);
      const toolProvider = createToolProvider(tools);
      const observer = createToolObserver();

      const phases: ModelResponse[] = [
        // Phase 1: add two tasks (b depends on a)
        toolCallResponse("orchestrate", "call-1", {
          action: "add",
          tasks: [
            { id: "a", description: "Task A" },
            { id: "b", description: "Task B", dependencies: ["a"] },
          ],
        }),
        // Phase 2: assign task a
        toolCallResponse("assign_worker", "call-2", { task_id: "a" }),
        // Phase 3: assign task b (now ready since a completed)
        toolCallResponse("assign_worker", "call-3", { task_id: "b" }),
        // Phase 4: synthesize
        toolCallResponse("synthesize", "call-4", {}),
      ];

      const { modelCall, callCount } = createPhasedModelHandler(phases);

      const adapter = createLoopAdapter({ modelCall, maxTurns: 10 });

      const runtime = await createKoi({
        manifest: { name: "e2e-orch-full-loop", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [observer.middleware],
        providers: [toolProvider],
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Execute the orchestration plan" }),
        );

        // Done event with completed status
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // onEvent collected the expected board events
        const addedEvents = boardEvents.filter((e) => e.kind === "task:added");
        expect(addedEvents.length).toBe(2);

        const assignedEvents = boardEvents.filter((e) => e.kind === "task:assigned");
        expect(assignedEvents.length).toBe(2);

        const completedEvents = boardEvents.filter((e) => e.kind === "task:completed");
        expect(completedEvents.length).toBe(2);

        // wrapToolCall middleware observed all 4 tool calls
        expect(observer.interceptedToolIds).toContain("orchestrate");
        expect(observer.interceptedToolIds).toContain("assign_worker");
        expect(observer.interceptedToolIds).toContain("synthesize");
        expect(observer.interceptedToolIds.length).toBe(4);

        // Real LLM was called for the final response (phase 5)
        expect(callCount()).toBeGreaterThanOrEqual(5);
      } finally {
        controller.abort();
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------
  // Test 2: update() applies patch through L1 middleware
  // ---------------------------------------------------------------------------
  test(
    "update() applies patch through L1 middleware",
    async () => {
      const holder = createHolder();

      const config: OrchestratorConfig = {
        spawn: async (req) => ({ ok: true, output: `result-${req.taskId}` }),
      };
      const controller = new AbortController();
      const tools = createOrchestratorTools(holder, config, controller.signal);
      const toolProvider = createToolProvider(tools);
      const observer = createToolObserver();

      const phases: ModelResponse[] = [
        // Phase 1: add a task with priority 0
        toolCallResponse("orchestrate", "call-1", {
          action: "add",
          tasks: [{ id: "x", description: "Task X", priority: 0 }],
        }),
        // Phase 2: update the task's priority to 10
        toolCallResponse("orchestrate", "call-2", {
          action: "update",
          taskId: "x",
          patch: { priority: 10 },
        }),
        // Phase 3: query ready tasks
        toolCallResponse("orchestrate", "call-3", {
          action: "query",
          view: "ready",
        }),
      ];

      const { modelCall } = createPhasedModelHandler(phases);

      const adapter = createLoopAdapter({ modelCall, maxTurns: 10 });

      const runtime = await createKoi({
        manifest: { name: "e2e-orch-update", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [observer.middleware],
        providers: [toolProvider],
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Update the task priority" }),
        );

        // Done event
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();

        // wrapToolCall saw 3 orchestrate calls
        const orchestrateCalls = observer.interceptedToolIds.filter((id) => id === "orchestrate");
        expect(orchestrateCalls.length).toBe(3);

        // Tool results contain the update confirmation
        const toolEndEvents = events.filter((e) => e.kind === "tool_call_end");
        const updateResult = toolEndEvents.find(
          (e) => e.kind === "tool_call_end" && String(e.result).includes("priority=10"),
        );
        expect(updateResult).toBeDefined();
      } finally {
        controller.abort();
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------
  // Test 3: unreachable() cascade failure detected through L1
  // ---------------------------------------------------------------------------
  test(
    "unreachable() cascade failure detected through L1",
    async () => {
      const boardEvents: TaskBoardEvent[] = []; // let justified: test accumulator
      const holder = createHolder((event) => boardEvents.push(event));

      const config: OrchestratorConfig = {
        spawn: async () => ({
          ok: false,
          error: { code: "EXTERNAL", message: "worker crashed", retryable: false },
        }),
        maxRetries: 1,
      };
      const controller = new AbortController();
      const tools = createOrchestratorTools(holder, config, controller.signal);
      const toolProvider = createToolProvider(tools);
      const observer = createToolObserver();

      const phases: ModelResponse[] = [
        // Phase 1: add 3 tasks in a chain
        toolCallResponse("orchestrate", "call-1", {
          action: "add",
          tasks: [
            { id: "root", description: "Root task" },
            { id: "child", description: "Child task", dependencies: ["root"] },
            { id: "grandchild", description: "Grandchild task", dependencies: ["child"] },
          ],
        }),
        // Phase 2: assign root → fails permanently
        toolCallResponse("assign_worker", "call-2", { task_id: "root" }),
        // Phase 3: query summary to check unreachable status
        toolCallResponse("orchestrate", "call-3", {
          action: "query",
          view: "summary",
        }),
      ];

      const { modelCall } = createPhasedModelHandler(phases);

      const adapter = createLoopAdapter({ modelCall, maxTurns: 10 });

      const runtime = await createKoi({
        manifest: { name: "e2e-orch-unreachable", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [observer.middleware],
        providers: [toolProvider],
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Run the task chain" }),
        );

        // Done event
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();

        // onEvent has task:failed for "root"
        const failedEvents = boardEvents.filter((e) => e.kind === "task:failed");
        expect(failedEvents.length).toBeGreaterThanOrEqual(1);
        const rootFailed = failedEvents.find(
          (e) => e.kind === "task:failed" && e.taskId === "root",
        );
        expect(rootFailed).toBeDefined();

        // Summary contains "Unreachable: 2" and "blocked by root"
        const toolEndEvents = events.filter((e) => e.kind === "tool_call_end");
        const summaryResult = toolEndEvents.find(
          (e) => e.kind === "tool_call_end" && String(e.result).includes("Unreachable: 2"),
        );
        expect(summaryResult).toBeDefined();
        if (summaryResult?.kind === "tool_call_end") {
          expect(String(summaryResult.result)).toContain("blocked by root");
        }
      } finally {
        controller.abort();
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------
  // Test 4: maxDurationMs abort signal check in assign_worker
  // ---------------------------------------------------------------------------
  test(
    "maxDurationMs abort signal prevents spawn",
    async () => {
      // let justified: tracks whether spawn was called
      let spawnCalled = false;
      const holder = createHolder();

      const config: OrchestratorConfig = {
        spawn: async () => {
          spawnCalled = true;
          return { ok: true, output: "should not happen" };
        },
      };

      // Pre-aborted signal simulates maxDurationMs timeout
      const controller = new AbortController();
      controller.abort("orchestration timeout");
      const tools = createOrchestratorTools(holder, config, controller.signal);
      const toolProvider = createToolProvider(tools);
      const observer = createToolObserver();

      const phases: ModelResponse[] = [
        // Phase 1: add a task
        toolCallResponse("orchestrate", "call-1", {
          action: "add",
          tasks: [{ id: "a", description: "Task A" }],
        }),
        // Phase 2: assign → should get "timed out" response
        toolCallResponse("assign_worker", "call-2", { task_id: "a" }),
      ];

      const { modelCall } = createPhasedModelHandler(phases);

      const adapter = createLoopAdapter({ modelCall, maxTurns: 10 });

      const runtime = await createKoi({
        manifest: { name: "e2e-orch-timeout", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [observer.middleware],
        providers: [toolProvider],
      });

      try {
        const events = await collectEvents(runtime.run({ kind: "text", text: "Assign a task" }));

        // Done event
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();

        // Tool result contains "timed out"
        const toolEndEvents = events.filter((e) => e.kind === "tool_call_end");
        const timedOutResult = toolEndEvents.find(
          (e) => e.kind === "tool_call_end" && String(e.result).toLowerCase().includes("timed out"),
        );
        expect(timedOutResult).toBeDefined();

        // Spawn was never called
        expect(spawnCalled).toBe(false);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------
  // Test 5: Deterministic orchestrate tool call + real LLM summarizes result
  // ---------------------------------------------------------------------------
  test(
    "real LLM summarizes orchestrator tool result",
    async () => {
      const boardEvents: TaskBoardEvent[] = []; // let justified: test accumulator
      const holder = createHolder((event) => boardEvents.push(event));

      const config: OrchestratorConfig = {
        spawn: async () => ({ ok: true, output: "greeting done" }),
      };
      const controller = new AbortController();
      const tools = createOrchestratorTools(holder, config, controller.signal);
      const toolProvider = createToolProvider(tools);
      const observer = createToolObserver();

      // Phase 1: deterministic orchestrate call, Phase 2: real LLM
      const phases: ModelResponse[] = [
        toolCallResponse("orchestrate", "call-1", {
          action: "add",
          tasks: [{ id: "greeting", description: "Say hello" }],
        }),
      ];

      const { modelCall } = createPhasedModelHandler(phases);

      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: { name: "e2e-orch-real-llm", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [observer.middleware],
        providers: [toolProvider],
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "Add a greeting task to the board, then summarize what you did.",
          }),
        );

        // Done event with completed status
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // wrapToolCall observed the orchestrate call
        expect(observer.interceptedToolIds).toContain("orchestrate");

        // onEvent fired task:added
        const addedEvents = boardEvents.filter((e) => e.kind === "task:added");
        expect(addedEvents.length).toBeGreaterThanOrEqual(1);

        // Real LLM generated text in the final response
        const textEvents = events.filter((e) => e.kind === "text_delta");
        expect(textEvents.length).toBeGreaterThan(0);
      } finally {
        controller.abort();
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});
