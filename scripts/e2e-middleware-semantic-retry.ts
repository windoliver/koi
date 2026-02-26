#!/usr/bin/env bun

/**
 * E2E test script for @koi/middleware-semantic-retry — validates that the
 * semantic-retry pipeline works end-to-end with real Anthropic LLM calls
 * through the full middleware composition chain (composeModelChain,
 * composeToolChain, createKoi + Pi adapter).
 *
 * Tests:
 *   1. Transparent passthrough — real LLM (Loop adapter via composeModelChain)
 *   2. Failure → classify → rewrite → real LLM success (Loop adapter)
 *   3. Budget exhaustion → abort (Loop adapter)
 *   4. Tool failure recording (composed tool chain)
 *   5. onRetry callback fires with correct shape (Loop adapter)
 *   6. Full createKoi + Pi agent — transparent passthrough
 *   7. Full createKoi + Pi agent — tool failure recorded
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-middleware-semantic-retry.ts
 *
 *   Or if .env has ANTHROPIC_API_KEY:
 *   bun scripts/e2e-middleware-semantic-retry.ts
 *
 * Cost: ~$0.02-0.05 per run (4-5 real LLM calls to Haiku, minimal prompts).
 */

import { toolToken } from "../packages/core/src/ecs.js";
import type {
  ComponentProvider,
  EngineEvent,
  InboundMessage,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  Tool,
  ToolHandler,
  ToolRequest,
  ToolResponse,
} from "../packages/core/src/index.js";
import { composeModelChain, composeToolChain } from "../packages/engine/src/compose.js";
import { createKoi } from "../packages/engine/src/koi.js";
import { createPiAdapter } from "../packages/engine-pi/src/adapter.js";
import { createSemanticRetryMiddleware } from "../packages/middleware-semantic-retry/src/index.js";
import type { RetryRecord } from "../packages/middleware-semantic-retry/src/types.js";
import { createMockTurnContext } from "../packages/test-utils/src/index.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Skipping E2E tests.");
  process.exit(0);
}

console.log("[e2e] Starting middleware-semantic-retry E2E tests...\n");

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

function makeMessage(text: string): InboundMessage {
  return {
    senderId: "e2e-user",
    timestamp: Date.now(),
    content: [{ kind: "text", text }],
  };
}

/**
 * Real Anthropic API call as a ModelHandler terminal.
 */
function createAnthropicTerminal(): ModelHandler {
  return async (request: ModelRequest): Promise<ModelResponse> => {
    const systemParts: string[] = [];
    const userParts: string[] = [];

    for (const msg of request.messages) {
      const text = msg.content
        .filter((b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text")
        .map((b) => b.text)
        .join("\n");

      if (msg.senderId.startsWith("system:")) {
        systemParts.push(text);
      } else {
        userParts.push(text);
      }
    }

    const body = {
      model: request.model ?? "claude-haiku-4-5-20251001",
      max_tokens: request.maxTokens ?? 256,
      temperature: request.temperature ?? 0,
      ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
      messages: [{ role: "user", content: userParts.join("\n\n") }],
    };

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
    }

    const json = (await response.json()) as {
      readonly model: string;
      readonly content: readonly { readonly type: string; readonly text: string }[];
      readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
    };

    return {
      content: json.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join(""),
      model: json.model,
      usage: {
        inputTokens: json.usage.input_tokens,
        outputTokens: json.usage.output_tokens,
      },
    };
  };
}

async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const result: EngineEvent[] = []; // let justified: test accumulator
  for await (const event of iterable) {
    result.push(event);
  }
  return result;
}

const terminal = createAnthropicTerminal();
const ctx = createMockTurnContext();

// ---------------------------------------------------------------------------
// Test 1 — Transparent passthrough — real LLM (Loop adapter)
// ---------------------------------------------------------------------------

console.log("[test 1] Transparent passthrough — real LLM via composeModelChain");

const handle1 = createSemanticRetryMiddleware({});
const chain1 = composeModelChain([handle1.middleware], terminal);

const response1 = await withTimeout(
  async () =>
    chain1(ctx, {
      messages: [makeMessage("Reply with exactly: SEMANTIC_OK")],
      maxTokens: 50,
      temperature: 0,
    }),
  30_000,
  "Test 1",
);

console.log(`  LLM response: "${response1.content.slice(0, 80)}"`);

