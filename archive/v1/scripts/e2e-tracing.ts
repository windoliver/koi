#!/usr/bin/env bun

/**
 * Manual E2E test: @koi/tracing → real LLM call → OTel span verification.
 *
 * Assembles a real agent with the tracing middleware, makes one Anthropic
 * API call, and verifies the full span hierarchy:
 *   Session → Turn → Model Call (gen_ai.chat)
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-tracing.ts
 */

import { createLoopAdapter } from "../packages/drivers/engine-loop/src/loop-adapter.js";
import { createAnthropicAdapter } from "../packages/drivers/model-router/src/adapters/anthropic.js";
import type { EngineEvent, ModelRequest } from "../packages/kernel/core/src/index.js";
import { createKoi } from "../packages/kernel/engine/src/koi.js";
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  KOI_AGENT_ID,
  KOI_SESSION_ID,
  KOI_TURN_INDEX,
} from "../packages/observability/tracing/src/semantic-conventions.js";
import type { ReadableSpan } from "../packages/observability/tracing/src/test-setup.js";
import { createTestTracer } from "../packages/observability/tracing/src/test-setup.js";
import { createTracingMiddleware } from "../packages/observability/tracing/src/tracing.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Skipping.");
  process.exit(1);
}

console.log("[e2e] Starting tracing E2E test...\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestResult {
  readonly name: string;
  readonly passed: boolean;
}

const results: TestResult[] = [];

