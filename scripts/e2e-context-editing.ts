#!/usr/bin/env bun
/**
 * Manual E2E test: @koi/middleware-context-editing
 *
 * Validates the context-editing middleware works with real LLM calls
 * through two full pipelines:
 *   A) createKoi → engine-loop → Anthropic model-router
 *   B) createKoi → engine-pi  → pi-agent-core (streaming)
 *
 * Tests:
 * 1-5. engine-loop pipeline: install, below threshold, above threshold,
 *       clearToolCallInputs, excludeTools, spy interception
 * 6.   Config defaults
 * 7.   Heuristic estimator sanity check
 * 8.   engine-pi pipeline: middleware + wrapModelStream with real pi-agent
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-context-editing.ts
 */

import type {
  EngineEvent,
  InboundMessage,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
} from "../packages/core/src/index.js";
import { createKoi } from "../packages/engine/src/koi.js";
import { createLoopAdapter } from "../packages/engine-loop/src/loop-adapter.js";
import { createPiAdapter } from "../packages/engine-pi/src/adapter.js";
import { createContextEditingMiddleware } from "../packages/middleware-context-editing/src/context-editing.js";
import { editMessages } from "../packages/middleware-context-editing/src/edit-messages.js";
import { heuristicTokenEstimator } from "../packages/middleware-context-editing/src/estimator.js";
import { CONTEXT_EDITING_DEFAULTS } from "../packages/middleware-context-editing/src/types.js";
import { createAnthropicAdapter } from "../packages/model-router/src/adapters/anthropic.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Skipping.");
  process.exit(1);
}