assert("LLM response contains SEMANTIC_OK", response1.content.includes("SEMANTIC_OK"));
assert(
  "zero retry records on passthrough",
  handle1.getRecords().length === 0,
  `Got ${handle1.getRecords().length} records`,
);
assert(
  "full budget intact",
  handle1.getRetryBudget() === 3,
  `Got budget=${handle1.getRetryBudget()}`,
);

// ---------------------------------------------------------------------------
// Test 2 — Failure → classify → rewrite → real LLM success (Loop adapter)
// ---------------------------------------------------------------------------

console.log("\n[test 2] Failure → classify → rewrite → real LLM success");

// let justified: toggled once after first failure
let failOnce2 = true;

const failThenSucceedTerminal: ModelHandler = async (
  request: ModelRequest,
): Promise<ModelResponse> => {
  if (failOnce2) {
    failOnce2 = false;
    throw new Error("Simulated transient API error");
  }
  return terminal(request);
};

const handle2 = createSemanticRetryMiddleware({});
const chain2 = composeModelChain([handle2.middleware], failThenSucceedTerminal);

const originalRequest2: ModelRequest = {
  messages: [makeMessage("Reply with exactly: RETRY_SUCCESS")],
  maxTokens: 50,
  temperature: 0,
};

// First call: will fail, middleware records failure + sets pendingAction
try {
  await withTimeout(async () => chain2(ctx, originalRequest2), 30_000, "Test 2 — first call");
} catch (_e: unknown) {
  // Expected: the error is re-thrown
}

assert(
  "1 record after failure",
  handle2.getRecords().length === 1,
  `Got ${handle2.getRecords().length} records`,
);
assert(
  "budget decremented to 2",
  handle2.getRetryBudget() === 2,
  `Got budget=${handle2.getRetryBudget()}`,
);

const record2 = handle2.getRecords()[0];
if (record2) {
  // Default escalation ladder: priorRetries=0 → add_context (deterministic for fresh handle)
  assert(
    "record has non-abort action (first failure → add_context expected)",
    record2.actionTaken.kind !== "abort",
    `Got action=${record2.actionTaken.kind}`,
  );
  assert("record succeeded is false", record2.succeeded === false);
}

// Second call: middleware rewrites request with added context, real LLM succeeds
const response2 = await withTimeout(
  async () => chain2(ctx, originalRequest2),
  30_000,
  "Test 2 — second call",
);

console.log(`  LLM response: "${response2.content.slice(0, 80)}"`);

assert("LLM response is non-empty after rewrite", response2.content.length > 0);

// ---------------------------------------------------------------------------
// Test 3 — Budget exhaustion → abort (Loop adapter)
// ---------------------------------------------------------------------------

console.log("\n[test 3] Budget exhaustion → abort after maxRetries");

const alwaysFailTerminal: ModelHandler = async (): Promise<ModelResponse> => {
  throw new Error("Permanent failure");
};

const handle3 = createSemanticRetryMiddleware({ maxRetries: 2 });
const chain3 = composeModelChain([handle3.middleware], alwaysFailTerminal);

const dummyRequest3: ModelRequest = {
  messages: [makeMessage("This will always fail")],
  maxTokens: 50,
  temperature: 0,
};

// Failure 1
try {
  await chain3(ctx, dummyRequest3);
} catch (_e: unknown) {
  // expected
}

assert(
  "after failure 1: budget=1",
  handle3.getRetryBudget() === 1,
  `Got budget=${handle3.getRetryBudget()}`,
);

// Failure 2
try {
  await chain3(ctx, dummyRequest3);
} catch (_e: unknown) {
  // expected
}

assert(
  "after failure 2: budget=0",
  handle3.getRetryBudget() === 0,
  `Got budget=${handle3.getRetryBudget()}`,
);

// Third call: should abort immediately (pendingAction = abort because budget=0)
let abortThrown = false; // let justified: toggled in catch
try {
  await chain3(ctx, dummyRequest3);
} catch (e: unknown) {
  if (e instanceof Error && /abort/i.test(e.message)) {
    abortThrown = true;
  }
}

assert("abort thrown when budget exhausted", abortThrown === true);

// ---------------------------------------------------------------------------
// Test 4 — Tool failure recording (composed tool chain)
// ---------------------------------------------------------------------------

console.log("\n[test 4] Tool failure recording via composeToolChain");

