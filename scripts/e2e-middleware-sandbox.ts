#!/usr/bin/env bun

/**
 * E2E test script for @koi/middleware-sandbox — validates that sandbox policy
 * enforcement (timeout, output truncation, tier resolution, observability)
 * works end-to-end through the full middleware composition chain with a real
 * Anthropic LLM call + Pi agent.
 *
 * Tests:
 *   1. Sandbox middleware wraps tool calls — onSandboxMetrics fires
 *   2. Promoted tool skips sandbox wrapping entirely
 *   3. Output truncation triggers on oversized output
 *   4. Full Pi agent run: real LLM triggers tool → sandbox middleware wraps it
 *   5. Timeout enforcement fires on slow tool
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-middleware-sandbox.ts
 *
 *   Or if .env has ANTHROPIC_API_KEY:
 *   bun scripts/e2e-middleware-sandbox.ts
 *
 * Cost: ~$0.01-0.03 per run (haiku model, minimal prompts).
 */

import { createPiAdapter } from "../packages/drivers/engine-pi/src/adapter.js";
import type { TrustTier } from "../packages/kernel/core/src/ecs.js";
import { toolToken } from "../packages/kernel/core/src/ecs.js";
import type {
  ComponentProvider,
  EngineEvent,
  Tool,
  ToolHandler,
  ToolRequest,
  ToolResponse,
} from "../packages/kernel/core/src/index.js";
import type { SandboxProfile } from "../packages/kernel/core/src/sandbox-profile.js";
import { composeToolChain } from "../packages/kernel/engine/src/compose.js";
import { createKoi } from "../packages/kernel/engine/src/koi.js";
import { KoiRuntimeError } from "../packages/lib/errors/src/index.js";
import { createMockTurnContext } from "../packages/lib/test-utils/src/index.js";
import { createSandboxMiddleware } from "../packages/middleware/middleware-sandbox/src/index.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Skipping E2E tests.");
  process.exit(0);
}