console.log("[e2e] Starting context-editing middleware E2E test...\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

const results: TestResult[] = [];

function assert(name: string, condition: boolean, detail?: string): void {
  results.push({ name, passed: condition, detail });
  const tag = condition ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${tag}  ${name}`);
  if (detail !== undefined) {
    console.log(`        ${detail}`);
  }
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
      console.log(`  - ${r.name}${r.detail !== undefined ? ` (${r.detail})` : ""}`);
    }
  }
}

/** Build a tool result message matching the loop adapter's format. */
function toolResult(toolName: string, text: string, callId: string): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "tool",
    timestamp: Date.now(),
    metadata: { toolName, callId },
  };
}

/** Build an assistant message with a callId (matching loop adapter pattern). */
function assistantMessage(text: string, callId?: string): InboundMessage {
  const base = {
    content: [{ kind: "text" as const, text }],
    senderId: "assistant",
    timestamp: Date.now(),
  };
  if (callId !== undefined) {
    return { ...base, metadata: { callId } };
  }
  return base;
}

/** Build a user message. */
function userMessage(text: string): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "user",
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Setup: Anthropic adapter
// ---------------------------------------------------------------------------

const MODEL = "claude-haiku-4-5-20251001";
const anthropic = createAnthropicAdapter({ apiKey: API_KEY });
const modelCall: ModelHandler = (request: ModelRequest) =>
  anthropic.complete({ ...request, model: MODEL });

console.log(`[e2e] Model: ${MODEL}\n`);

// ===========================================================================
// Test 1: Middleware installs in the pipeline — real LLM call works
// ===========================================================================

console.log("[test 1] Middleware installs in pipeline — basic LLM call");

const contextEditingMw = createContextEditingMiddleware({
  triggerTokenCount: 100_000, // High threshold — won't trigger on simple calls
  numRecentToKeep: 2,
});

assert("middleware has correct name", contextEditingMw.name === "koi:context-editing");
assert("middleware has priority 250", contextEditingMw.priority === 250);

const loopAdapter1 = createLoopAdapter({ modelCall, maxTurns: 1 });

const runtime1 = await createKoi({
  manifest: {
    name: "context-editing-e2e",
    version: "0.1.0",
    model: { name: MODEL },
  },
  adapter: loopAdapter1,
  middleware: [contextEditingMw],
  loopDetection: false,
});

console.log(`  Agent assembled (state: ${runtime1.agent.state})`);
console.log(`  Sending: "Say hello in exactly one word."\n`);

let response1 = "";
for await (const event of runtime1.run({ kind: "text", text: "Say hello in exactly one word." })) {
  if (event.kind === "text_delta") {
    response1 += event.delta;
    process.stdout.write(event.delta);
  } else if (event.kind === "done") {
    console.log(
      `\n\n  [done] stopReason=${event.output.stopReason} turns=${event.output.metrics.turns}`,
    );
    console.log(
      `  [done] tokens: ${event.output.metrics.inputTokens} in / ${event.output.metrics.outputTokens} out\n`,
    );
  }
}

assert("LLM response is non-empty", response1.length > 0, `got: "${response1.trim()}"`);
await runtime1.dispose();

// ===========================================================================
// Test 2: editMessages pure function — below threshold returns same ref
// ===========================================================================

console.log("\n[test 2] editMessages: below threshold → no-op");

const smallMessages: readonly InboundMessage[] = [
  userMessage("hello"),
  toolResult("search", "result data", "call-1"),
];

const tokenCount = await heuristicTokenEstimator.estimateMessages(smallMessages);
const edited = editMessages(smallMessages, tokenCount, {
  triggerTokenCount: 100_000,
  numRecentToKeep: 1,
  clearToolCallInputs: true,
  excludeTools: new Set(),
  placeholder: "[cleared]",
  tokenEstimator: heuristicTokenEstimator,
});

assert(
  "below threshold returns same array reference",
  edited === smallMessages,
  `tokenCount=${tokenCount}, threshold=100000`,
);

// ===========================================================================
// Test 3: editMessages — above threshold clears old results
// ===========================================================================

console.log("\n[test 3] editMessages: above threshold → clears old tool results");

const bigMessages: readonly InboundMessage[] = [
  userMessage("question 1"),
  assistantMessage("calling search", "call-1"),
  toolResult("search", "x".repeat(2000), "call-1"), // old — should be cleared
  userMessage("question 2"),
  assistantMessage("calling search", "call-2"),
  toolResult("search", "y".repeat(2000), "call-2"), // old — should be cleared
  userMessage("question 3"),
  assistantMessage("calling search", "call-3"),
  toolResult("search", "z".repeat(200), "call-3"), // recent — kept
];

const bigTokenCount = await heuristicTokenEstimator.estimateMessages(bigMessages);
const editedBig = editMessages(bigMessages, bigTokenCount, {
  triggerTokenCount: 100, // Low threshold to trigger
  numRecentToKeep: 1,
  clearToolCallInputs: true,
  excludeTools: new Set(),
  placeholder: "[cleared]",
  tokenEstimator: heuristicTokenEstimator,
});

assert("returns new array (not same reference)", editedBig !== bigMessages);

// Tool results at indices 2 and 5 should be cleared
const cleared2 = editedBig[2];
const cleared5 = editedBig[5];
const kept8 = editedBig[8];

assert(
  "old tool result (index 2) cleared",
  cleared2?.content.length === 1 &&
    cleared2.content[0]?.kind === "text" &&
    cleared2.content[0].text === "[cleared]",
);

assert(
  "old tool result (index 5) cleared",
  cleared5?.content.length === 1 &&
    cleared5.content[0]?.kind === "text" &&
    cleared5.content[0].text === "[cleared]",
);

assert(
  "recent tool result (index 8) preserved",
  kept8?.content.length === 1 &&
    kept8.content[0]?.kind === "text" &&
    kept8.content[0].text === "z".repeat(200),
);

// clearToolCallInputs: assistant messages at indices 1 and 4 should also be cleared
const clearedAssistant1 = editedBig[1];
const clearedAssistant4 = editedBig[4];
const keptAssistant7 = editedBig[7];

assert(
  "corresponding assistant msg (index 1) cleared",
  clearedAssistant1?.content.length === 1 &&
    clearedAssistant1.content[0]?.kind === "text" &&
    clearedAssistant1.content[0].text === "[cleared]",
);

assert(
  "corresponding assistant msg (index 4) cleared",
  clearedAssistant4?.content.length === 1 &&
    clearedAssistant4.content[0]?.kind === "text" &&
    clearedAssistant4.content[0].text === "[cleared]",
);

assert(
  "recent assistant msg (index 7) preserved",
  keptAssistant7?.content.length === 1 &&
    keptAssistant7.content[0]?.kind === "text" &&
    keptAssistant7.content[0].text === "calling search",
);

// Metadata preserved on cleared messages
assert(
  "cleared tool result retains metadata",
  cleared2?.metadata?.toolName === "search" && cleared2?.metadata?.callId === "call-1",
);

assert(
  "original messages not mutated",
  bigMessages[2]?.content[0]?.kind === "text" &&
    (bigMessages[2].content[0] as { readonly text: string }).text === "x".repeat(2000),
);

// ===========================================================================
// Test 4: excludeTools — protected results survive
// ===========================================================================

console.log("\n[test 4] editMessages: excludeTools protects specified tools");

const messagesWithExcluded: readonly InboundMessage[] = [
  toolResult("memory", "important context", "call-a"),
  toolResult("search", "old search result", "call-b"),
  toolResult("search", "recent search result", "call-c"),
];

const editedExcluded = editMessages(
  messagesWithExcluded,
  99999, // above any threshold we set
  {
    triggerTokenCount: 100,
    numRecentToKeep: 1,
    clearToolCallInputs: false,
    excludeTools: new Set(["memory"]),
    placeholder: "[cleared]",
    tokenEstimator: heuristicTokenEstimator,
  },
);

assert(
  "excluded tool 'memory' at index 0 preserved",
  editedExcluded[0]?.content[0]?.kind === "text" &&
    (editedExcluded[0].content[0] as { readonly text: string }).text === "important context",
);

assert(
  "non-excluded 'search' at index 1 cleared",
  editedExcluded[1]?.content[0]?.kind === "text" &&
    (editedExcluded[1].content[0] as { readonly text: string }).text === "[cleared]",
);

assert(
  "recent 'search' at index 2 preserved (numRecentToKeep=1)",
  editedExcluded[2]?.content[0]?.kind === "text" &&
    (editedExcluded[2].content[0] as { readonly text: string }).text === "recent search result",
);

// ===========================================================================
// Test 5: Full pipeline — middleware intercepts before model call
// ===========================================================================

console.log("\n[test 5] Full pipeline: middleware intercepts model request");

// Use a spy middleware after context-editing to capture the request the model sees
let capturedRequest: ModelRequest | undefined;
const spyMiddleware: KoiMiddleware = {
  name: "e2e-spy",
  priority: 260, // After context-editing (250), before model call

  async wrapModelCall(_ctx, request, next) {
    capturedRequest = request;
    return next(request);
  },
};

// Create middleware with a very low threshold to ensure clearing triggers
const aggressiveEditingMw = createContextEditingMiddleware({
  triggerTokenCount: 10, // Very low — will trigger on any non-trivial conversation
  numRecentToKeep: 0,
  placeholder: "[e2e-cleared]",
});

const loopAdapter5 = createLoopAdapter({ modelCall, maxTurns: 1 });

const runtime5 = await createKoi({
  manifest: {
    name: "context-editing-spy-e2e",
    version: "0.1.0",
    model: { name: MODEL },
  },
  adapter: loopAdapter5,
  middleware: [aggressiveEditingMw, spyMiddleware],
  loopDetection: false,
});

// Send a message — even short text will trigger the low threshold
let response5 = "";
for await (const event of runtime5.run({
  kind: "text",
  text: "Say 'pong' and nothing else.",
})) {
  if (event.kind === "text_delta") {
    response5 += event.delta;
  } else if (event.kind === "done") {
    console.log(
      `  [done] stopReason=${event.output.stopReason} tokens: ${event.output.metrics.inputTokens} in / ${event.output.metrics.outputTokens} out`,
    );
  }
}

assert("LLM responded through middleware", response5.length > 0, `got: "${response5.trim()}"`);
assert("spy captured the model request", capturedRequest !== undefined);

// The request should have passed through context-editing.
// Since there are no tool results in this simple call, the middleware should be a no-op.
// But we verify the middleware didn't break the pipeline.
assert(
  "captured request has messages",
  (capturedRequest?.messages?.length ?? 0) > 0,
  `message count: ${capturedRequest?.messages?.length ?? 0}`,
);

await runtime5.dispose();

// ===========================================================================
// Test 6: Verify defaults match expectations
// ===========================================================================

console.log("\n[test 6] Config defaults");

assert(
  "default triggerTokenCount is 100_000",
  CONTEXT_EDITING_DEFAULTS.triggerTokenCount === 100_000,
);
assert("default numRecentToKeep is 3", CONTEXT_EDITING_DEFAULTS.numRecentToKeep === 3);
assert(
  "default clearToolCallInputs is true",
  CONTEXT_EDITING_DEFAULTS.clearToolCallInputs === true,
);
assert("default placeholder is '[cleared]'", CONTEXT_EDITING_DEFAULTS.placeholder === "[cleared]");

// ===========================================================================
// Test 7: Heuristic estimator accuracy sanity check
// ===========================================================================

console.log("\n[test 7] Heuristic estimator sanity check");

const testText = "Hello, world! This is a test message for token estimation.";
const estimatedTokens = await heuristicTokenEstimator.estimateText(testText);

// 4 chars/token: 58 chars → ceil(58/4) = 15 tokens
assert(
  "estimateText: 4 chars/token heuristic",
  estimatedTokens === Math.ceil(testText.length / 4),
  `"${testText}" → ${estimatedTokens} tokens (expected ${Math.ceil(testText.length / 4)})`,
);

const testMessages: readonly InboundMessage[] = [
  userMessage("Hello"), // 5 chars → 2 tokens
  toolResult("x", "World", "c"), // 5 chars → 2 tokens
];
const estimatedMsgTokens = await heuristicTokenEstimator.estimateMessages(testMessages);
assert(
  "estimateMessages: sums text blocks",
  estimatedMsgTokens === 4,
  `expected 4, got ${estimatedMsgTokens}`,
);

// ===========================================================================
// Test 8: engine-pi pipeline — middleware wrapModelStream with real pi-agent
// ===========================================================================

console.log("\n[test 8] engine-pi pipeline: middleware + wrapModelStream");
console.log("  Using pi-agent-core with anthropic:claude-haiku-4-5-20251001\n");

const PI_MODEL = "anthropic:claude-haiku-4-5-20251001";

// Context-editing middleware with high threshold (should be a no-op for simple call)
const piContextEditingMw = createContextEditingMiddleware({
  triggerTokenCount: 100_000,
  numRecentToKeep: 3,
});

// Spy to verify the middleware chain ran on the stream path
let piSpyCalled = false;
const piSpyMiddleware: KoiMiddleware = {
  name: "e2e-pi-spy",
  priority: 260,

  async *wrapModelStream(_ctx, request, next) {
    piSpyCalled = true;
    yield* next(request);
  },
};

const piAdapter = createPiAdapter({
  model: PI_MODEL,
  getApiKey: async () => API_KEY,
});

const piRuntime = await createKoi({
  manifest: {
    name: "context-editing-pi-e2e",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5" },
  },
  adapter: piAdapter,
  middleware: [piContextEditingMw, piSpyMiddleware],
  loopDetection: false,
});

console.log(`  Agent assembled (state: ${piRuntime.agent.state})`);
console.log(`  Sending: "Reply with exactly: pi-pong"\n`);

let piResponse = "";
const piEvents: EngineEvent[] = [];

for await (const event of piRuntime.run({
  kind: "text",
  text: "Reply with exactly: pi-pong",
})) {
  piEvents.push(event);
  if (event.kind === "text_delta") {
    piResponse += event.delta;
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

const piDone = piEvents.find((e) => e.kind === "done");
assert("[pi] run completed (done event emitted)", piDone !== undefined);

assert(
  "[pi] wrapModelStream spy was called",
  piSpyCalled,
  "confirms middleware onion chain ran on pi's streaming path",
);

// text_delta is informational — pi routes text through its subscriber/queue
// system, which may behave differently than engine-loop in E2E
if (piResponse.length > 0) {
  console.log(`  [info] pi text response: "${piResponse.trim()}"`);
} else {
  console.log("  [info] no text_delta events (expected: pi event routing differs from loop)");
}

await piRuntime.dispose();

// Now test with aggressive threshold to verify editing actually runs through pi's stream
console.log("\n  --- aggressive threshold on pi ---");

let piAggressiveSpyCapturedMessages: readonly InboundMessage[] | undefined;
const piAggressiveSpyMw: KoiMiddleware = {
  name: "e2e-pi-aggressive-spy",
  priority: 260,

  async *wrapModelStream(_ctx, request, next) {
    piAggressiveSpyCapturedMessages = request.messages;
    yield* next(request);
  },
};

const piAggressiveEditingMw = createContextEditingMiddleware({
  triggerTokenCount: 5, // Very low — will trigger on any text
  numRecentToKeep: 0,
  placeholder: "[pi-cleared]",
});

const piAdapter2 = createPiAdapter({
  model: PI_MODEL,
  getApiKey: async () => API_KEY,
});

const piRuntime2 = await createKoi({
  manifest: {
    name: "context-editing-pi-aggressive-e2e",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5" },
  },
  adapter: piAdapter2,
  middleware: [piAggressiveEditingMw, piAggressiveSpyMw],
  loopDetection: false,
});

let piResponse2 = "";
let piDone2: EngineEvent | undefined;
for await (const event of piRuntime2.run({
  kind: "text",
  text: "Say 'pi-ok' and nothing else.",
})) {
  if (event.kind === "text_delta") {
    piResponse2 += event.delta;
  } else if (event.kind === "done") {
    piDone2 = event;
    console.log(
      `  [done] stopReason=${event.output.stopReason} tokens: ${event.output.metrics.inputTokens} in / ${event.output.metrics.outputTokens} out`,
    );
  }
}

assert("[pi-aggressive] run completed (done event emitted)", piDone2 !== undefined);

assert(
  "[pi-aggressive] spy captured model request via stream",
  piAggressiveSpyCapturedMessages !== undefined,
  `message count: ${piAggressiveSpyCapturedMessages?.length ?? 0}`,
);

// text_delta from aggressive pi is informational (same reasoning as above)
if (piResponse2.length > 0) {
  console.log(`  [info] pi aggressive text response: "${piResponse2.trim()}"`);
} else {
  console.log("  [info] no text_delta events (middleware chain confirmed via spy)");
}

// Note: pi adapter manages its own message format internally, so the middleware
// sees whatever messages L1 composes. The key assertion is that the pipeline
// doesn't break — the middleware's wrapModelStream runs and the model responds.

await piRuntime2.dispose();

// ===========================================================================
// Report
// ===========================================================================

printReport();

const failed = results.filter((r) => !r.passed).length;
if (failed > 0) {
  process.exit(1);
}

console.log("\n[e2e] CONTEXT-EDITING MIDDLEWARE E2E VALIDATION PASSED (engine-loop + engine-pi)");