const handle4 = createSemanticRetryMiddleware({});

const failingToolTerminal: ToolHandler = async (_request: ToolRequest): Promise<ToolResponse> => {
  throw new Error("Tool execution failed: permission denied");
};

const toolChain4 = composeToolChain([handle4.middleware], failingToolTerminal);

let toolErrorCaught = false; // let justified: toggled in catch
try {
  await toolChain4(ctx, { toolId: "failing_tool", input: { arg: "value" } });
} catch (_e: unknown) {
  toolErrorCaught = true;
}

assert("tool error was re-thrown", toolErrorCaught === true);
assert(
  "1 record after tool failure",
  handle4.getRecords().length === 1,
  `Got ${handle4.getRecords().length} records`,
);

const record4 = handle4.getRecords()[0];
if (record4) {
  // Tool failures classified as "tool_misuse" by default analyzer (request has kind: "tool")
  assert(
    "record failureClass is tool_misuse",
    record4.failureClass.kind === "tool_misuse",
    `Got kind=${record4.failureClass.kind}`,
  );
  assert(
    "record action is non-abort (first failure)",
    record4.actionTaken.kind !== "abort",
    `Got action=${record4.actionTaken.kind}`,
  );
  assert("record succeeded is false", record4.succeeded === false);
}

assert(
  "budget decremented to 2 after tool failure",
  handle4.getRetryBudget() === 2,
  `Got budget=${handle4.getRetryBudget()}`,
);

// ---------------------------------------------------------------------------
// Test 5 — onRetry callback fires with correct shape (Loop adapter)
// ---------------------------------------------------------------------------

console.log("\n[test 5] onRetry callback fires with correct shape");

const onRetryRecords: RetryRecord[] = []; // let justified: test accumulator

const handle5 = createSemanticRetryMiddleware({
  onRetry: (record: RetryRecord) => {
    onRetryRecords.push(record);
  },
});

const failOnceTerminal5: ModelHandler = async (): Promise<ModelResponse> => {
  throw new Error("Simulated error for onRetry test");
};

const chain5 = composeModelChain([handle5.middleware], failOnceTerminal5);

try {
  await chain5(ctx, {
    messages: [makeMessage("Trigger onRetry")],
    maxTokens: 50,
    temperature: 0,
  });
} catch (_e: unknown) {
  // expected
}

assert(
  "onRetry callback fired once",
  onRetryRecords.length === 1,
  `Got ${onRetryRecords.length} callbacks`,
);

const cbRecord = onRetryRecords[0];
if (cbRecord) {
  assert("callback record has timestamp > 0", cbRecord.timestamp > 0);
  assert(
    "callback record has failureClass",
    cbRecord.failureClass !== undefined && typeof cbRecord.failureClass.kind === "string",
  );
  assert(
    "callback record has actionTaken",
    cbRecord.actionTaken !== undefined && typeof cbRecord.actionTaken.kind === "string",
  );
  assert("callback record has succeeded=false", cbRecord.succeeded === false);
}

// ---------------------------------------------------------------------------
// Test 6 — Full createKoi + Pi agent — transparent passthrough
// ---------------------------------------------------------------------------

console.log("\n[test 6] Full createKoi + Pi agent — transparent passthrough");

const PI_MODEL = "anthropic:claude-haiku-4-5-20251001";
const TIMEOUT_MS = 60_000;

const handle6 = createSemanticRetryMiddleware({});

const piAdapter6 = createPiAdapter({
  model: PI_MODEL,
  systemPrompt: "You are a helpful assistant. Reply concisely.",
  getApiKey: async () => API_KEY,
});

const runtime6 = await createKoi({
  manifest: { name: "e2e-semantic-retry-pi", version: "0.0.1", model: { name: PI_MODEL } },
  adapter: piAdapter6,
  middleware: [handle6.middleware],
  providers: [],
  limits: { maxTurns: 5, maxDurationMs: TIMEOUT_MS, maxTokens: 50_000 },
});

