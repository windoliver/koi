/**
 * Comprehensive E2E tests: @koi/agent-monitor through createKoi + createPiAdapter.
 *
 * Validates that agent-monitor middleware correctly intercepts the real L1 middleware
 * chain when wired through createKoi + createPiAdapter with real Anthropic API calls.
 *
 * ── What IS tested here ──────────────────────────────────────────────────────
 * Pi adapter routes tool calls through callHandlers.toolCall → wrapToolCall, and
 * model generation through callHandlers.modelStream → wrapModelStream, so both
 * paths are covered:
 *   - Session lifecycle: onSessionStart, onSessionEnd, onMetrics callback
 *   - Metric accuracy: totalToolCalls, totalModelCalls in SessionMetricsSummary
 *   - Signal tool_rate_exceeded    — too many tool calls in one turn
 *   - Signal tool_repeated         — same tool called consecutively
 *   - Signal tool_diversity_spike  — too many distinct tools in one turn (Gap 3)
 *   - Signal irreversible_action_rate — destructive tool overuse (Gap 1)
 *   - Signal tool_ping_pong (Gap A) — sustained A↔B tool alternation
 *   - wrapModelStream path: latency tracking, totalModelCalls, meanLatencyMs (Test 10)
 *
 * ── What is NOT tested here ───────────────────────────────────────────────────
 *   - model_latency_anomaly/token_spike threshold firing → requires warmup samples
 *     (timing-sensitive; covered deterministically in monitor.test.ts unit tests)
 *   - denied_tool_calls       → requires Tool.execute to return metadata.denied=true,
 *                               which defaultToolTerminal in createKoi does not produce
 *
 * Gate: E2E_TESTS=1 + ANTHROPIC_API_KEY
 *
 * Run:
 *   E2E_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/e2e-pi.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  ComponentProvider,
  EngineEvent,
  JsonObject,
  Tool,
  ToolDescriptor,
} from "@koi/core";
import { toolToken } from "@koi/core";
import type { SessionId } from "@koi/core/ecs";
import type { KoiRuntime } from "@koi/engine";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createAgentMonitorMiddleware } from "../monitor.js";
import type { AnomalySignal, SessionMetricsSummary } from "../types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_ENABLED = HAS_KEY && process.env.E2E_TESTS === "1";
const describeE2E = E2E_ENABLED ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Shared manifest — only name is required by createKoi
// ---------------------------------------------------------------------------

const TEST_MANIFEST: AgentManifest = {
  name: "e2e-agent-monitor-test",
  version: "0.0.1",
  model: { name: E2E_MODEL },
};

// ---------------------------------------------------------------------------
// Tool descriptors
// ---------------------------------------------------------------------------

const ADD_NUMBERS: ToolDescriptor = {
  name: "add_numbers",
  description: "Adds two integers. Returns their sum.",
  inputSchema: {
    type: "object",
    properties: {
      a: { type: "integer", description: "First integer" },
      b: { type: "integer", description: "Second integer" },
    },
    required: ["a", "b"],
  },
};

const MULTIPLY_NUMBERS: ToolDescriptor = {
  name: "multiply_numbers",
  description: "Multiplies two integers. Returns their product.",
  inputSchema: {
    type: "object",
    properties: {
      a: { type: "integer", description: "First integer" },
      b: { type: "integer", description: "Second integer" },
    },
    required: ["a", "b"],
  },
};

const SUBTRACT_NUMBERS: ToolDescriptor = {
  name: "subtract_numbers",
  description: "Subtracts b from a. Returns the difference.",
  inputSchema: {
    type: "object",
    properties: {
      a: { type: "integer", description: "Number to subtract from" },
      b: { type: "integer", description: "Number to subtract" },
    },
    required: ["a", "b"],
  },
};

const DELETE_FILE: ToolDescriptor = {
  name: "delete_file",
  description: "Deletes a file by name. This action is irreversible.",
  inputSchema: {
    type: "object",
    properties: {
      filename: { type: "string", description: "Name of the file to delete" },
    },
    required: ["filename"],
  },
};

const SEARCH_INFO: ToolDescriptor = {
  name: "search_info",
  description: "Searches for information about a topic.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
    },
    required: ["query"],
  },
};

const READ_RESULT: ToolDescriptor = {
  name: "read_result",
  description: "Reads and returns the details of a search result.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Result identifier to read" },
    },
    required: ["id"],
  },
};

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

type ToolSpec = {
  readonly descriptor: ToolDescriptor;
  readonly execute: (args: JsonObject) => Promise<unknown>;
};

/** Build a ComponentProvider that registers the given tools. */
function buildProvider(tools: readonly ToolSpec[]): ComponentProvider {
  return {
    name: "e2e-test-tools",
    attach: async (): Promise<ReadonlyMap<string, unknown>> => {
      const map = new Map<string, unknown>();
      for (const spec of tools) {
        const tool: Tool = {
          descriptor: spec.descriptor,
          trustTier: "sandbox",
          execute: spec.execute,
        };
        map.set(toolToken(spec.descriptor.name) as string, tool);
      }
      return map;
    },
  };
}

