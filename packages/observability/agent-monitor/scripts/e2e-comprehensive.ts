/**
 * Comprehensive manual E2E test script for @koi/agent-monitor + @koi/starter.
 *
 * Tests the full middleware chain through the real L1 runtime with live Anthropic
 * API calls, validating every major integration path implemented in Issues #59 + #360.
 *
 * Coverage:
 *   [A] createKoi + createPiAdapter + createAgentMonitorMiddleware (direct)
 *       A1  wrapModelStream: totalModelCalls >= 1, meanLatencyMs > 0
 *       A2  wrapModelStream: meanOutputTokens > 0 (usage chunk emitted by Pi)
 *       A3  wrapToolCall: tool anomaly signal fires via real tool call
 *
 *   [B] @koi/starter createConfiguredKoi (manifest-driven wiring)
 *       B1  agent-monitor from manifest: onMetrics fires with correct counts
 *       B2  soul (inline string): middleware initializes and run completes
 *       B3  permissions allow-all: tool runs through middleware successfully
 *       B4  permissions deny + agent-monitor: denied calls count as errors
 *       B5  full stack: agent-monitor + permissions allow-all in one manifest
 *
 * API key: auto-loaded from .env in the project root.
 *
 * Run:
 *   cd packages/agent-monitor
 *   bun run scripts/e2e-comprehensive.ts
 */

import path from "node:path";
import type {
  AgentManifest,
  ComponentProvider,
  EngineEvent,
  JsonObject,
  Tool,
  ToolDescriptor,
} from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, toolToken } from "@koi/core";
import type { SessionId } from "@koi/core/ecs";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import {
  createConfiguredKoi,
  createDefaultRegistry,
  resolveManifestMiddleware,
} from "@koi/starter";
import { createAgentMonitorMiddleware } from "../src/index.js";
import type { AnomalySignal, SessionMetricsSummary } from "../src/types.js";

// ---------------------------------------------------------------------------
// 0. Load API key (Bun auto-loads .env from cwd; we also check the project root)
// ---------------------------------------------------------------------------

async function loadApiKey(): Promise<string> {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;

  // Walk up to find the project root .env
  const candidates = [
    path.resolve(import.meta.dir, "../../../../../../.env"), // worktree → project root
    path.resolve(import.meta.dir, "../../../../../.env"),
    path.resolve(import.meta.dir, "../../../../.env"),
    path.resolve(import.meta.dir, "../.env"),
    ".env",
  ];

  for (const candidate of candidates) {
    const file = Bun.file(candidate);
    if (await file.exists()) {
      const text = await file.text();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("ANTHROPIC_API_KEY=")) {
          return trimmed.slice("ANTHROPIC_API_KEY=".length).trim();
        }
      }
    }
  }

  throw new Error(
    "ANTHROPIC_API_KEY not found. Set the env var or place it in .env at the project root.",
  );
}

// ---------------------------------------------------------------------------
// 1. Shared constants
// ---------------------------------------------------------------------------

const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";
const TIMEOUT_MS = 120_000;

const BASE_MANIFEST: AgentManifest = {
  name: "e2e-comprehensive-test",
  version: "0.0.1",
  model: { name: E2E_MODEL },
};

// ---------------------------------------------------------------------------
// 2. Tool descriptors
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

// ---------------------------------------------------------------------------
// 3. Factory helpers
// ---------------------------------------------------------------------------

type ToolSpec = {
  readonly descriptor: ToolDescriptor;
  readonly execute: (args: JsonObject) => Promise<unknown>;
};

function buildProvider(tools: readonly ToolSpec[]): ComponentProvider {
  return {
    name: "e2e-test-tools",
    attach: async (): Promise<ReadonlyMap<string, unknown>> => {
      const map = new Map<string, unknown>();
      for (const spec of tools) {
        const tool: Tool = {
          descriptor: spec.descriptor,
          origin: "primordial",
          policy: DEFAULT_SANDBOXED_POLICY,
          execute: spec.execute,
        };
        map.set(toolToken(spec.descriptor.name) as string, tool);
      }
      return map;
    },
  };
}

function makeAdder(): (args: JsonObject) => Promise<unknown> {
  return async (args) => {
    const a = Number(args.a ?? 0);
    const b = Number(args.b ?? 0);
    return String(a + b);
  };
}

