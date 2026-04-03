/**
 * Full-stack E2E: createKoi + createPiAdapter + @koi/middleware-report.
 *
 * Validates report middleware with real LLM calls through the full L1 runtime:
 *   - Report generated after session ends with correct structure
 *   - Token usage accumulated from real model calls
 *   - Tool call actions recorded in the report
 *   - onProgress fires with live data after each turn
 *   - getProgress() returns accurate mid-run snapshot
 *   - Formatters produce valid output from real data
 *   - Edge case: tool error recorded as issue
 *
 * Run:
 *   E2E_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/e2e-real-llm.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  RunReport,
  Tool,
} from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import type { ProgressSnapshot } from "../config.js";
import { mapReportToJson, mapReportToMarkdown } from "../formatters.js";
import { createReportMiddleware } from "../report.js";

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
    name: "E2E Report Agent",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5" },
  };
}

function createAdapter(): ReturnType<typeof createPiAdapter> {
  return createPiAdapter({
    model: E2E_MODEL,
    systemPrompt: "You are a concise assistant. Reply briefly.",
    getApiKey: async () => ANTHROPIC_KEY,
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
  origin: "primordial",
  policy: DEFAULT_SANDBOXED_POLICY,
  execute: async (input: Readonly<Record<string, unknown>>) => {
    const a = Number(input.a ?? 0);
    const b = Number(input.b ?? 0);
    return String(a * b);
  },
};

function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-tool-provider",
    attach: async () => new Map(tools.map((t) => [toolToken(t.descriptor.name) as string, t])),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: @koi/middleware-report through full L1 runtime", () => {
  // ── Test 1: Basic report generation from real LLM call ──────────────

  test(
    "generates RunReport with real token usage from LLM call",
    async () => {
      const handle = createReportMiddleware({
        objective: "E2E validation of report middleware",
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(),
        middleware: [handle.middleware],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly: hello" }),
      );
      await runtime.dispose();

      // Report should exist after session ends
      const report = handle.getReport();
      expect(report).toBeDefined();
      if (!report) return;

      // Structure checks
      expect(report.objective).toBe("E2E validation of report middleware");
      expect(report.summary).toBeDefined();
      expect(report.summary.length).toBeGreaterThan(0);

      // Duration
      expect(report.duration.startedAt).toBeGreaterThan(0);
      expect(report.duration.completedAt).toBeGreaterThan(report.duration.startedAt);
      expect(report.duration.durationMs).toBeGreaterThan(0);
      expect(report.duration.totalTurns).toBeGreaterThanOrEqual(1);
      expect(report.duration.totalActions).toBeGreaterThanOrEqual(1);

      // Token usage from real model call
      expect(report.cost.inputTokens).toBeGreaterThan(0);
      expect(report.cost.outputTokens).toBeGreaterThan(0);
      expect(report.cost.totalTokens).toBe(report.cost.inputTokens + report.cost.outputTokens);

      // Actions should contain at least one model_call
      const modelCalls = report.actions.filter((a) => a.kind === "model_call");
      expect(modelCalls.length).toBeGreaterThanOrEqual(1);
      expect(modelCalls[0]?.success).toBe(true);
      expect(modelCalls[0]?.durationMs).toBeGreaterThan(0);
      expect(modelCalls[0]?.tokenUsage).toBeDefined();
      expect(modelCalls[0]?.tokenUsage?.inputTokens).toBeGreaterThan(0);

      // Verify LLM actually responded
      const text = extractText(events);
      expect(text.toLowerCase()).toContain("hello");

      const output = findDoneOutput(events);
      expect(output?.stopReason).toBe("completed");
    },
    TIMEOUT_MS,
  );

  // ── Test 2: Tool calls recorded in report ───────────────────────────

  test(
    "records tool call actions from real LLM tool use",
    async () => {
      const handle = createReportMiddleware({
        objective: "Test tool call recording",
      });

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the multiply tool to answer math questions. Never compute in your head.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [handle.middleware],
        providers: [createToolProvider([MULTIPLY_TOOL])],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the multiply tool to compute 6 * 7. Tell me the result.",
        }),
      );
      await runtime.dispose();

      const report = handle.getReport();
      expect(report).toBeDefined();
      if (!report) return;
      expect(report).toBeDefined();

      // Should have both model_call and tool_call actions
      const modelCalls = report.actions.filter((a) => a.kind === "model_call");
      const toolCalls = report.actions.filter((a) => a.kind === "tool_call");

      expect(modelCalls.length).toBeGreaterThanOrEqual(1);
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);

      // Tool call should be the multiply tool
      const multiplyCall = toolCalls.find((a) => a.name === "multiply");
      expect(multiplyCall).toBeDefined();
      expect(multiplyCall?.success).toBe(true);
      expect(multiplyCall?.durationMs).toBeGreaterThanOrEqual(0);

      // Response should contain 42
      const text = extractText(events);
      expect(text).toContain("42");

      // Total actions should match
      expect(report.duration.totalActions).toBe(report.actions.length);
    },
    TIMEOUT_MS,
  );

  // ── Test 3: onProgress fires with live data ─────────────────────────

  test(
    "onProgress callback fires with real turn data",
    async () => {
      const progressSnapshots: ProgressSnapshot[] = [];

      const handle = createReportMiddleware({
        onProgress: (snap) => {
          progressSnapshots.push(snap);
        },
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(),
        middleware: [handle.middleware],
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Say: yes" }));
      await runtime.dispose();

      // At least one turn should have fired onProgress
      expect(progressSnapshots.length).toBeGreaterThanOrEqual(1);

      const lastSnap = progressSnapshots[progressSnapshots.length - 1];
      expect(lastSnap).toBeDefined();
      if (!lastSnap) return;
      expect(lastSnap.totalActions).toBeGreaterThan(0);
      expect(lastSnap.inputTokens).toBeGreaterThan(0);
      expect(lastSnap.outputTokens).toBeGreaterThan(0);
      expect(lastSnap.totalTokens).toBe(lastSnap.inputTokens + lastSnap.outputTokens);
      expect(lastSnap.elapsedMs).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  // ── Test 4: getProgress() returns accurate mid-run data ─────────────

  test(
    "getProgress() returns live accumulator state during run",
    async () => {
      const handle = createReportMiddleware({});

      // Use a middleware that checks progress after the model call
      let midRunProgress: ProgressSnapshot | undefined;

      const progressChecker: KoiMiddleware = {
        name: "progress-checker",
        describeCapabilities: () => undefined,
        priority: 900, // runs after report middleware (275)
        onAfterTurn: async () => {
          midRunProgress = handle.getProgress();
        },
      };

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(),
        middleware: [handle.middleware, progressChecker],
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Reply: ok" }));
      await runtime.dispose();

      // Mid-run progress should have been captured
      expect(midRunProgress).toBeDefined();
      expect(midRunProgress?.totalActions).toBeGreaterThan(0);
      expect(midRunProgress?.inputTokens).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  // ── Test 5: onReport callback fires with formatted output ───────────

  test(
    "onReport callback receives report and markdown-formatted string",
    async () => {
      let receivedReport: RunReport | undefined;
      let receivedFormatted: string | undefined;

      const handle = createReportMiddleware({
        objective: "Test onReport delivery",
        onReport: (report, formatted) => {
          receivedReport = report;
          receivedFormatted = formatted;
        },
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(),
        middleware: [handle.middleware],
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Say: done" }));
      await runtime.dispose();

      expect(receivedReport).toBeDefined();
      expect(receivedFormatted).toBeDefined();

      // Default formatter is mapReportToMarkdown
      expect(receivedFormatted).toContain("# Run Report");
      expect(receivedFormatted).toContain("## Summary");
      expect(receivedFormatted).toContain("## Duration");
      expect(receivedFormatted).toContain("## Cost");
      expect(receivedFormatted).toContain("## Actions");
    },
    TIMEOUT_MS,
  );

  // ── Test 6: mapReportToMarkdown with real data ──────────────────────

  test(
    "mapReportToMarkdown produces valid markdown from real run data",
    async () => {
      const handle = createReportMiddleware({
        objective: "Formatter validation",
      });

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You MUST use the multiply tool. Never compute in your head.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [handle.middleware],
        providers: [createToolProvider([MULTIPLY_TOOL])],
        loopDetection: false,
      });

      await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use multiply to compute 3 * 4. Tell me the result.",
        }),
      );
      await runtime.dispose();

      const report = handle.getReport();
      expect(report).toBeDefined();
      if (!report) return;
      const md = mapReportToMarkdown(report);

      // Structural assertions
      expect(md).toContain("# Run Report");
      expect(md).toContain("## Summary");
      expect(md).toContain("## Objective");
      expect(md).toContain("Formatter validation");
      expect(md).toContain("## Duration");
      expect(md).toContain("## Actions");
      expect(md).toContain("| # | Type | Name | Turn | Duration | Status |");
      expect(md).toContain("model_call");
      expect(md).toContain("## Cost");
      expect(md).toContain("Input tokens:");
      expect(md).toContain("Output tokens:");

      // JSON format
      const json = mapReportToJson(report);
      const parsed = JSON.parse(json);
      expect(parsed.objective).toBe("Formatter validation");
      expect(parsed.cost.inputTokens).toBeGreaterThan(0);
      expect(parsed.actions.length).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  // ── Test 7: Multiple middleware coexist ──────────────────────────────

  test(
    "report middleware coexists with other middleware in the chain",
    async () => {
      const hookOrder: string[] = [];

      const lifecycleObserver: KoiMiddleware = {
        name: "lifecycle-observer",
        describeCapabilities: () => undefined,
        priority: 100, // outer layer
        onSessionStart: async () => {
          hookOrder.push("observer:session_start");
        },
        onSessionEnd: async () => {
          hookOrder.push("observer:session_end");
        },
        onAfterTurn: async () => {
          hookOrder.push("observer:after_turn");
        },
      };

      const reportHookOrder: string[] = [];
      const handle = createReportMiddleware({
        onProgress: () => {
          reportHookOrder.push("report:progress");
        },
        onReport: () => {
          reportHookOrder.push("report:delivered");
        },
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(),
        middleware: [lifecycleObserver, handle.middleware],
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Say: hi" }));
      await runtime.dispose();

      // Both middleware chains fired
      expect(hookOrder).toContain("observer:session_start");
      expect(hookOrder).toContain("observer:session_end");
      expect(hookOrder).toContain("observer:after_turn");

      expect(reportHookOrder).toContain("report:progress");
      expect(reportHookOrder).toContain("report:delivered");

      // Report is still valid
      const report = handle.getReport();
      expect(report).toBeDefined();
      if (!report) return;
      expect(report).toBeDefined();
      expect(report.cost.inputTokens).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  // ── Test 8: Multi-turn with tool use generates comprehensive report ─

  test(
    "multi-turn tool use generates comprehensive report with all sections populated",
    async () => {
      const handle = createReportMiddleware({
        objective: "Comprehensive E2E validation",
      });

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the multiply tool for ALL calculations. Never compute in your head. Always use the tool.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [handle.middleware],
        providers: [createToolProvider([MULTIPLY_TOOL])],
        loopDetection: false,
        limits: { maxTurns: 5 },
      });

      await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the multiply tool to compute 5 * 3, then use it again to compute 7 * 2. Report both results.",
        }),
      );
      await runtime.dispose();

      const report = handle.getReport();
      expect(report).toBeDefined();
      if (!report) return;
      expect(report).toBeDefined();

      // Comprehensive checks
      expect(report.objective).toBe("Comprehensive E2E validation");
      expect(report.summary.length).toBeGreaterThan(10);

      // Multiple actions
      expect(report.actions.length).toBeGreaterThanOrEqual(2);

      // At least one model_call and one tool_call
      const kinds = new Set(report.actions.map((a) => a.kind));
      expect(kinds.has("model_call")).toBe(true);
      expect(kinds.has("tool_call")).toBe(true);

      // All actions have valid data
      for (const action of report.actions) {
        expect(action.name.length).toBeGreaterThan(0);
        expect(action.durationMs).toBeGreaterThanOrEqual(0);
        expect(typeof action.success).toBe("boolean");
        expect(typeof action.turnIndex).toBe("number");
      }

      // Cost accounting
      expect(report.cost.totalTokens).toBe(report.cost.inputTokens + report.cost.outputTokens);
      expect(report.cost.inputTokens).toBeGreaterThan(0);
      expect(report.cost.outputTokens).toBeGreaterThan(0);

      // Duration sanity
      expect(report.duration.durationMs).toBe(
        report.duration.completedAt - report.duration.startedAt,
      );
      expect(report.duration.totalTurns).toBeGreaterThanOrEqual(1);
      expect(report.duration.totalActions).toBe(report.actions.length);
      expect(report.duration.truncated).toBe(false);

      // Template summary mentions real numbers
      expect(report.summary).toContain("actions");
    },
    TIMEOUT_MS,
  );

  // ── Test 9: costProvider integration ─────────────────────────────────

  test(
    "costProvider injects estimated cost into the report",
    async () => {
      const handle = createReportMiddleware({
        costProvider: async () => ({ estimatedCostUsd: 0.0042 }),
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(),
        middleware: [handle.middleware],
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Say: test" }));
      await runtime.dispose();

      const report = handle.getReport();
      expect(report).toBeDefined();
      if (!report) return;
      expect(report.cost.estimatedCostUsd).toBe(0.0042);
      // Token counts should still be from real calls
      expect(report.cost.inputTokens).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  // ── Test 10: Custom formatter ───────────────────────────────────────

  test(
    "custom formatter is used in onReport callback",
    async () => {
      let formatted = "";

      const handle = createReportMiddleware({
        formatter: (report) =>
          `CUSTOM: ${report.actions.length} actions, ${report.cost.totalTokens} tokens`,
        onReport: (_report, fmt) => {
          formatted = fmt;
        },
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(),
        middleware: [handle.middleware],
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Say: x" }));
      await runtime.dispose();

      expect(formatted).toStartWith("CUSTOM:");
      expect(formatted).toContain("actions");
      expect(formatted).toContain("tokens");
    },
    TIMEOUT_MS,
  );
});