type MonitorOptions = {
  readonly tools: readonly ToolSpec[];
  readonly destructiveToolIds?: readonly string[];
  readonly agentDepth?: number;
  readonly spawnToolIds?: readonly string[];
  readonly thresholds?: Parameters<typeof createAgentMonitorMiddleware>[0]["thresholds"];
  readonly onAnomaly?: (signal: AnomalySignal) => void;
  readonly onMetrics?: (sessionId: SessionId, summary: SessionMetricsSummary) => void;
  readonly systemPrompt?: string;
};

/** Assemble a KoiRuntime with agent-monitor middleware and the given tools. */
async function buildMonitoredKoi(opts: MonitorOptions): Promise<KoiRuntime> {
  const monitor = createAgentMonitorMiddleware({
    ...(opts.thresholds !== undefined ? { thresholds: opts.thresholds } : {}),
    ...(opts.destructiveToolIds !== undefined
      ? { destructiveToolIds: opts.destructiveToolIds }
      : {}),
    ...(opts.agentDepth !== undefined ? { agentDepth: opts.agentDepth } : {}),
    ...(opts.spawnToolIds !== undefined ? { spawnToolIds: opts.spawnToolIds } : {}),
    ...(opts.onAnomaly !== undefined ? { onAnomaly: opts.onAnomaly } : {}),
    ...(opts.onMetrics !== undefined ? { onMetrics: opts.onMetrics } : {}),
  });

  const adapter = createPiAdapter({
    model: E2E_MODEL,
    systemPrompt:
      opts.systemPrompt ??
      "You are a precise assistant. Follow instructions exactly. Use the provided tools when asked.",
    getApiKey: async (_provider) => ANTHROPIC_KEY,
  });

  return createKoi({
    manifest: TEST_MANIFEST,
    adapter,
    middleware: [monitor],
    providers: [buildProvider(opts.tools)],
    // Keep limits generous so guard middleware doesn't interfere with signal tests
    limits: { maxTurns: 10, maxDurationMs: 90_000, maxTokens: 20_000 },
    // Disable L1 loop detection to avoid false guard hits during signal tests
    loopDetection: false,
  });
}

/** Drain a KoiRuntime run to completion and return all events. */
async function runToCompletion(koi: KoiRuntime, prompt: string): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of koi.run({ kind: "text", text: prompt })) {
    events.push(event);
  }
  return events;
}

