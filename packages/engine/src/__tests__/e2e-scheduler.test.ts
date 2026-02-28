/**
 * E2E: Scheduler provider (pause/resume/history) through full createKoi + createPiAdapter stack.
 *
 * Validates that the scheduler tools are wired correctly through the L1 runtime,
 * middleware chain, and real LLM calls. The agent is given scheduler tools and
 * prompted to use them — verifying the full path from tool descriptor advertisement
 * through tool execution to result formatting.
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-scheduler.test.ts
 *
 * Requires ANTHROPIC_API_KEY in .env (Bun auto-loads it).
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  SchedulerComponent,
  SchedulerStats,
  TaskHistoryFilter,
  TaskRunRecord,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { agentId, DEFAULT_SCHEDULER_CONFIG, SCHEDULER, scheduleId, taskId } from "@koi/core";
import { createPiAdapter } from "@koi/engine-pi";
import type { TaskDispatcher } from "@koi/scheduler";
import { createScheduler, createSqliteTaskStore } from "@koi/scheduler";
import { createSchedulerProvider } from "@koi/scheduler-provider";
import { createKoi } from "../koi.js";
import type { KoiRuntime } from "../types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

function testManifest(): AgentManifest {
  return {
    name: "E2E Scheduler Agent",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5" },
  };
}

// ---------------------------------------------------------------------------
// In-memory scheduler fixtures
// ---------------------------------------------------------------------------

/**
 * Creates a real TaskScheduler backed by in-memory SQLite.
 * The dispatcher is a no-op — we're testing the tool layer, not actual task execution.
 */
function createTestScheduler(): {
  readonly scheduler: ReturnType<typeof createScheduler>;
  readonly store: ReturnType<typeof createSqliteTaskStore>;
} {
  const store = createSqliteTaskStore(new Database(":memory:"));
  const dispatcher: TaskDispatcher = async () => ({ ok: true });
  const scheduler = createScheduler(DEFAULT_SCHEDULER_CONFIG, store, dispatcher);
  return { scheduler, store };
}

// ---------------------------------------------------------------------------
// Stub scheduler for tool-level tests (deterministic, no SQLite)
// ---------------------------------------------------------------------------

/**
 * A deterministic SchedulerComponent stub that records all calls.
 * Returns canned results so LLM assertions are predictable.
 */
function createStubSchedulerComponent(): {
  readonly component: SchedulerComponent;
  readonly calls: { readonly method: string; readonly args: readonly unknown[] }[];
} {
  const calls: { readonly method: string; readonly args: readonly unknown[] }[] = [];

  const component: SchedulerComponent = {
    submit: (input, mode, options) => {
      calls.push({ method: "submit", args: [input, mode, options] });
      return taskId("task-e2e-1");
    },
    cancel: (id) => {
      calls.push({ method: "cancel", args: [id] });
      return true;
    },
    schedule: (expression, input, mode, options) => {
      calls.push({ method: "schedule", args: [expression, input, mode, options] });
      return scheduleId("sched-e2e-1");
    },
    unschedule: (id) => {
      calls.push({ method: "unschedule", args: [id] });
      return true;
    },
    pause: (id) => {
      calls.push({ method: "pause", args: [id] });
      return true;
    },
    resume: (id) => {
      calls.push({ method: "resume", args: [id] });
      return true;
    },
    query: (filter) => {
      calls.push({ method: "query", args: [filter] });
      return [];
    },
    stats: () => {
      calls.push({ method: "stats", args: [] });
      return {
        pending: 2,
        running: 1,
        completed: 10,
        failed: 0,
        deadLettered: 0,
        activeSchedules: 3,
        pausedSchedules: 1,
      } satisfies SchedulerStats;
    },
    history: (filter: TaskHistoryFilter) => {
      calls.push({ method: "history", args: [filter] });
      return [
        {
          taskId: taskId("task-hist-1"),
          agentId: agentId("e2e-scheduler-agent"),
          status: "completed" as const,
          startedAt: Date.now() - 5000,
          completedAt: Date.now() - 4000,
          durationMs: 1000,
          retryAttempt: 0,
          result: "daily report generated",
        },
        {
          taskId: taskId("task-hist-2"),
          agentId: agentId("e2e-scheduler-agent"),
          status: "failed" as const,
          startedAt: Date.now() - 3000,
          completedAt: Date.now() - 2500,
          durationMs: 500,
          error: "timeout after 30s",
          retryAttempt: 1,
        },
      ] satisfies readonly TaskRunRecord[];
    },
  };

  return { component, calls };
}

/**
 * ComponentProvider that directly attaches a SchedulerComponent + tools.
 * Bypasses the real TaskScheduler — we control all responses.
 */