try {
  const events6 = await Promise.race([
    collectEvents(runtime6.run({ kind: "text", text: "Reply with exactly: PI_PASSTHROUGH" })),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Test 6 timed out after ${TIMEOUT_MS / 1000}s`)),
        TIMEOUT_MS,
      ),
    ),
  ]);

  const doneEvent6 = events6.find((e) => e.kind === "done");
  assert("pi agent completed", doneEvent6 !== undefined);

  const hasTextDelta = events6.some((e) => e.kind === "text_delta");
  assert("events include text_delta", hasTextDelta === true);

  assert(
    "zero retry records with Pi passthrough",
    handle6.getRecords().length === 0,
    `Got ${handle6.getRecords().length} records`,
  );
  assert(
    "full budget intact with Pi",
    handle6.getRetryBudget() === 3,
    `Got budget=${handle6.getRetryBudget()}`,
  );

  console.log(`  Pi agent completed with ${events6.length} events`);
} finally {
  await runtime6.dispose?.();
}

// ---------------------------------------------------------------------------
// Test 7 — Full createKoi + Pi agent — tool failure recorded
// ---------------------------------------------------------------------------

console.log("\n[test 7] Full createKoi + Pi agent — tool failure recorded");

const handle7 = createSemanticRetryMiddleware({});

// let justified: mutable counter — incremented in tool execute to track call count
let toolCallCount7 = 0;

const flakeyTool7: Tool = {
  descriptor: {
    name: "flakey_tool",
    description:
      "A tool that fails on the first call but succeeds on retry. Call it with any input.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Any query string" } },
      required: ["query"],
    },
  },
  trustTier: "sandbox",
  execute: async () => {
    toolCallCount7++;
    if (toolCallCount7 === 1) {
      throw new Error("Tool transient failure — first call");
    }
    return { result: "success", attempt: toolCallCount7 };
  },
};

const toolProvider7: ComponentProvider = {
  name: "e2e-semantic-retry-tool-provider",
  attach: async () => {
    const components = new Map<string, unknown>();
    components.set(toolToken("flakey_tool"), flakeyTool7);
    return components;
  },
};

const piAdapter7 = createPiAdapter({
  model: PI_MODEL,
  systemPrompt: [
    'You have ONE task: call the flakey_tool with query "test".',
    "After getting the result, report what it returned.",
    "Do NOT say anything before calling the tool. Just call it immediately.",
    "If the tool fails, try calling it again.",
  ].join("\n"),
  getApiKey: async () => API_KEY,
});

const runtime7 = await createKoi({
  manifest: { name: "e2e-semantic-retry-tool-fail", version: "0.0.1", model: { name: PI_MODEL } },
  adapter: piAdapter7,
  middleware: [handle7.middleware],
  providers: [toolProvider7],
  limits: { maxTurns: 10, maxDurationMs: TIMEOUT_MS, maxTokens: 50_000 },
});

try {
  const events7 = await Promise.race([
    collectEvents(runtime7.run({ kind: "text", text: 'Call the flakey_tool with query "test".' })),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Test 7 timed out after ${TIMEOUT_MS / 1000}s`)),
        TIMEOUT_MS,
      ),
    ),
  ]);

  const doneEvent7 = events7.find((e) => e.kind === "done");
  assert("pi agent completed (tool failure scenario)", doneEvent7 !== undefined);

  assert(
    "tool was called at least once",
    toolCallCount7 >= 1,
    `Tool called ${toolCallCount7} times`,
  );

  // The middleware should have recorded the tool failure
  const records7 = handle7.getRecords();
  assert(
    "tool failure recorded by middleware",
    records7.length >= 1,
    `Got ${records7.length} records`,
  );

  const firstRecord7 = records7[0];
  if (firstRecord7 !== undefined) {
    // Tool failures classified as "tool_misuse" by default analyzer
    assert(
      "record failureClass is tool_misuse",
      firstRecord7.failureClass.kind === "tool_misuse",
      `Got kind=${firstRecord7.failureClass.kind}`,
    );
    assert("record succeeded is false", firstRecord7.succeeded === false);
  }

  // Verify middleware didn't prevent Pi from eventually completing
  if (doneEvent7?.kind === "done") {
    assert(
      "pi agent stop reason is completed (not error)",
      doneEvent7.output.stopReason === "completed",
      `Got stopReason=${doneEvent7.output.stopReason}`,
    );
  }

  console.log(
    `  Pi agent completed with ${events7.length} events, tool called ${toolCallCount7} times`,
  );
} finally {
  await runtime7.dispose?.();
}

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

console.log("\n[e2e] ALL MIDDLEWARE-SEMANTIC-RETRY E2E TESTS PASSED!");