console.log("[e2e] Starting middleware-sandbox E2E tests...\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

const results: TestResult[] = []; // let justified: test accumulator

function assert(name: string, condition: boolean, detail?: string): void {
  results.push({ name, passed: condition, detail });
  const tag = condition ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${tag}  ${name}`);
  if (detail && !condition) console.log(`         ${detail}`);
}

function makeProfile(tier: TrustTier, timeoutMs: number): SandboxProfile {
  return {
    tier,
    filesystem: {},
    network: { allow: false },
    resources: { timeoutMs },
  };
}

function profileFor(tier: TrustTier): SandboxProfile {
  switch (tier) {
    case "sandbox":
      return makeProfile("sandbox", 5_000);
    case "verified":
      return makeProfile("verified", 10_000);
    case "promoted":
      return makeProfile("promoted", 30_000);
  }
}

const ctx = createMockTurnContext();

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const result: EngineEvent[] = []; // let justified: test accumulator
  for await (const event of iterable) {
    result.push(event);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Test 1 — Sandbox middleware wraps tool calls, onSandboxMetrics fires
// ---------------------------------------------------------------------------

console.log("[test 1] Sandbox middleware wraps tool calls — metrics callback fires");

const metricsLog1: Array<{
  readonly toolId: string;
  readonly tier: TrustTier;
  readonly durationMs: number;
  readonly outputBytes: number;
  readonly truncated: boolean;
}> = []; // let justified: test accumulator

const tierMap1: Record<string, TrustTier> = { get_weather: "sandbox" };

const sandboxMw1 = createSandboxMiddleware({
  profileFor,
  tierFor: (toolId: string) => tierMap1[toolId],
  timeoutGraceMs: 5_000,
  onSandboxMetrics: (toolId, tier, durationMs, outputBytes, truncated) => {
    metricsLog1.push({ toolId, tier, durationMs, outputBytes, truncated });
  },
});

const weatherTerminal: ToolHandler = async (_request: ToolRequest): Promise<ToolResponse> => {
  return { output: { temperature: "22C", condition: "sunny", city: "Tokyo" } };
};

const toolChain1 = composeToolChain([sandboxMw1], weatherTerminal);
const response1 = await toolChain1(ctx, { toolId: "get_weather", input: { city: "Tokyo" } });

assert(
  "tool returned expected output",
  (response1.output as { temperature: string }).temperature === "22C",
);
assert("onSandboxMetrics fired once", metricsLog1.length === 1, `Got ${metricsLog1.length}`);

const metric1 = metricsLog1[0];
if (metric1) {
  assert("metric toolId is get_weather", metric1.toolId === "get_weather");
  assert("metric tier is sandbox", metric1.tier === "sandbox");
  assert("metric durationMs >= 0", metric1.durationMs >= 0, `Got ${metric1.durationMs}`);
  assert("metric outputBytes > 0", metric1.outputBytes > 0, `Got ${metric1.outputBytes}`);
  assert("metric truncated is false", metric1.truncated === false);
}

// ---------------------------------------------------------------------------
// Test 2 — Promoted tool skips sandbox wrapping entirely
// ---------------------------------------------------------------------------

console.log("\n[test 2] Promoted tool skips sandbox wrapping — no metrics");

const metricsLog2: unknown[] = []; // let justified: test accumulator
const tierMap2: Record<string, TrustTier> = { trusted_tool: "promoted" };

const sandboxMw2 = createSandboxMiddleware({
  profileFor,
  tierFor: (toolId: string) => tierMap2[toolId],
  onSandboxMetrics: () => {
    metricsLog2.push(true);
  },
});

const trustedTerminal: ToolHandler = async (): Promise<ToolResponse> => {
  return { output: { status: "ok" } };
};

const toolChain2 = composeToolChain([sandboxMw2], trustedTerminal);
const response2 = await toolChain2(ctx, { toolId: "trusted_tool", input: {} });

assert("promoted tool returned output", (response2.output as { status: string }).status === "ok");
assert("no metrics fired for promoted tier", metricsLog2.length === 0, `Got ${metricsLog2.length}`);

// ---------------------------------------------------------------------------
// Test 3 — Output truncation triggers on oversized output
// ---------------------------------------------------------------------------

console.log("\n[test 3] Output truncation on oversized tool output");

const metricsLog3: Array<{ readonly truncated: boolean; readonly outputBytes: number }> = [];

const sandboxMw3 = createSandboxMiddleware({
  profileFor,
  tierFor: () => "sandbox",
  outputLimitBytes: 50, // very small limit
  timeoutGraceMs: 5_000,
  onSandboxMetrics: (_toolId, _tier, _d, outputBytes, truncated) => {
    metricsLog3.push({ outputBytes, truncated });
  },
});

const bigOutputTerminal: ToolHandler = async (): Promise<ToolResponse> => {
  return { output: { data: "A".repeat(200), extra: "B".repeat(200) } };
};

const toolChain3 = composeToolChain([sandboxMw3], bigOutputTerminal);
const response3 = await toolChain3(ctx, { toolId: "big_tool", input: {} });

assert("output is a truncated string", typeof response3.output === "string");
assert(
  "output ends with truncation marker",
  (response3.output as string).endsWith("...[truncated]"),
  `Got: "${(response3.output as string).slice(-30)}"`,
);
assert("metadata.truncated is true", response3.metadata?.truncated === true);
assert("metadata.originalBytes is a number", typeof response3.metadata?.originalBytes === "number");
assert(
  "metrics show truncated=true",
  metricsLog3[0]?.truncated === true,
  `Got: ${JSON.stringify(metricsLog3[0])}`,
);

// ---------------------------------------------------------------------------
// Test 4 — Full Pi agent (createPiAdapter): real LLM triggers tool → sandbox wraps it
// ---------------------------------------------------------------------------

console.log(
  "\n[test 4] Full Pi agent (createPiAdapter) — real LLM + tool call through sandbox middleware",
);

const PI_MODEL = "anthropic:claude-haiku-4-5-20251001";
const TIMEOUT_MS = 60_000;

const metricsLog4: Array<{
  readonly toolId: string;
  readonly tier: TrustTier;
  readonly durationMs: number;
}> = [];

let toolExecuted4 = false; // let justified: toggled in tool execute

const weatherTool4: Tool = {
  descriptor: {
    name: "get_weather",
    description: "Get the current weather for a city. Returns JSON with temperature and condition.",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  },
  trustTier: "sandbox",
  execute: async () => {
    toolExecuted4 = true;
    return { temperature: "22C", condition: "sunny" };
  },
};

const toolProvider4: ComponentProvider = {
  name: "e2e-sandbox-tool-provider",
  attach: async () => {
    const components = new Map<string, unknown>();
    components.set(toolToken("get_weather"), weatherTool4);
    return components;
  },
};

const sandboxMw4 = createSandboxMiddleware({
  profileFor,
  tierFor: (toolId: string) => {
    if (toolId === "get_weather") return "sandbox";
    return undefined;
  },
  timeoutGraceMs: 5_000,
  failClosedOnLookupError: true,
  onSandboxMetrics: (toolId, tier, durationMs) => {
    metricsLog4.push({ toolId, tier, durationMs });
  },
  onSandboxError: (toolId, tier, code, message) => {
    console.log(`  [sandbox-error] ${toolId} (${tier}): ${code} — ${message}`);
  },
});

// Real Pi adapter — full Anthropic LLM calls, no deterministic shortcuts
const piAdapter4 = createPiAdapter({
  model: PI_MODEL,
  systemPrompt: [
    'You have ONE task: call the get_weather tool with city "Tokyo".',
    "After getting the result, report the temperature.",
    "Do NOT say anything before calling the tool. Just call it immediately.",
  ].join("\n"),
  getApiKey: async () => API_KEY,
});

const runtime4 = await createKoi({
  manifest: { name: "e2e-sandbox-pi", version: "0.0.1", model: { name: PI_MODEL } },
  adapter: piAdapter4,
  middleware: [sandboxMw4],
  providers: [toolProvider4],
  limits: { maxTurns: 10, maxDurationMs: TIMEOUT_MS, maxTokens: 50_000 },
});

try {
  const events4 = await Promise.race([
    collectEvents(runtime4.run({ kind: "text", text: "What is the weather in Tokyo?" })),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Test 4 timed out after 60s")), TIMEOUT_MS),
    ),
  ]);

  const doneEvent = events4.find((e) => e.kind === "done");
  assert("pi agent completed", doneEvent !== undefined);
  if (doneEvent?.kind === "done") {
    assert("stop reason is completed", doneEvent.output.stopReason === "completed");
  }

  assert("tool was executed via pi agent", toolExecuted4 === true);
  assert(
    "sandbox metrics fired for get_weather",
    metricsLog4.some((m) => m.toolId === "get_weather"),
    `Metrics: ${JSON.stringify(metricsLog4)}`,
  );

  const weatherMetric = metricsLog4.find((m) => m.toolId === "get_weather");
  if (weatherMetric) {
    assert("metric tier is sandbox", weatherMetric.tier === "sandbox");
    assert("metric durationMs >= 0", weatherMetric.durationMs >= 0);
  }

  // Verify Pi adapter emitted tool call events through the sandbox middleware
  const toolCallEvents = events4.filter(
    (e) => e.kind === "tool_call_start" || e.kind === "tool_call_end",
  );
  assert(
    "pi agent produced tool_call events",
    toolCallEvents.length >= 2,
    `Got ${toolCallEvents.length} tool_call events`,
  );

  console.log(`  Pi agent completed with ${events4.length} events`);
} finally {
  await runtime4.dispose?.();
}

// ---------------------------------------------------------------------------
// Test 5 — Timeout enforcement on slow tool
// ---------------------------------------------------------------------------

console.log("\n[test 5] Timeout enforcement fires on slow tool");

const errorsLog5: Array<{ readonly toolId: string; readonly code: string }> = [];

const sandboxMw5 = createSandboxMiddleware({
  profileFor: (tier: TrustTier) => makeProfile(tier, 100), // 100ms timeout
  tierFor: () => "sandbox",
  timeoutGraceMs: 50, // total = 150ms
  onSandboxError: (toolId, _tier, code) => {
    errorsLog5.push({ toolId, code });
  },
});

const slowTerminal: ToolHandler = async (): Promise<ToolResponse> => {
  await new Promise((resolve) => setTimeout(resolve, 1_000)); // 1s >> 150ms
  return { output: { data: "should not reach" } };
};

const toolChain5 = composeToolChain([sandboxMw5], slowTerminal);

let timeoutErrorCaught = false; // let justified: toggled in catch
try {
  await toolChain5(ctx, { toolId: "slow_tool", input: {} });
} catch (error: unknown) {
  // instanceof may fail across source/dist module boundaries, so also check duck-typed code
  const isKoiTimeout =
    (error instanceof KoiRuntimeError && error.code === "TIMEOUT") ||
    (error instanceof Error &&
      "code" in error &&
      (error as { readonly code: string }).code === "TIMEOUT");
  if (isKoiTimeout) {
    timeoutErrorCaught = true;
  }
}

assert("TIMEOUT error thrown for slow tool", timeoutErrorCaught === true);
assert(
  "onSandboxError fired",
  errorsLog5.length === 1,
  `Got ${errorsLog5.length} errors: ${JSON.stringify(errorsLog5)}`,
);
assert("error code is TIMEOUT", errorsLog5[0]?.code === "TIMEOUT", `Got: ${errorsLog5[0]?.code}`);
assert(
  "error toolId is slow_tool",
  errorsLog5[0]?.toolId === "slow_tool",
  `Got: ${errorsLog5[0]?.toolId}`,
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.passed).length;
const total = results.length;
const allPassed = passed === total;

console.log(`\n${"─".repeat(60)}`);
console.log(`[e2e] Results: ${passed}/${total} passed`);
console.log("─".repeat(60));

if (!allPassed) {
  console.error("\n[e2e] Failed assertions:");
  for (const r of results) {
    if (!r.passed) {
      console.error(`  FAIL  ${r.name}`);
      if (r.detail) console.error(`        ${r.detail}`);
    }
  }
  process.exit(1);
}

console.log("\n[e2e] ALL MIDDLEWARE-SANDBOX E2E TESTS PASSED!");