function createStubSchedulerProvider(component: SchedulerComponent): ComponentProvider {
  const innerProvider = createSchedulerProvider({
    // Satisfy the type with a minimal TaskScheduler that delegates to the stub.
    // The stub component's methods are what actually get called.
    scheduler: {
      submit: (_aid, input, mode, opts) => component.submit(input, mode, opts),
      cancel: (id) => component.cancel(id),
      schedule: (expr, _aid, input, mode, opts) => component.schedule(expr, input, mode, opts),
      unschedule: (id) => component.unschedule(id),
      pause: (id) => component.pause(id),
      resume: (id) => component.resume(id),
      query: (filter) => component.query(filter),
      stats: () => {
        const s = component.stats();
        // TaskScheduler.stats() is sync; unwrap if Promise
        if (s instanceof Promise) throw new Error("stats must be sync");
        return s;
      },
      history: (filter) => component.history(filter),
      watch: () => () => {},
      [Symbol.asyncDispose]: async () => {},
    },
  });
  return innerProvider;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: scheduler tools through createKoi + createPiAdapter", () => {
  let runtime: KoiRuntime | undefined;

  afterEach(async () => {
    if (runtime !== undefined) {
      await runtime.dispose();
      runtime = undefined;
    }
  });

  // ── Test 1: Scheduler tools are advertised and LLM can call stats ──────

  test(
    "LLM calls scheduler_stats through the full stack",
    async () => {
      const { component, calls } = createStubSchedulerComponent();

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: [
          "You are a scheduler management assistant.",
          "You have scheduler tools available. Use them when asked.",
          "Always use the scheduler_stats tool to check scheduler status. Never make up numbers.",
        ].join("\n"),
        getApiKey: async () => ANTHROPIC_KEY,
      });

      runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [createStubSchedulerProvider(component)],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Check the scheduler stats. How many tasks are pending? How many schedules are paused?",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // The LLM should have called stats
      const statsCalls = calls.filter((c) => c.method === "stats");
      expect(statsCalls.length).toBeGreaterThanOrEqual(1);

      // Response should reference the canned stats (2 pending, 1 paused)
      const text = extractText(events);
      expect(text).toContain("2");

      // tool_call events should exist
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      expect(toolStarts.length).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT_MS,
  );

  // ── Test 2: LLM calls scheduler_pause ──────────────────────────────────

  test(
    "LLM calls scheduler_pause with the correct scheduleId",
    async () => {
      const { component, calls } = createStubSchedulerComponent();

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: [
          "You are a scheduler assistant. Use scheduler tools when asked.",
          "When asked to pause a schedule, use the scheduler_pause tool with the exact scheduleId provided.",
          "Do not make up IDs.",
        ].join("\n"),
        getApiKey: async () => ANTHROPIC_KEY,
      });

      runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [createStubSchedulerProvider(component)],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: 'Pause the schedule with ID "sched-daily-report". Confirm when done.',
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Pause should have been called with the exact ID
      const pauseCalls = calls.filter((c) => c.method === "pause");
      expect(pauseCalls.length).toBeGreaterThanOrEqual(1);
      expect(String(pauseCalls[0]?.args[0])).toBe("sched-daily-report");

      // tool_call events should exist
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      expect(toolStarts.length).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT_MS,
  );

  // ── Test 3: LLM calls scheduler_resume ─────────────────────────────────

  test(
    "LLM calls scheduler_resume with the correct scheduleId",
    async () => {
      const { component, calls } = createStubSchedulerComponent();

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: [
          "You are a scheduler assistant. Use scheduler tools when asked.",
          "When asked to resume a schedule, use the scheduler_resume tool with the exact scheduleId provided.",
        ].join("\n"),
        getApiKey: async () => ANTHROPIC_KEY,
      });

      runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [createStubSchedulerProvider(component)],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: 'Resume the schedule with ID "sched-weekly-sync". Report the result.',
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Resume should have been called
      const resumeCalls = calls.filter((c) => c.method === "resume");
      expect(resumeCalls.length).toBeGreaterThanOrEqual(1);
      expect(String(resumeCalls[0]?.args[0])).toBe("sched-weekly-sync");
    },
    TIMEOUT_MS,
  );

  // ── Test 4: LLM calls scheduler_history and reasons about results ──────

  test(
    "LLM calls scheduler_history and summarizes execution history",
    async () => {
      const { component, calls } = createStubSchedulerComponent();

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: [
          "You are a scheduler assistant. Use scheduler tools when asked.",
          "When asked about task history, use the scheduler_history tool.",
          "Summarize the history results including status, duration, and any errors.",
        ].join("\n"),
        getApiKey: async () => ANTHROPIC_KEY,
      });

      runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [createStubSchedulerProvider(component)],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Show me the recent task execution history. Were there any failures?",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // History should have been called
      const historyCalls = calls.filter((c) => c.method === "history");
      expect(historyCalls.length).toBeGreaterThanOrEqual(1);

      // Response should mention the failure
      const text = extractText(events);
      const mentionsFailure =
        text.toLowerCase().includes("fail") ||
        text.toLowerCase().includes("error") ||
        text.includes("timeout");
      expect(mentionsFailure).toBe(true);
    },
    TIMEOUT_MS,
  );

  // ── Test 5: Middleware observes scheduler tool calls ────────────────────

  test(
    "middleware wrapToolCall fires for scheduler tools",
    async () => {
      const { component } = createStubSchedulerComponent();
      const observedTools: string[] = [];

      const toolObserver: KoiMiddleware = {
        name: "scheduler-tool-observer",
        describeCapabilities: () => undefined,
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          observedTools.push(request.toolId);
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: [
          "You are a scheduler assistant.",
          "Use the scheduler_stats tool to check status, then use scheduler_pause to pause schedule 'sched-abc'.",
          "Do both in sequence.",
        ].join("\n"),
        getApiKey: async () => ANTHROPIC_KEY,
      });

      runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [toolObserver],
        providers: [createStubSchedulerProvider(component)],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Check scheduler stats, then pause the schedule 'sched-abc'.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Middleware should have observed scheduler tool calls
      const schedulerTools = observedTools.filter((t) => t.startsWith("scheduler_"));
      expect(schedulerTools.length).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT_MS,
  );

  // ── Test 6: Multi-tool sequence: schedule → pause → resume → history ──

  test(
    "LLM performs a full lifecycle: schedule, pause, resume, then check history",
    async () => {
      const { component, calls } = createStubSchedulerComponent();

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: [
          "You are a scheduler assistant. You have these tools available:",
          "- scheduler_schedule: create a cron schedule",
          "- scheduler_pause: pause a schedule",
          "- scheduler_resume: resume a paused schedule",
          "- scheduler_history: view execution history",
          "",
          "Execute each tool in the order requested by the user. Use exact IDs when provided.",
          "Do not skip any steps.",
        ].join("\n"),
        getApiKey: async () => ANTHROPIC_KEY,
      });

      runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [createStubSchedulerProvider(component)],
        loopDetection: false,
        limits: { maxTurns: 10 },
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: [
            "Perform these steps in order:",
            '1. Create a cron schedule "0 9 * * *" with input "daily standup" in spawn mode',
            '2. Pause the schedule "sched-e2e-1" (the one you just created)',
            '3. Resume the schedule "sched-e2e-1"',
            "4. Check the execution history",
            "Report the results of each step.",
          ].join("\n"),
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      // Verify the methods were called (LLM may not call all 4 in every run,
      // but should call at least 2 of the new operations)
      const methodsCalled = new Set(calls.map((c) => c.method));
      const newMethods = ["pause", "resume", "history"].filter((m) => methodsCalled.has(m));
      expect(newMethods.length).toBeGreaterThanOrEqual(2);

      // Should have at least some tool call events
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      expect(toolStarts.length).toBeGreaterThanOrEqual(2);
    },
    TIMEOUT_MS,
  );

  // ── Test 7: SchedulerComponent accessible via SCHEDULER token ──────────

  test(
    "SCHEDULER token provides a working SchedulerComponent on the agent entity",
    async () => {
      const { scheduler } = createTestScheduler();

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with exactly: ready",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [createSchedulerProvider({ scheduler })],
        loopDetection: false,
      });

      // Component should be accessible via SCHEDULER token
      const comp = runtime.agent.component<SchedulerComponent>(SCHEDULER);
      expect(comp).toBeDefined();
      if (comp === undefined) return;

      // Verify all new methods exist
      expect(typeof comp.pause).toBe("function");
      expect(typeof comp.resume).toBe("function");
      expect(typeof comp.history).toBe("function");

      // Stats should include pausedSchedules
      const stats = await comp.stats();
      expect(stats).toHaveProperty("pausedSchedules");
      expect(typeof stats.pausedSchedules).toBe("number");

      // History should return an array (empty for in-memory scheduler)
      const runs = await comp.history({ limit: 10 });
      expect(Array.isArray(runs)).toBe(true);

      await runtime.dispose();
      await scheduler[Symbol.asyncDispose]();
      runtime = undefined;
    },
    TIMEOUT_MS,
  );

  // ── Test 8: Real scheduler pause/resume round-trip ─────────────────────

  test(
    "real scheduler: create schedule → pause → verify paused → resume → verify active",
    async () => {
      const { scheduler } = createTestScheduler();

      // Create a cron schedule
      const sid = await scheduler.schedule(
        "0 0 * * *",
        agentId("e2e-agent"),
        { kind: "text", text: "nightly cleanup" },
        "spawn",
      );

      // Stats before pause
      const statsBefore = scheduler.stats();
      expect(statsBefore.activeSchedules).toBe(1);
      expect(statsBefore.pausedSchedules).toBe(0);

      // Pause
      const paused = scheduler.pause(sid);
      expect(paused).toBe(true);

      const statsAfterPause = scheduler.stats();
      expect(statsAfterPause.pausedSchedules).toBe(1);

      // Resume
      const resumed = scheduler.resume(sid);
      expect(resumed).toBe(true);

      const statsAfterResume = scheduler.stats();
      expect(statsAfterResume.pausedSchedules).toBe(0);
      expect(statsAfterResume.activeSchedules).toBe(1);

      // Pause nonexistent
      const bogus = scheduler.pause(scheduleId("nonexistent"));
      expect(bogus).toBe(false);

      // History (empty for in-memory)
      const history = await scheduler.history({});
      expect(Array.isArray(history)).toBe(true);
      expect(history).toHaveLength(0);

      // Cleanup
      await scheduler[Symbol.asyncDispose]();
    },
    TIMEOUT_MS,
  );
});
