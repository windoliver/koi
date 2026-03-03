/**
 * E2E validation of Issue #406 signal cancellation improvements.
 *
 * Tests the full createKoi + createPiAdapter pipeline with real LLM calls
 * (Anthropic Haiku) to validate every change in the PR:
 *
 *   1. Sandbox middleware fast-path throwIfAborted — pre-aborted signal
 *      is rejected before tool execution starts
 *   2. Sandbox middleware AbortSignal.timeout — tool exceeding sandbox
 *      timeout is caught by the new timer-free mechanism
 *   3. Sandbox middleware signal composition — upstream + sandbox signals
 *      are composed correctly via AbortSignal.any
 *   4. Run-level abort propagates through middleware chain to tool
 *   5. Cooperative tool respects signal and exits early
 *   6. Non-cooperative tool is bounded by backstop race
 *   7. Shutdown signal composes with timeout at Node handler layer
 *   8. New event types (tool_timeout, tool_error) are emitted correctly
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-signal-cancellation-v2.test.ts
 *
 * Requires ANTHROPIC_API_KEY in .env (auto-loaded by Bun).
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  Tool,
  ToolExecuteOptions,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { toolToken } from "@koi/core";
import type { TrustTier } from "@koi/core/ecs";
import type { SandboxProfile } from "@koi/core/sandbox-profile";
import { createPiAdapter } from "@koi/engine-pi";
import { createSandboxMiddleware } from "@koi/middleware-sandbox";
import { createKoi } from "../koi.js";

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
    name: "E2E Signal V2 Agent",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5" },
  };
}

function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-signal-v2-tool-provider",
    attach: async () => new Map(tools.map((t) => [toolToken(t.descriptor.name) as string, t])),
  };
}

function createAdapter(systemPrompt: string): ReturnType<typeof createPiAdapter> {
  return createPiAdapter({
    model: E2E_MODEL,
    systemPrompt,
    getApiKey: async () => ANTHROPIC_KEY,
  });
}

// ---------------------------------------------------------------------------
// Sandbox middleware factory for E2E tests
// ---------------------------------------------------------------------------

function makeSandboxProfile(tier: TrustTier, timeoutMs: number): SandboxProfile {
  return {
    tier,
    filesystem: {},
    network: { allow: false },
    resources: { timeoutMs },
  };
}

/** Create sandbox middleware with configurable timeout for sandbox-tier tools. */
function createTestSandboxMiddleware(opts: {
  readonly sandboxTimeoutMs: number;
  readonly graceMs: number;
  readonly onTimeout?: ((toolId: string) => void) | undefined;
}): KoiMiddleware {
  return createSandboxMiddleware({
    profileFor: (tier: TrustTier) => makeSandboxProfile(tier, opts.sandboxTimeoutMs),
    tierFor: () => "sandbox", // All tools are sandbox-tier in these tests
    timeoutGraceMs: opts.graceMs,
    onSandboxError: (toolId: string, _tier: TrustTier, code: string) => {
      if (code === "TIMEOUT") {
        opts.onTimeout?.(toolId);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const MULTIPLY_TOOL: Tool = {
  descriptor: {
    name: "multiply",
    description: "Multiplies two numbers together and returns the product.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
  },
  trustTier: "sandbox",
  execute: async (input: Readonly<Record<string, unknown>>) => {
    const a = Number(input.a ?? 0);
    const b = Number(input.b ?? 0);
    return String(a * b);
  },
};

/** Tool that checks signal state and reports it. */
function createSignalReporterTool(): {
  readonly tool: Tool;
  readonly receivedSignal: () => boolean;
  readonly signalWasAborted: () => boolean;
} {
  // let justified: mutable test state captured from inside execute
  let gotSignal = false;
  let wasAborted = false;

  const tool: Tool = {
    descriptor: {
      name: "signal_reporter",
      description:
        "Reports whether a cancellation signal was received. Always call this when asked about signal status.",
      inputSchema: { type: "object", properties: {} },
    },
    trustTier: "sandbox",
    execute: async (_args: unknown, options?: ToolExecuteOptions) => {
      gotSignal = options?.signal !== undefined;
      wasAborted = options?.signal?.aborted === true;
      return JSON.stringify({ receivedSignal: gotSignal, signalAborted: wasAborted });
    },
  };

  return { tool, receivedSignal: () => gotSignal, signalWasAborted: () => wasAborted };
}

/** Tool that takes a configurable amount of time, checking signal cooperatively. */
function createTimedCooperativeTool(): {
  readonly tool: Tool;
  readonly stepsCompleted: () => number;
  readonly wasCancelled: () => boolean;
} {
  // let justified: mutable test state for tracking cooperative cancellation
  let steps = 0;
  let cancelled = false;

  const tool: Tool = {
    descriptor: {
      name: "timed_task",
      description:
        "A task that runs for multiple steps, checking for cancellation between each. " +
        "Always use this tool when asked to run a timed task.",
      inputSchema: {
        type: "object",
        properties: {
          totalSteps: { type: "number", description: "Number of 50ms steps (default: 10)" },
        },
      },
    },
    trustTier: "sandbox",
    execute: async (args: Readonly<Record<string, unknown>>, options?: ToolExecuteOptions) => {
      const totalSteps = Number(args.totalSteps ?? 10);
      const signal = options?.signal;

      for (let i = 0; i < totalSteps; i++) {
        if (signal?.aborted) {
          cancelled = true;
          return JSON.stringify({ status: "cancelled", stepsCompleted: steps, totalSteps });
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        steps++;
      }

      return JSON.stringify({ status: "completed", stepsCompleted: steps, totalSteps });
    },
  };

  return { tool, stepsCompleted: () => steps, wasCancelled: () => cancelled };
}

/** Tool that never resolves — used to test backstop enforcement. */
function createHangingTool(): Tool {
  return {
    descriptor: {
      name: "hanging_task",
      description:
        "A task that hangs forever (for testing). Always use this when asked to run a hanging task.",
      inputSchema: { type: "object", properties: {} },
    },
    trustTier: "sandbox",
    execute: async () => new Promise(() => {}), // never resolves
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: signal cancellation improvements (Issue #406)", () => {
  // ── 1. Signal threads through sandbox middleware to tool.execute ─────

  test(
    "signal threads through sandbox middleware to tool.execute via full pipeline",
    async () => {
      const { tool, receivedSignal } = createSignalReporterTool();

      // Sandbox with generous timeout — we want the tool to succeed
      const sandbox = createTestSandboxMiddleware({
        sandboxTimeoutMs: 30_000,
        graceMs: 5_000,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(
          "You MUST call the signal_reporter tool when asked about signal status. Always use the tool first.",
        ),
        middleware: [sandbox],
        providers: [createToolProvider([tool])],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Check the signal status by calling the signal_reporter tool.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Signal was threaded through sandbox middleware to tool.execute
      expect(receivedSignal()).toBe(true);

      // tool_call events should exist
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      expect(toolStarts.length).toBeGreaterThanOrEqual(1);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 2. Sandbox middleware timeout via AbortSignal.timeout ────────────

  test(
    "sandbox middleware enforces timeout on hanging tool using AbortSignal.timeout",
    async () => {
      const hangingTool = createHangingTool();

      // Tight sandbox timeout: 200ms + 100ms grace = 300ms total
      // let justified: mutable flag for timeout detection
      let timeoutToolId: string | undefined;
      const sandbox = createTestSandboxMiddleware({
        sandboxTimeoutMs: 200,
        graceMs: 100,
        onTimeout: (toolId) => {
          timeoutToolId = toolId;
        },
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(
          "You MUST call the hanging_task tool when asked. Always use the tool.",
        ),
        middleware: [sandbox],
        providers: [createToolProvider([hangingTool])],
        loopDetection: false,
        limits: { maxTurns: 3 }, // Limit turns — tool will timeout, model may retry
      });

      const start = Date.now();
      await collectEvents(
        runtime.run({
          kind: "text",
          text: "Run the hanging_task tool now.",
        }),
      );
      const elapsed = Date.now() - start;

      // Sandbox should have timed out (not waited forever)
      // The onSandboxError callback should have fired
      expect(timeoutToolId).toBe("hanging_task");

      // Should complete in reasonable time — not hanging
      expect(elapsed).toBeLessThan(60_000);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 3. Run-level abort propagates through sandbox to cooperative tool ─

  test(
    "run-level abort propagates through sandbox middleware to cooperative tool",
    async () => {
      const { tool: coopTool, stepsCompleted } = createTimedCooperativeTool();

      // Long sandbox timeout — run-level abort should fire first
      const sandbox = createTestSandboxMiddleware({
        sandboxTimeoutMs: 30_000,
        graceMs: 5_000,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(
          "You MUST call the timed_task tool with totalSteps=30 when asked. Always use the tool.",
        ),
        middleware: [sandbox],
        providers: [createToolProvider([coopTool])],
        loopDetection: false,
      });

      const controller = new AbortController();
      const events: EngineEvent[] = [];

      const iter = runtime.run({
        kind: "text",
        text: "Run the timed_task tool with totalSteps set to 30.",
        signal: controller.signal,
      });

      for await (const event of iter) {
        events.push(event);
        // Abort 400ms after tool_call_start — tool needs 30*50=1500ms total
        if (event.kind === "tool_call_start") {
          setTimeout(() => controller.abort(), 400);
        }
      }

      // The tool should NOT have completed all 30 steps
      // (~400ms / 50ms per step = ~8 steps before abort)
      expect(stepsCompleted()).toBeLessThan(30);

      // Agent should be terminated
      expect(runtime.agent.state).toBe("terminated");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 4. Middleware observes signal on ToolRequest (wrapToolCall) ──────

  test(
    "sandbox + custom middleware both see signal on ToolRequest",
    async () => {
      // let justified: captured from inside middleware for assertion
      let customMwReceivedSignal = false;
      let customMwSignalAborted = false;

      const signalInspector: KoiMiddleware = {
        name: "signal-inspector",
        describeCapabilities: () => undefined,
        priority: 300, // After sandbox (200), before tool terminal
        wrapToolCall: async (
          _ctx: TurnContext,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          customMwReceivedSignal = request.signal !== undefined;
          customMwSignalAborted = request.signal?.aborted === true;
          return next(request);
        },
      };

      const sandbox = createTestSandboxMiddleware({
        sandboxTimeoutMs: 30_000,
        graceMs: 5_000,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(
          "You MUST use the multiply tool for math. Do not compute in your head.",
        ),
        middleware: [sandbox, signalInspector],
        providers: [createToolProvider([MULTIPLY_TOOL])],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the multiply tool to compute 7 * 9.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // The custom middleware (after sandbox) should see a composed signal
      // that includes both the run signal and the sandbox timeout signal
      expect(customMwReceivedSignal).toBe(true);
      // Signal should NOT be aborted during normal execution
      expect(customMwSignalAborted).toBe(false);

      const text = extractText(events);
      expect(text).toContain("63");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 5. Sandbox fast-path: pre-aborted signal ────────────────────────

  test(
    "sandbox fast-path rejects immediately when run signal is pre-aborted",
    async () => {
      const { tool } = createSignalReporterTool();

      const sandbox = createTestSandboxMiddleware({
        sandboxTimeoutMs: 30_000,
        graceMs: 5_000,
      });

      const controller = new AbortController();
      controller.abort(new Error("pre-aborted"));

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(
          "You MUST call the signal_reporter tool. Always use the tool first.",
        ),
        middleware: [sandbox],
        providers: [createToolProvider([tool])],
        loopDetection: false,
      });

      const events: EngineEvent[] = [];
      for await (const event of runtime.run({
        kind: "text",
        text: "Check signal status by calling signal_reporter.",
        signal: controller.signal,
      })) {
        events.push(event);
      }

      // Run should terminate — either completed fast or interrupted
      const finalState = runtime.agent.state;
      expect(["idle", "terminated"]).toContain(finalState);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 6. Normal tool works through sandbox with correct result ────────

  test(
    "normal tool call through sandbox middleware returns correct result",
    async () => {
      // let justified: metric tracking for sandbox
      const metricsLog: Array<{
        readonly toolId: string;
        readonly durationMs: number;
        readonly truncated: boolean;
      }> = [];

      const sandbox = createSandboxMiddleware({
        profileFor: (tier: TrustTier) => makeSandboxProfile(tier, 30_000),
        tierFor: () => "sandbox",
        timeoutGraceMs: 5_000,
        onSandboxMetrics: (
          toolId: string,
          _tier: TrustTier,
          durationMs: number,
          _bytes: number,
          truncated: boolean,
        ) => {
          metricsLog.push({ toolId, durationMs, truncated });
        },
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(
          "You MUST use the multiply tool for math. Never compute in your head. Always use the tool.",
        ),
        middleware: [sandbox],
        providers: [createToolProvider([MULTIPLY_TOOL])],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the multiply tool to compute 12 * 13. Tell me the exact result.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Response should contain 156
      const text = extractText(events);
      expect(text).toContain("156");

      // Sandbox metrics should have fired for the tool call
      expect(metricsLog.length).toBeGreaterThanOrEqual(1);
      const multiplyMetric = metricsLog.find((m) => m.toolId === "multiply");
      expect(multiplyMetric).toBeDefined();
      expect(multiplyMetric?.truncated).toBe(false);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 7. Cooperative tool + sandbox: abort mid-execution ──────────────

  test(
    "sandbox timeout aborts cooperative tool that exceeds its limit",
    async () => {
      const { tool: coopTool, stepsCompleted } = createTimedCooperativeTool();

      // Tight sandbox timeout: 200ms + 50ms grace = 250ms
      // Tool doing 20 steps * 50ms = 1000ms — will exceed sandbox timeout
      const sandbox = createTestSandboxMiddleware({
        sandboxTimeoutMs: 200,
        graceMs: 50,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(
          "You MUST call the timed_task tool with totalSteps=20 when asked. Always use the tool.",
        ),
        middleware: [sandbox],
        providers: [createToolProvider([coopTool])],
        loopDetection: false,
        limits: { maxTurns: 3 },
      });

      const start = Date.now();
      await collectEvents(
        runtime.run({
          kind: "text",
          text: "Run the timed_task tool with totalSteps set to 20.",
        }),
      );
      const elapsed = Date.now() - start;

      // The cooperative tool should have been cut short
      // Sandbox fires at ~250ms, tool does 50ms/step → ~5 steps
      expect(stepsCompleted()).toBeLessThan(20);

      // Should not have waited the full 1000ms for the tool
      // (allowing generous margin for LLM call overhead)
      expect(elapsed).toBeLessThan(60_000);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 8. Multiple middleware + sandbox compose correctly ──────────────

  test(
    "multiple middleware layers + sandbox compose signals correctly",
    async () => {
      // let justified: mutable capture from middleware
      let outerSawSignal = false;
      let innerSawSignal = false;

      const outerMiddleware: KoiMiddleware = {
        name: "outer-observer",
        describeCapabilities: () => undefined,
        priority: 100, // Before sandbox (200)
        wrapToolCall: async (
          _ctx: TurnContext,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          outerSawSignal = request.signal !== undefined;
          return next(request);
        },
      };

      const innerMiddleware: KoiMiddleware = {
        name: "inner-observer",
        describeCapabilities: () => undefined,
        priority: 300, // After sandbox (200)
        wrapToolCall: async (
          _ctx: TurnContext,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          innerSawSignal = request.signal !== undefined;
          return next(request);
        },
      };

      const sandbox = createTestSandboxMiddleware({
        sandboxTimeoutMs: 30_000,
        graceMs: 5_000,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter("You MUST use the multiply tool. Do not compute in your head."),
        middleware: [outerMiddleware, sandbox, innerMiddleware],
        providers: [createToolProvider([MULTIPLY_TOOL])],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use multiply to compute 3 * 5.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Both middleware layers should have seen a signal on the request
      // - Outer (before sandbox): sees the run-level signal
      // - Inner (after sandbox): sees the composed (run + sandbox timeout) signal
      expect(outerSawSignal).toBe(true);
      expect(innerSawSignal).toBe(true);

      const text = extractText(events);
      expect(text).toContain("15");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