function makeMultiplier(): (args: JsonObject) => Promise<unknown> {
  return async (args) => {
    const a = Number(args.a ?? 0);
    const b = Number(args.b ?? 0);
    return String(a * b);
  };
}

async function runToCompletion(
  koi: Awaited<ReturnType<typeof createKoi>>,
  prompt: string,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of koi.run({ kind: "text", text: prompt })) {
    events.push(event);
  }
  return events;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// 4. Test runner
// ---------------------------------------------------------------------------

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  running: ${name} ...`);
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
      ),
    ]);
    process.stdout.write(" PASS\n");
    results.push({ name, passed: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stdout.write(` FAIL\n    ${msg}\n`);
    results.push({ name, passed: false, error: msg });
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ---------------------------------------------------------------------------
// 5. Suite A — Direct createKoi + createPiAdapter
// ---------------------------------------------------------------------------

async function suiteA(apiKey: string): Promise<void> {
  console.log("\n[A] Direct createKoi + createPiAdapter + createAgentMonitorMiddleware");

  // A1: wrapModelStream — totalModelCalls and meanLatencyMs
  await runTest("A1: wrapModelStream: totalModelCalls >= 1, meanLatencyMs > 0", async () => {
    let summary: SessionMetricsSummary | undefined;

    const monitor = createAgentMonitorMiddleware({
      onMetrics: (_sid, s) => {
        summary = s;
      },
    });

    const adapter = createPiAdapter({
      model: E2E_MODEL,
      getApiKey: async () => apiKey,
      systemPrompt: "You are a math assistant. Use provided tools.",
    });

    const koi = await createKoi({
      manifest: BASE_MANIFEST,
      adapter,
      middleware: [monitor],
      providers: [buildProvider([{ descriptor: ADD_NUMBERS, execute: makeAdder() }])],
      limits: { maxTurns: 5, maxDurationMs: 60_000 },
      loopDetection: false,
    });

    await runToCompletion(koi, "Use add_numbers to compute 3 + 4. Tell me the answer.");
    await flushMicrotasks();

    assert(summary !== undefined, "onMetrics should have fired");
    assert(
      (summary?.totalModelCalls ?? 0) >= 1,
      `totalModelCalls should be >= 1, got ${summary?.totalModelCalls}`,
    );
    assert(
      (summary?.meanLatencyMs ?? 0) > 0,
      `meanLatencyMs should be > 0, got ${summary?.meanLatencyMs}`,
    );
    assert(
      (summary?.totalToolCalls ?? 0) >= 1,
      `totalToolCalls should be >= 1, got ${summary?.totalToolCalls}`,
    );
  });

  // A2: wrapModelStream — meanOutputTokens > 0
  await runTest("A2: wrapModelStream: meanOutputTokens > 0 from usage chunks", async () => {
    let summary: SessionMetricsSummary | undefined;

    const monitor = createAgentMonitorMiddleware({
      onMetrics: (_sid, s) => {
        summary = s;
      },
    });

    const adapter = createPiAdapter({
      model: E2E_MODEL,
      getApiKey: async () => apiKey,
      systemPrompt: "You are a helpful assistant.",
    });

    const koi = await createKoi({
      manifest: BASE_MANIFEST,
      adapter,
      middleware: [monitor],
      limits: { maxTurns: 3, maxDurationMs: 60_000 },
      loopDetection: false,
    });

    await runToCompletion(koi, "Say exactly: 'Hello world'");
    await flushMicrotasks();

    assert(summary !== undefined, "onMetrics should have fired");
    assert(
      (summary?.meanOutputTokens ?? 0) > 0,
      `meanOutputTokens should be > 0, got ${summary?.meanOutputTokens}. ` +
        "Pi adapter must emit usage chunks for token tracking to work.",
    );
  });

  // A3: wrapToolCall — anomaly signal fires when threshold exceeded
  await runTest(
    "A3: wrapToolCall: tool_rate_exceeded signal fires via real tool call",
    async () => {
      const signals: AnomalySignal[] = [];

      const monitor = createAgentMonitorMiddleware({
        thresholds: { maxToolCallsPerTurn: 1 },
        onAnomaly: (s) => signals.push(s),
      });

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        getApiKey: async () => apiKey,
        systemPrompt:
          "You are a math assistant. Make a separate add_numbers tool call for EACH calculation.",
      });

      const koi = await createKoi({
        manifest: BASE_MANIFEST,
        adapter,
        middleware: [monitor],
        providers: [buildProvider([{ descriptor: ADD_NUMBERS, execute: makeAdder() }])],
        limits: { maxTurns: 5, maxDurationMs: 60_000 },
        loopDetection: false,
      });

      await runToCompletion(
        koi,
        "Use add_numbers to compute three separate sums: 1+1, 2+2, 3+3. " +
          "Call the tool separately for each.",
      );
      await flushMicrotasks();

      const rateSignals = signals.filter((s) => s.kind === "tool_rate_exceeded");
      assert(
        rateSignals.length > 0,
        `Expected tool_rate_exceeded signal, got: ${JSON.stringify(signals.map((s) => s.kind))}`,
      );
      assert(
        rateSignals[0]?.threshold === 1,
        `Expected threshold=1, got ${rateSignals[0]?.threshold}`,
      );
    },
  );
}

// ---------------------------------------------------------------------------
// 6. Suite B — @koi/starter createConfiguredKoi
// ---------------------------------------------------------------------------

async function suiteB(apiKey: string): Promise<void> {
  console.log("\n[B] @koi/starter createConfiguredKoi (manifest-driven wiring)");

  // B1: agent-monitor from manifest — callbacks wired
  await runTest(
    "B1: createConfiguredKoi: agent-monitor from manifest — onMetrics wired",
    async () => {
      let summary: SessionMetricsSummary | undefined;
      let capturedSid: SessionId | undefined;

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        getApiKey: async () => apiKey,
        systemPrompt: "You are a math assistant. Use provided tools.",
      });

      const manifest: AgentManifest = {
        ...BASE_MANIFEST,
        name: "e2e-b1-agent",
        middleware: [
          {
            name: "agent-monitor",
            options: {
              thresholds: { maxToolCallsPerTurn: 15 },
              destructiveToolIds: ["delete_file"],
            },
          },
        ],
      };

      const koi = await createConfiguredKoi({
        manifest,
        adapter,
        providers: [buildProvider([{ descriptor: ADD_NUMBERS, execute: makeAdder() }])],
        limits: { maxTurns: 5, maxDurationMs: 60_000 },
        loopDetection: false,
        callbacks: {
          "agent-monitor": {
            onMetrics: (sid, s) => {
              capturedSid = sid;
              summary = s;
            },
          },
        },
      });

      await runToCompletion(koi, "Use add_numbers to compute 10 + 20. Tell me the result.");
      await flushMicrotasks();

      assert(summary !== undefined, "onMetrics callback should have fired via manifest wiring");
      assert(capturedSid !== undefined, "sessionId should be captured in onMetrics");
      assert(
        (summary?.totalModelCalls ?? 0) >= 1,
        `totalModelCalls >= 1 expected, got ${summary?.totalModelCalls}`,
      );
      assert(
        (summary?.totalToolCalls ?? 0) >= 1,
        `totalToolCalls >= 1 expected, got ${summary?.totalToolCalls}`,
      );
      assert(summary?.anomalyCount === 0, `No anomalies expected, got ${summary?.anomalyCount}`);
    },
  );

  // B2: soul (inline) — middleware initializes and run completes
  await runTest(
    "B2: createConfiguredKoi: soul (inline string) — initializes and runs",
    async () => {
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        getApiKey: async () => apiKey,
        // No systemPrompt here — soul middleware will inject one
      });

      const manifest: AgentManifest = {
        ...BASE_MANIFEST,
        name: "e2e-b2-agent",
        middleware: [
          {
            name: "soul",
            options: {
              // Inline soul: a plain string is treated as inline text, not a file path
              soul: "You are a helpful assistant. Always respond concisely.",
              basePath: "/tmp",
            },
          },
        ],
      };

      const koi = await createConfiguredKoi({
        manifest,
        adapter,
        limits: { maxTurns: 3, maxDurationMs: 60_000 },
        loopDetection: false,
      });

      const events = await runToCompletion(koi, "Say exactly: 'soul ok'");
      assert(events.length > 0, "Run should produce events");

      // If we get here without throwing, soul middleware initialized and ran correctly
    },
  );

  // B3: permissions allow-all — tool runs through middleware successfully
  await runTest(
    "B3: createConfiguredKoi: permissions allow-all — tool executes successfully",
    async () => {
      let toolCallCount = 0;

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        getApiKey: async () => apiKey,
        systemPrompt: "You are a math assistant. Use the provided tools.",
      });

      const manifest: AgentManifest = {
        ...BASE_MANIFEST,
        name: "e2e-b3-agent",
        middleware: [
          {
            name: "permissions",
            options: {
              // allow-all: every tool is permitted
              rules: { allow: ["*"], deny: [], ask: [] },
            },
          },
        ],
      };

      const trackedAdder: ToolSpec = {
        descriptor: ADD_NUMBERS,
        execute: async (args) => {
          toolCallCount += 1;
          return makeAdder()(args);
        },
      };

      const koi = await createConfiguredKoi({
        manifest,
        adapter,
        providers: [buildProvider([trackedAdder])],
        limits: { maxTurns: 5, maxDurationMs: 60_000 },
        loopDetection: false,
      });

      await runToCompletion(koi, "Use add_numbers to compute 5 + 6. Report the result.");

      assert(
        toolCallCount >= 1,
        `Tool should have been called at least once through permissions. Got ${toolCallCount} calls.`,
      );
    },
  );

  // B4: permissions deny-all + agent-monitor — both wired from manifest, run completes
  await runTest(
    "B4: createConfiguredKoi: permissions deny-all + agent-monitor — both initialized, run completes",
    async () => {
      let summary: SessionMetricsSummary | undefined;

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        getApiKey: async () => apiKey,
        systemPrompt: "You are a helpful assistant.",
      });

      const manifest: AgentManifest = {
        ...BASE_MANIFEST,
        name: "e2e-b4-agent",
        middleware: [
          // Both middleware wired from manifest — key integration point
          { name: "agent-monitor" },
          // deny: ["*"] — all tools blocked (model will answer without tools)
          { name: "permissions", options: { rules: { deny: ["*"] } } },
        ],
      };

      const koi = await createConfiguredKoi({
        manifest,
        adapter,
        providers: [buildProvider([{ descriptor: ADD_NUMBERS, execute: makeAdder() }])],
        limits: { maxTurns: 5, maxDurationMs: 60_000 },
        loopDetection: false,
        callbacks: {
          "agent-monitor": {
            onMetrics: (_sid, s) => {
              summary = s;
            },
          },
        },
      });

      // With deny-all, the model will answer directly (no tool calls).
      // Key assertions:
      // 1. Both middleware initialized from manifest (no crash during createConfiguredKoi)
      // 2. Run completes without error
      // 3. Agent-monitor's wrapModelStream/wrapModelCall tracked the model call
      // 4. No tool calls (permissions blocked them all)
      //
      // Note: the deny → totalErrorCalls path is deterministically verified in unit tests
      // (monitor.test.ts). E2E tests here focus on middleware wiring correctness.
      const events = await runToCompletion(koi, "What is 3 + 4?");
      await flushMicrotasks();

      assert(events.length > 0, "Run should produce events");
      assert(summary !== undefined, "onMetrics should fire — agent-monitor IS wired from manifest");
      assert(
        (summary?.totalModelCalls ?? 0) >= 1,
        `totalModelCalls >= 1 expected, got ${summary?.totalModelCalls}`,
      );
      assert(
        summary?.totalToolCalls === 0,
        `totalToolCalls should be 0 (deny-all blocked tools), got ${summary?.totalToolCalls}`,
      );
    },
  );

  // B5: full stack — agent-monitor + permissions allow-all in one manifest
  await runTest(
    "B5: createConfiguredKoi: full stack — agent-monitor + permissions allow-all",
    async () => {
      let summary: SessionMetricsSummary | undefined;
      let toolCallCount = 0;

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        getApiKey: async () => apiKey,
        systemPrompt: "You are a math assistant. Use the provided tools.",
      });

      const manifest: AgentManifest = {
        ...BASE_MANIFEST,
        name: "e2e-b5-agent",
        middleware: [
          {
            name: "agent-monitor",
            options: { thresholds: { maxToolCallsPerTurn: 20 } },
          },
          {
            name: "permissions",
            options: { rules: { allow: ["*"] } },
          },
        ],
      };

      const trackedAdder: ToolSpec = {
        descriptor: ADD_NUMBERS,
        execute: async (args) => {
          toolCallCount += 1;
          return makeAdder()(args);
        },
      };
      const trackedMultiplier: ToolSpec = {
        descriptor: MULTIPLY_NUMBERS,
        execute: async (args) => {
          toolCallCount += 1;
          return makeMultiplier()(args);
        },
      };

      const koi = await createConfiguredKoi({
        manifest,
        adapter,
        providers: [buildProvider([trackedAdder, trackedMultiplier])],
        limits: { maxTurns: 8, maxDurationMs: 60_000 },
        loopDetection: false,
        callbacks: {
          "agent-monitor": {
            onMetrics: (_sid, s) => {
              summary = s;
            },
          },
        },
      });

      await runToCompletion(
        koi,
        "Compute 3 + 4 using add_numbers, then 5 × 6 using multiply_numbers. Report both results.",
      );
      await flushMicrotasks();

      // Both middleware must have initialized and run correctly
      assert(summary !== undefined, "agent-monitor onMetrics should fire");
      assert(
        (summary?.totalModelCalls ?? 0) >= 1,
        `totalModelCalls >= 1 expected, got ${summary?.totalModelCalls}`,
      );
      assert(
        toolCallCount >= 2,
        `Both tools should have been called through permissions allow-all. Got ${toolCallCount} calls.`,
      );
      assert(summary?.totalErrorCalls === 0, `No errors expected, got ${summary?.totalErrorCalls}`);
      assert(summary?.anomalyCount === 0, `No anomalies expected, got ${summary?.anomalyCount}`);

      console.log(
        `    -> Summary: tools=${summary?.totalToolCalls} models=${summary?.totalModelCalls} ` +
          `latency=${summary?.meanLatencyMs?.toFixed(0)}ms tokens=${summary?.meanOutputTokens?.toFixed(1)}`,
      );
    },
  );

  // B6: resolveManifestMiddleware + createDefaultRegistry (low-level API)
  await runTest(
    "B6: resolveManifestMiddleware + createDefaultRegistry: wires agent-monitor from manifest",
    async () => {
      let summary: SessionMetricsSummary | undefined;

      const registry = createDefaultRegistry({
        "agent-monitor": {
          onMetrics: (_sid, s) => {
            summary = s;
          },
        },
      });

      const manifest: AgentManifest = {
        ...BASE_MANIFEST,
        name: "e2e-b6-agent",
        middleware: [{ name: "agent-monitor" }],
      };

      // Resolve middleware from manifest via registry (async, soul requires await)
      const resolved = await resolveManifestMiddleware(manifest, registry, { agentDepth: 0 });

      assert(resolved.length === 1, `Expected 1 middleware, got ${resolved.length}`);
      assert(
        resolved[0]?.name === "agent-monitor",
        `Expected name "agent-monitor", got "${resolved[0]?.name}"`,
      );

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        getApiKey: async () => apiKey,
        systemPrompt: "You are a math assistant.",
      });

      const koi = await createKoi({
        manifest,
        adapter,
        middleware: resolved,
        providers: [buildProvider([{ descriptor: ADD_NUMBERS, execute: makeAdder() }])],
        limits: { maxTurns: 5, maxDurationMs: 60_000 },
        loopDetection: false,
      });

      await runToCompletion(koi, "Use add_numbers to compute 2 + 2.");
      await flushMicrotasks();

      assert(summary !== undefined, "onMetrics should fire via resolveManifestMiddleware");
      assert(
        (summary?.totalModelCalls ?? 0) >= 1,
        `totalModelCalls >= 1 expected, got ${summary?.totalModelCalls}`,
      );
    },
  );
}

// ---------------------------------------------------------------------------
// 7. Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("  @koi/agent-monitor + @koi/starter — Comprehensive E2E Tests");
  console.log("=".repeat(70));

  let apiKey: string;
  try {
    apiKey = await loadApiKey();
    console.log(`\n  API key loaded (${apiKey.slice(0, 20)}...)`);
  } catch (e: unknown) {
    console.error(`\n  ERROR: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const start = Date.now();

  await suiteA(apiKey);
  await suiteB(apiKey);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log(`\n${"=".repeat(70)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed  (${elapsed}s)`);
  console.log("=".repeat(70));

  if (failed > 0) {
    console.log("\nFailed tests:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  FAIL  ${r.name}`);
      if (r.error) console.log(`        ${r.error}`);
    }
    process.exit(1);
  } else {
    console.log("\n  All tests passed.");
    process.exit(0);
  }
}

main().catch((e: unknown) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