/** Wait one microtask tick so fire-and-forget onAnomaly callbacks resolve. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Simple tool executors
// ---------------------------------------------------------------------------

function makeArithmeticExecutor(
  op: "add" | "multiply" | "subtract",
): (args: JsonObject) => Promise<unknown> {
  return async (args) => {
    const a = Number(args.a ?? 0);
    const b = Number(args.b ?? 0);
    const result = op === "add" ? a + b : op === "multiply" ? a * b : a - b;
    return String(result);
  };
}

function makeEchoExecutor(prefix: string): (args: JsonObject) => Promise<unknown> {
  return async (args) => `${prefix}: ${JSON.stringify(args)}`;
}

// ---------------------------------------------------------------------------
// E2E test suite
// ---------------------------------------------------------------------------

describeE2E("e2e: @koi/agent-monitor through createKoi + createPiAdapter", () => {
  // ── Test 1: Baseline — single tool call, onMetrics fires ─────────────────

  test(
    "baseline: onMetrics fires on session end with correct tool and model call counts",
    async () => {
      let capturedSummary: SessionMetricsSummary | undefined;
      let capturedSessionId: SessionId | undefined;
      const signals: AnomalySignal[] = [];

      const koi = await buildMonitoredKoi({
        tools: [
          {
            descriptor: ADD_NUMBERS,
            execute: makeArithmeticExecutor("add"),
          },
        ],
        onAnomaly: (s) => signals.push(s),
        onMetrics: (sid, summary) => {
          capturedSessionId = sid;
          capturedSummary = summary;
        },
      });

      await runToCompletion(
        koi,
        "Use the add_numbers tool to compute 7 + 5. Then tell me the result.",
      );
      await flushMicrotasks();

      // onMetrics must have fired
      expect(capturedSummary).toBeDefined();
      if (capturedSummary === undefined) return;

      // sessionId must be set and consistent
      expect(capturedSessionId).toBeDefined();
      expect(capturedSummary.sessionId).toBeDefined();
      expect(capturedSummary.agentId).toBeDefined();

      // At least 1 tool call and 1 model call
      expect(capturedSummary.totalToolCalls).toBeGreaterThanOrEqual(1);
      expect(capturedSummary.totalModelCalls).toBeGreaterThanOrEqual(1);

      // No errors, no denials for a clean run
      expect(capturedSummary.totalErrorCalls).toBe(0);
      expect(capturedSummary.totalDeniedCalls).toBe(0);

      // anomalyCount is 0 — generous thresholds, normal usage
      expect(capturedSummary.anomalyCount).toBe(0);
      expect(signals.length).toBe(0);
    },
    TIMEOUT_MS,
  );

  // ── Test 2: Baseline — multiple distinct tools, metrics accurate ──────────

  test(
    "baseline: totalToolCalls and anomalyCount are accurate for multi-tool session",
    async () => {
      let capturedSummary: SessionMetricsSummary | undefined;
      const signals: AnomalySignal[] = [];

      const koi = await buildMonitoredKoi({
        tools: [
          { descriptor: ADD_NUMBERS, execute: makeArithmeticExecutor("add") },
          { descriptor: MULTIPLY_NUMBERS, execute: makeArithmeticExecutor("multiply") },
        ],
        onAnomaly: (s) => signals.push(s),
        onMetrics: (_sid, summary) => {
          capturedSummary = summary;
        },
        // Generous thresholds: should not fire for 2-3 tool calls
        thresholds: { maxToolCallsPerTurn: 20, maxConsecutiveRepeatCalls: 10 },
      });

      await runToCompletion(
        koi,
        "Compute 3+4 using add_numbers, then compute 5×6 using multiply_numbers. Report both results.",
      );
      await flushMicrotasks();

      expect(capturedSummary).toBeDefined();
      if (capturedSummary === undefined) return;

      // At least 2 tool calls (one per operation)
      expect(capturedSummary.totalToolCalls).toBeGreaterThanOrEqual(2);
      expect(capturedSummary.turnCount).toBeGreaterThanOrEqual(1);

      // No anomalies with generous thresholds
      expect(capturedSummary.anomalyCount).toBe(0);
      expect(signals.length).toBe(0);
    },
    TIMEOUT_MS,
  );

  // ── Test 3: tool_rate_exceeded ────────────────────────────────────────────

  test(
    "signal tool_rate_exceeded: fires when agent calls more than maxToolCallsPerTurn tools",
    async () => {
      const signals: AnomalySignal[] = [];

      const koi = await buildMonitoredKoi({
        tools: [{ descriptor: ADD_NUMBERS, execute: makeArithmeticExecutor("add") }],
        // Threshold 1: fires when callsPerTurn > 1 (i.e., on the 2nd tool call in a turn)
        thresholds: { maxToolCallsPerTurn: 1 },
        onAnomaly: (s) => signals.push(s),
        systemPrompt:
          "You are a math assistant. When asked to compute multiple sums, " +
          "call the add_numbers tool for EACH calculation as a SEPARATE tool call.",
      });

      await runToCompletion(
        koi,
        "Using add_numbers, compute these three sums separately (one tool call each): " +
          "1+1, 2+2, 3+3. Show me all three results.",
      );
      await flushMicrotasks();

      const rateSignals = signals.filter((s) => s.kind === "tool_rate_exceeded");
      expect(rateSignals.length).toBeGreaterThan(0);

      const first = rateSignals[0];
      expect(first?.kind).toBe("tool_rate_exceeded");
      if (first?.kind === "tool_rate_exceeded") {
        expect(first.callsPerTurn).toBeGreaterThan(1);
        expect(first.threshold).toBe(1);
        expect(first.sessionId).toBeDefined();
        expect(first.agentId).toBeDefined();
        expect(first.timestamp).toBeGreaterThan(0);
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 4: tool_repeated ─────────────────────────────────────────────────

  test(
    "signal tool_repeated: fires when agent calls the same tool consecutively beyond threshold",
    async () => {
      const signals: AnomalySignal[] = [];

      const koi = await buildMonitoredKoi({
        tools: [{ descriptor: ADD_NUMBERS, execute: makeArithmeticExecutor("add") }],
        // Threshold 2: fires when consecutiveRepeatCount > 2 (on the 3rd consecutive call)
        thresholds: { maxConsecutiveRepeatCalls: 2, maxToolCallsPerTurn: 100 },
        onAnomaly: (s) => signals.push(s),
        systemPrompt:
          "You are a math assistant. Always use the add_numbers tool for arithmetic. " +
          "Make separate, sequential tool calls for each calculation.",
      });

      await runToCompletion(
        koi,
        "Use add_numbers to compute these four sums one at a time: 1+1, 2+2, 3+3, 4+4. " +
          "Call the tool separately for each sum.",
      );
      await flushMicrotasks();

      const repeatSignals = signals.filter((s) => s.kind === "tool_repeated");
      expect(repeatSignals.length).toBeGreaterThan(0);

      const first = repeatSignals[0];
      expect(first?.kind).toBe("tool_repeated");
      if (first?.kind === "tool_repeated") {
        expect(first.toolId).toBe("add_numbers");
        expect(first.repeatCount).toBeGreaterThan(2);
        expect(first.threshold).toBe(2);
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 5: tool_diversity_spike (Gap 3) ──────────────────────────────────

  test(
    "signal tool_diversity_spike: fires when too many distinct tools are used in one turn",
    async () => {
      const signals: AnomalySignal[] = [];

      const koi = await buildMonitoredKoi({
        tools: [
          { descriptor: ADD_NUMBERS, execute: makeArithmeticExecutor("add") },
          { descriptor: MULTIPLY_NUMBERS, execute: makeArithmeticExecutor("multiply") },
          { descriptor: SUBTRACT_NUMBERS, execute: makeArithmeticExecutor("subtract") },
        ],
        // Threshold 2: fires when distinctToolCount > 2 (on the 3rd distinct tool)
        thresholds: { maxDistinctToolsPerTurn: 2, maxToolCallsPerTurn: 100 },
        onAnomaly: (s) => signals.push(s),
        systemPrompt:
          "You are a math assistant. Use the appropriate tool for each operation: " +
          "add_numbers for addition, multiply_numbers for multiplication, subtract_numbers for subtraction.",
      });

      await runToCompletion(
        koi,
        "Compute these three results (use a different tool for each): " +
          "2+3 (using add_numbers), 4×5 (using multiply_numbers), 9-3 (using subtract_numbers).",
      );
      await flushMicrotasks();

      const diversitySignals = signals.filter((s) => s.kind === "tool_diversity_spike");
      expect(diversitySignals.length).toBeGreaterThan(0);

      const first = diversitySignals[0];
      expect(first?.kind).toBe("tool_diversity_spike");
      if (first?.kind === "tool_diversity_spike") {
        expect(first.distinctToolCount).toBeGreaterThan(2);
        expect(first.threshold).toBe(2);
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 6: irreversible_action_rate — Gap 1 ──────────────────────────────

  test(
    "signal irreversible_action_rate: fires when destructive tool exceeds per-turn threshold",
    async () => {
      const signals: AnomalySignal[] = [];
      const deletedFiles: string[] = [];

      const koi = await buildMonitoredKoi({
        tools: [
          {
            descriptor: DELETE_FILE,
            execute: async (args) => {
              const filename = String(args.filename ?? "unknown");
              deletedFiles.push(filename);
              return `Deleted: ${filename}`;
            },
          },
        ],
        destructiveToolIds: ["delete_file"],
        // Threshold 1: fires on the 2nd destructive call in a turn
        thresholds: { maxDestructiveCallsPerTurn: 1, maxToolCallsPerTurn: 100 },
        onAnomaly: (s) => signals.push(s),
        systemPrompt:
          "You are a file system assistant. When asked to delete files, call delete_file for each file separately.",
      });

      await runToCompletion(koi, "Delete these two files: report.txt and backup.log.");
      await flushMicrotasks();

      const destructiveSignals = signals.filter((s) => s.kind === "irreversible_action_rate");
      expect(destructiveSignals.length).toBeGreaterThan(0);

      const first = destructiveSignals[0];
      expect(first?.kind).toBe("irreversible_action_rate");
      if (first?.kind === "irreversible_action_rate") {
        expect(first.toolId).toBe("delete_file");
        expect(first.callsThisTurn).toBeGreaterThan(1);
        expect(first.threshold).toBe(1);
      }

      // The tool should have been actually called (confirming wrapToolCall fired)
      expect(deletedFiles.length).toBeGreaterThanOrEqual(2);
    },
    TIMEOUT_MS,
  );

  // ── Test 7: tool_ping_pong — Gap A ───────────────────────────────────────

  test(
    "signal tool_ping_pong: fires when agent alternates between two tools beyond cycle threshold",
    async () => {
      const signals: AnomalySignal[] = [];

      const koi = await buildMonitoredKoi({
        tools: [
          { descriptor: SEARCH_INFO, execute: makeEchoExecutor("search") },
          { descriptor: READ_RESULT, execute: makeEchoExecutor("read") },
        ],
        // Threshold 2: fires when altCount > 2 (4th transition in the A↔B pair)
        thresholds: { maxPingPongCycles: 2, maxToolCallsPerTurn: 100 },
        onAnomaly: (s) => signals.push(s),
        systemPrompt:
          "You are a research assistant. Use search_info to find information, " +
          "then use read_result to read the details. Always alternate: search first, then read.",
      });

      await runToCompletion(
        koi,
        "Research three topics in sequence. For each topic, first call search_info then call read_result:\n" +
          "1. Search for 'alpha', then read result 'alpha-1'\n" +
          "2. Search for 'beta', then read result 'beta-1'\n" +
          "3. Search for 'gamma', then read result 'gamma-1'",
      );
      await flushMicrotasks();

      const pingPongSignals = signals.filter((s) => s.kind === "tool_ping_pong");
      expect(pingPongSignals.length).toBeGreaterThan(0);

      const first = pingPongSignals[0];
      expect(first?.kind).toBe("tool_ping_pong");
      if (first?.kind === "tool_ping_pong") {
        // toolIdA and toolIdB should be the alternating pair
        const pair = new Set([first.toolIdA, first.toolIdB]);
        expect(pair.has("search_info")).toBe(true);
        expect(pair.has("read_result")).toBe(true);
        expect(first.altCount).toBeGreaterThan(2);
        expect(first.threshold).toBe(2);
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 8: onMetrics includes anomalyCount ───────────────────────────────

  test(
    "onMetrics: anomalyCount in summary reflects the number of signals fired during the session",
    async () => {
      let capturedSummary: SessionMetricsSummary | undefined;
      const signals: AnomalySignal[] = [];

      const koi = await buildMonitoredKoi({
        tools: [{ descriptor: ADD_NUMBERS, execute: makeArithmeticExecutor("add") }],
        // Threshold 1: fires on the 2nd call in a turn → guarantees at least one signal
        thresholds: { maxToolCallsPerTurn: 1 },
        onAnomaly: (s) => signals.push(s),
        onMetrics: (_sid, summary) => {
          capturedSummary = summary;
        },
        systemPrompt:
          "You are a math assistant. Compute each sum with a separate add_numbers call.",
      });

      await runToCompletion(koi, "Use add_numbers twice: compute 1+1 and 2+2.");
      await flushMicrotasks();

      expect(capturedSummary).toBeDefined();
      if (capturedSummary === undefined) return;

      // anomalyCount in summary should match signals.length (fire-and-forget timing allows for >=)
      expect(capturedSummary.anomalyCount).toBeGreaterThan(0);
      expect(capturedSummary.anomalyCount).toBeGreaterThanOrEqual(signals.length);
    },
    TIMEOUT_MS,
  );

  // ── Test 9: delegation_depth_exceeded — Phase 2 ──────────────────────────
  //
  // This signal is purely depth + tool-call based: as soon as the LLM calls
  // a spawn tool and agentDepth >= maxDelegationDepth, it fires. No complex
  // behavioural pattern needed — one call is enough.

  test(
    "signal delegation_depth_exceeded: fires when deeply-nested agent calls a spawn tool",
    async () => {
      const signals: AnomalySignal[] = [];
      let spawnCallCount = 0;

      const DELEGATE_TASK: ToolDescriptor = {
        name: "delegate_task",
        description: "Delegates a task to a sub-agent for execution.",
        inputSchema: {
          type: "object",
          properties: {
            task: { type: "string", description: "Description of the task to delegate" },
          },
          required: ["task"],
        },
      };

      const koi = await buildMonitoredKoi({
        tools: [
          {
            descriptor: DELEGATE_TASK,
            execute: async (args) => {
              spawnCallCount += 1;
              return `Delegated: ${String(args.task ?? "")}`;
            },
          },
        ],
        // Simulate an agent already at depth 3 — spawning would violate the limit
        agentDepth: 3,
        spawnToolIds: ["delegate_task"],
        thresholds: { maxDelegationDepth: 3, maxToolCallsPerTurn: 100 },
        onAnomaly: (s) => signals.push(s),
        systemPrompt:
          "You are a task coordinator. Use the delegate_task tool to delegate work to sub-agents.",
      });

      await runToCompletion(
        koi,
        "Use delegate_task to delegate the following: compute the sum of 10 and 20.",
      );
      await flushMicrotasks();

      // The tool must have actually been called
      expect(spawnCallCount).toBeGreaterThanOrEqual(1);

      const depthSignals = signals.filter((s) => s.kind === "delegation_depth_exceeded");
      expect(depthSignals.length).toBeGreaterThan(0);

      const first = depthSignals[0];
      expect(first?.kind).toBe("delegation_depth_exceeded");
      if (first?.kind === "delegation_depth_exceeded") {
        expect(first.currentDepth).toBe(3);
        expect(first.maxDepth).toBe(3);
        expect(first.spawnToolId).toBe("delegate_task");
        expect(first.sessionId).toBeDefined();
        expect(first.agentId).toBeDefined();
        expect(first.timestamp).toBeGreaterThan(0);
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 10: wrapModelStream path — latency tracking ─────────────────────

  test(
    "wrapModelStream path: totalModelCalls and meanLatencyMs populated in session summary",
    async () => {
      let summary: SessionMetricsSummary | undefined;
      const koi = await buildMonitoredKoi({
        tools: [{ descriptor: ADD_NUMBERS, execute: makeArithmeticExecutor("add") }],
        onMetrics: (_sid, s) => {
          summary = s;
        },
      });

      await runToCompletion(koi, "Use add_numbers to compute 3 + 4. Tell me the result.");
      await flushMicrotasks();

      expect(summary).toBeDefined();
      if (!summary) return;

      // Pi adapter dispatches through wrapModelStream (not wrapModelCall).
      // totalModelCalls > 0 proves wrapModelStream incremented the counter.
      expect(summary.totalModelCalls).toBeGreaterThanOrEqual(1);
      // meanLatencyMs > 0 proves Welford state is updated in wrapModelStream.
      expect(summary.meanLatencyMs).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );
});