function assert(name: string, condition: boolean): void {
  results.push({ name, passed: condition });
  const tag = condition ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${tag}  ${name}`);
}

function printReport(): void {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  console.log(`\n${"\u2500".repeat(60)}`);
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  console.log("\u2500".repeat(60));

  if (failed > 0) {
    console.log("\nFailed tests:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  - ${r.name}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Set up OTel tracing infrastructure
// ---------------------------------------------------------------------------

console.log("[setup] Initializing OTel tracing...");

const testTracer = createTestTracer();

console.log("[setup] Tracer ready\n");

// ---------------------------------------------------------------------------
// 2. Assemble agent with tracing middleware
// ---------------------------------------------------------------------------

console.log("[setup] Assembling agent with tracing middleware...");

const anthropic = createAnthropicAdapter({ apiKey: API_KEY });
const modelCall = (request: ModelRequest) =>
  anthropic.complete({ ...request, model: "claude-sonnet-4-5-20250929" });

const loopAdapter = createLoopAdapter({ modelCall, maxTurns: 1 });

const tracingMiddleware = createTracingMiddleware({
  tracer: testTracer.tracer,
  captureContent: true,
  onError: (e) => console.error("[tracing-error]", e),
});

const runtime = await createKoi({
  manifest: {
    name: "tracing-e2e",
    version: "0.1.0",
    model: { name: "claude-sonnet-4-5" },
  },
  adapter: loopAdapter,
  middleware: [tracingMiddleware],
  loopDetection: false,
});

console.log(`[setup] Agent assembled (state: ${runtime.agent.state})`);
console.log(`[setup] Sending: "Say hello in exactly 3 words."\n`);

// ---------------------------------------------------------------------------
// 3. Run a real LLM call
// ---------------------------------------------------------------------------

let fullResponse = "";
const events: EngineEvent[] = [];

for await (const event of runtime.run({
  kind: "text",
  text: "Say hello in exactly 3 words.",
})) {
  events.push(event);
  if (event.kind === "text_delta") {
    fullResponse += event.delta;
    process.stdout.write(event.delta);
  } else if (event.kind === "done") {
    console.log(
      `\n\n  [done] stopReason=${event.output.stopReason} turns=${event.output.metrics.turns}`,
    );
    console.log(
      `  [done] tokens: ${event.output.metrics.inputTokens} in / ${event.output.metrics.outputTokens} out`,
    );
  }
}

// ---------------------------------------------------------------------------
// 4. Verify spans
// ---------------------------------------------------------------------------

console.log("\n[test] Verifying tracing spans...\n");

const spans = testTracer.getFinishedSpans();

assert("at least 1 span exported", spans.length >= 1);
assert("response is non-empty", fullResponse.length > 0);

// --- Session span ---
const sessionSpan = spans.find((s) => s.name === "koi.session");
assert("session span exists", sessionSpan !== undefined);
assert(
  "session span has koi.session.id attribute",
  sessionSpan?.attributes[KOI_SESSION_ID] !== undefined,
);
assert(
  "session span has koi.agent.id attribute",
  sessionSpan?.attributes[KOI_AGENT_ID] !== undefined,
);

// --- Turn span ---
const turnSpan = spans.find((s) => s.name === "koi.turn");
assert("turn span exists", turnSpan !== undefined);
assert("turn span has koi.turn.index = 0", turnSpan?.attributes[KOI_TURN_INDEX] === 0);

// --- Turn is child of Session ---
if (sessionSpan && turnSpan) {
  assert(
    "turn span is child of session span",
    turnSpan.parentSpanContext?.spanId === sessionSpan.spanContext().spanId,
  );
}

// --- Model call span ---
const modelSpan = spans.find((s) => s.name === "gen_ai.chat");
assert("model call span exists", modelSpan !== undefined);
assert(
  'model call has gen_ai.operation.name = "chat"',
  modelSpan?.attributes[GEN_AI_OPERATION_NAME] === "chat",
);
// Note: gen_ai.request.model may be absent when model is set by the adapter
// (modelCall wrapper) rather than on the incoming ModelRequest object.
// gen_ai.response.model is the reliable indicator — it's set from the response.
assert(
  "model call has gen_ai.response.model (from LLM response)",
  typeof modelSpan?.attributes[GEN_AI_RESPONSE_MODEL] === "string",
);
assert(
  "model call has gen_ai.usage.input_tokens > 0",
  typeof modelSpan?.attributes[GEN_AI_USAGE_INPUT_TOKENS] === "number" &&
    modelSpan.attributes[GEN_AI_USAGE_INPUT_TOKENS] > 0,
);
assert(
  "model call has gen_ai.usage.output_tokens > 0",
  typeof modelSpan?.attributes[GEN_AI_USAGE_OUTPUT_TOKENS] === "number" &&
    modelSpan.attributes[GEN_AI_USAGE_OUTPUT_TOKENS] > 0,
);

// --- Model call is child of Turn ---
if (turnSpan && modelSpan) {
  assert(
    "model call span is child of turn span",
    modelSpan.parentSpanContext?.spanId === turnSpan.spanContext().spanId,
  );
}

// --- Content capture ---
assert(
  "model call has captured request content",
  modelSpan?.attributes["koi.request.content"] !== undefined,
);
assert(
  "model call has captured response content",
  modelSpan?.attributes["koi.response.content"] !== undefined,
);

// --- Done event ---
const doneEvent = events.find((e) => e.kind === "done");
assert(
  "run completed successfully",
  doneEvent?.kind === "done" && doneEvent.output.stopReason === "completed",
);

// ---------------------------------------------------------------------------
// 5. Print span tree
// ---------------------------------------------------------------------------

console.log("\n[trace] Span tree:\n");

function printSpan(span: ReadableSpan, depth: number): void {
  const prefix = "  ".repeat(depth);
  const durationMs =
    Number(span.endTime[0] - span.startTime[0]) * 1000 +
    (span.endTime[1] - span.startTime[1]) / 1e6;
  console.log(`${prefix}[${span.name}] (${durationMs.toFixed(1)}ms)`);

  for (const [key, value] of Object.entries(span.attributes)) {
    if (key.startsWith("koi.request.content") || key.startsWith("koi.response.content")) {
      const strVal = String(value);
      console.log(`${prefix}  ${key} = ${strVal.slice(0, 80)}${strVal.length > 80 ? "..." : ""}`);
    } else {
      console.log(`${prefix}  ${key} = ${value}`);
    }
  }
}

// Build parent→children map
const childMap = new Map<string, ReadableSpan[]>();
for (const span of spans) {
  const parentId = span.parentSpanContext?.spanId;
  if (parentId !== undefined) {
    const children = childMap.get(parentId) ?? [];
    children.push(span);
    childMap.set(parentId, children);
  }
}

function printTree(span: ReadableSpan, depth: number): void {
  printSpan(span, depth);
  const children = childMap.get(span.spanContext().spanId) ?? [];
  for (const child of children) {
    printTree(child, depth + 1);
  }
}

const rootSpans = spans.filter(
  (s) =>
    s.parentSpanContext === undefined ||
    !spans.some((other) => other.spanContext().spanId === s.parentSpanContext?.spanId),
);

for (const root of rootSpans) {
  printTree(root, 1);
}

// ---------------------------------------------------------------------------
// 6. Cleanup + report
// ---------------------------------------------------------------------------

await testTracer.shutdown();

printReport();

const failed = results.filter((r) => !r.passed).length;
if (failed > 0) {
  process.exit(1);
}

console.log("\n[e2e] TRACING E2E VALIDATION PASSED");
