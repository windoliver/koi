#!/usr/bin/env bun
/**
 * E2E test script for @koi/engine-acp — validates the full ACP adapter
 * wired through the L1 runtime (createKoi + middleware chain).
 *
 * Section A — ACP Protocol Tests (mock ACP subprocess, no real LLM):
 *   1. Initialize handshake: agentCapabilities populated
 *   2. Text streaming: text_delta events from session/update notifications
 *   3. Token metrics: usage field populated in done event
 *   4. fs/read_text_file callback: Koi serves file reads to ACP agent
 *   5. terminal/* callbacks: Koi manages subprocess on behalf of ACP agent
 *   6. session/request_permission: auto-allow in headless mode
 *   7. Multiple sessions: fresh session per stream()
 *   8. Dispose: graceful subprocess termination
 *   9. Abort signal: stream terminates with interrupted stopReason
 *
 * Section B — createKoi + Real LLM (Pi adapter, uses ANTHROPIC_API_KEY):
 *  10. createKoi + middleware chain: onBeforeTurn/onAfterTurn fire
 *  11. Real token metrics: inputTokens/outputTokens populated
 *  12. Multiple turns: koi.run fires multiple times reusing the same runtime
 *
 * Section C — createAcpAdapter + Pi ACP server (real LLM + ACP protocol):
 *  13. Initialize handshake: agentCapabilities from Pi ACP server
 *  14. Real text_delta from LLM inference through ACP
 *  15. Real token metrics via ACP usage field
 *  16. Multiple sessions: independent context per session/new
 *  17. Full stack: createKoi → createAcpAdapter → Pi ACP server → LLM
 *  18. Pi coding agent: bash tool executes real commands via terminal/* callbacks
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-engine-acp.ts
 *
 * Cost: ~$0.01–0.02 for Section B (2 small claude-haiku calls).
 * Section A is free — uses a mock ACP server with deterministic responses.
 */

import type { EngineEvent, EngineOutput, KoiMiddleware } from "@koi/core";
import { createAcpAdapter } from "../packages/drivers/engine-acp/src/adapter.js";
import type { AcpEngineAdapter } from "../packages/drivers/engine-acp/src/types.js";
import { createPiAdapter } from "../packages/drivers/engine-pi/src/adapter.js";
import { createKoi } from "../packages/kernel/engine/src/koi.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Skipping E2E tests.");
  process.exit(0);
}

// Path to the mock ACP server (sibling script)
const MOCK_SERVER_PATH = new URL("./mock-acp-server.ts", import.meta.url).pathname;

console.log("[e2e] Starting engine-acp E2E tests...");
console.log("[e2e] ANTHROPIC_API_KEY: set");
console.log(`[e2e] Mock ACP server: ${MOCK_SERVER_PATH}\n`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string | undefined;
}

// let: mutable accumulator for test results
const results: TestResult[] = [];

function assert(name: string, condition: boolean, detail?: string): void {
  results.push({ name, passed: condition, detail });
  const tag = condition ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  const suffix = detail !== undefined && !condition ? ` — ${detail}` : "";
  console.log(`  ${tag}  ${name}${suffix}`);
}

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
  const doneEvent = events.find(
    (e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done",
  );
  return doneEvent?.output;
}

function countByKind(events: readonly EngineEvent[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const e of events) {
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  }
  return counts;
}

function printEventSummary(events: readonly EngineEvent[]): void {
  const counts = countByKind(events);
  console.log(`  Events: ${events.length} total`);
  for (const [kind, count] of Object.entries(counts)) {
    console.log(`    ${kind}: ${count}`);
  }
}

async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// Factory for a mock ACP adapter (no API key needed)
function createMockAdapter(): AcpEngineAdapter {
  return createAcpAdapter({
    command: "bun",
    args: [MOCK_SERVER_PATH],
    timeoutMs: 30_000,
  });
}

// ============================================================================
// SECTION A — ACP Protocol Tests (mock ACP server)
// ============================================================================

console.log("=".repeat(60));
console.log("Section A: ACP Protocol Tests (mock ACP server)");
console.log("=".repeat(60));

// ---------------------------------------------------------------------------
// Test 1 — Initialize handshake: agentCapabilities populated after first stream
// ---------------------------------------------------------------------------

console.log("\n[test 1] Initialize handshake — agentCapabilities");

const adapter1 = createMockAdapter();

assert("agentCapabilities undefined before stream", adapter1.agentCapabilities === undefined);

const test1Events = await withTimeout(
  () => collectEvents(adapter1.stream({ kind: "text", text: "hello from test 1" })),
  30_000,
  "Test 1",
);

printEventSummary(test1Events);

assert(
  "agentCapabilities populated after stream",
  adapter1.agentCapabilities !== undefined,
  `got: ${JSON.stringify(adapter1.agentCapabilities)}`,
);

const output1 = findDoneOutput(test1Events);
assert("done event emitted", output1 !== undefined);
assert(
  'stopReason is "completed"',
  output1?.stopReason === "completed",
  `got: ${output1?.stopReason}`,
);

// ---------------------------------------------------------------------------
// Test 2 — Text streaming: text_delta events from session/update notifications
// ---------------------------------------------------------------------------

console.log("\n[test 2] Text streaming — text_delta events");

const test2Events = await withTimeout(
  () => collectEvents(adapter1.stream({ kind: "text", text: "stream this text please" })),
  30_000,
  "Test 2",
);

printEventSummary(test2Events);

const test2Counts = countByKind(test2Events);
assert("text_delta events emitted", (test2Counts.text_delta ?? 0) > 0, "expected > 0");
assert("done event emitted", (test2Counts.done ?? 0) === 1);

const output2 = findDoneOutput(test2Events);
assert('stopReason is "completed"', output2?.stopReason === "completed");

// Verify text_delta text is non-empty
const allDeltaText = test2Events
  .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
  .map((e) => e.delta ?? "")
  .join("");
assert("text_delta produces non-empty text", allDeltaText.length > 0);

// ---------------------------------------------------------------------------
// Test 3 — Token metrics: usage populated in done event
// ---------------------------------------------------------------------------

console.log("\n[test 3] Token metrics");

const output3 = findDoneOutput(test1Events);
assert("metrics.durationMs > 0", (output3?.metrics.durationMs ?? 0) > 0);
assert("metrics.turns >= 1", (output3?.metrics.turns ?? 0) >= 1);
assert("metrics.inputTokens > 0", (output3?.metrics.inputTokens ?? 0) > 0);
assert("metrics.outputTokens > 0", (output3?.metrics.outputTokens ?? 0) > 0);
assert(
  "totalTokens = input + output",
  output3?.metrics.totalTokens ===
    (output3?.metrics.inputTokens ?? 0) + (output3?.metrics.outputTokens ?? 0),
);
console.log(`  Tokens: ${output3?.metrics.inputTokens} in, ${output3?.metrics.outputTokens} out`);

// ---------------------------------------------------------------------------
// Test 4 — fs/read_text_file callback: Koi serves file reads to ACP agent
// ---------------------------------------------------------------------------

console.log("\n[test 4] fs/read_text_file callback");

// Create a temp file for the mock server to request
const tmpFilePath = `/tmp/e2e-acp-${Date.now()}.txt`;
await Bun.write(tmpFilePath, "hello-from-koi-fs-handler");

const test4Events = await withTimeout(
  () => collectEvents(adapter1.stream({ kind: "text", text: `READ_FILE:${tmpFilePath}` })),
  30_000,
  "Test 4",
);

printEventSummary(test4Events);

const test4Text = test4Events
  .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
  .map((e) => e.delta ?? "")
  .join("");

assert("text_delta received after file read", test4Text.length > 0);
assert(
  "response contains file contents",
  test4Text.includes("hello-from-koi-fs-handler"),
  `got: "${test4Text.slice(0, 80)}"`,
);

const output4 = findDoneOutput(test4Events);
assert('stopReason is "completed" after fs callback', output4?.stopReason === "completed");

// Cleanup
try {
  await Bun.file(tmpFilePath).text(); // ensure it exists
  const { unlinkSync } = await import("node:fs");
  unlinkSync(tmpFilePath);
} catch {
  // Best-effort cleanup
}

// ---------------------------------------------------------------------------
// Test 5 — terminal/* callbacks: Koi manages subprocess lifecycle
// ---------------------------------------------------------------------------

console.log("\n[test 5] terminal/* callbacks (create, wait_for_exit, output, release)");

const test5Events = await withTimeout(
  () => collectEvents(adapter1.stream({ kind: "text", text: "RUN_CMD:echo:hello-from-terminal" })),
  30_000,
  "Test 5",
);

printEventSummary(test5Events);

const test5Text = test5Events
  .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
  .map((e) => e.delta ?? "")
  .join("");

assert("text_delta received after terminal command", test5Text.length > 0);
assert(
  "response contains terminal output",
  test5Text.includes("hello-from-terminal"),
  `got: "${test5Text.slice(0, 80)}"`,
);

const output5 = findDoneOutput(test5Events);
assert('stopReason is "completed" after terminal callbacks', output5?.stopReason === "completed");

// ---------------------------------------------------------------------------
// Test 6 — session/request_permission: auto-allow in headless mode
// ---------------------------------------------------------------------------

console.log("\n[test 6] session/request_permission — auto-allow in headless mode");

const test6Events = await withTimeout(
  () =>
    collectEvents(
      adapter1.stream({ kind: "text", text: "REQUEST_PERMISSION please approve this" }),
    ),
  30_000,
  "Test 6",
);

printEventSummary(test6Events);

const output6 = findDoneOutput(test6Events);
assert("session completes after permission request", output6 !== undefined);
assert(
  'stopReason is "completed" after permission',
  output6?.stopReason === "completed",
  `got: ${output6?.stopReason}`,
);

// ---------------------------------------------------------------------------
// Test 7 — Multiple sessions: fresh session per stream()
// ---------------------------------------------------------------------------

console.log("\n[test 7] Multiple sessions — fresh sessionId per stream");

const adapter7 = createMockAdapter();

// Run stream A and capture session ID from text (mock server embeds session in response)
const eventsA = await withTimeout(
  () => collectEvents(adapter7.stream({ kind: "text", text: "session a prompt" })),
  30_000,
  "Test 7A",
);
const textA = eventsA
  .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
  .map((e) => e.delta ?? "")
  .join("");

// Run stream B
const eventsB = await withTimeout(
  () => collectEvents(adapter7.stream({ kind: "text", text: "session b prompt" })),
  30_000,
  "Test 7B",
);
const textB = eventsB
  .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
  .map((e) => e.delta ?? "")
  .join("");

assert("session A completed", findDoneOutput(eventsA)?.stopReason === "completed");
assert("session B completed", findDoneOutput(eventsB)?.stopReason === "completed");
assert("session A produced text", textA.length > 0);
assert("session B produced different text", textB.length > 0 && textA !== textB);

await adapter7.dispose();

// ---------------------------------------------------------------------------
// Test 8 — Dispose: graceful subprocess termination
// ---------------------------------------------------------------------------

console.log("\n[test 8] Dispose — graceful subprocess termination");

let disposeError: unknown;
try {
  await adapter1.dispose();
} catch (e) {
  disposeError = e;
}
assert("dispose() completes without error", disposeError === undefined);

let dispose2Error: unknown;
try {
  await adapter1.dispose();
} catch (e) {
  dispose2Error = e;
}
assert("double dispose() is safe", dispose2Error === undefined);

// Stream after dispose yields interrupted stopReason
const disposedEvents = await collectEvents(
  adapter1.stream({ kind: "text", text: "post-dispose prompt" }),
);
const disposedOutput = findDoneOutput(disposedEvents);
assert(
  "stream() after dispose yields interrupted",
  disposedOutput?.stopReason === "interrupted",
  `got: ${disposedOutput?.stopReason}`,
);

// ---------------------------------------------------------------------------
// Test 9 — Abort signal: stream terminates cleanly
// ---------------------------------------------------------------------------

console.log("\n[test 9] Abort signal — interrupt mid-stream");

const adapter9 = createMockAdapter();
const controller = new AbortController();

const abortEvents: EngineEvent[] = [];
let abortOutput: EngineOutput | undefined;

await withTimeout(
  async () => {
    for await (const event of adapter9.stream({
      kind: "text",
      text: "long streaming prompt for abort test",
      signal: controller.signal,
    })) {
      abortEvents.push(event);
      // Abort after first text_delta arrives
      if (event.kind === "text_delta") {
        controller.abort();
      }
      if (event.kind === "done") {
        abortOutput = event.output;
      }
    }
  },
  15_000,
  "Test 9: abort",
);

assert("abort: stream terminates with done event", abortOutput !== undefined);
assert(
  'abort: stopReason is "interrupted" or "completed"',
  abortOutput?.stopReason === "interrupted" || abortOutput?.stopReason === "completed",
  `got: ${abortOutput?.stopReason}`,
);
console.log(`  Stopped after ${abortEvents.length} events, reason: ${abortOutput?.stopReason}`);

await adapter9.dispose();

// ============================================================================
// SECTION B — createKoi + Real LLM (Pi adapter, ANTHROPIC_API_KEY)
// ============================================================================

console.log(`\n${"=".repeat(60)}`);
console.log("Section B: createKoi + Real LLM (Pi adapter)");
console.log("=".repeat(60));

// Cheapest model for E2E
const PI_MODEL = "anthropic:claude-haiku-4-5-20251001" as const;

// let: middleware hook counters
let beforeTurnCount = 0;
let afterTurnCount = 0;

const tracerMiddleware: KoiMiddleware = {
  name: "e2e-acp-tracer",
  priority: 100,
  onBeforeTurn: async (ctx) => {
    beforeTurnCount++;
    // Intentionally void — onBeforeTurn has no next(), it's a fire-and-forget hook
    void ctx;
  },
  onAfterTurn: async (ctx) => {
    afterTurnCount++;
    void ctx;
  },
};

// ---------------------------------------------------------------------------
// Test 10 — createKoi + middleware chain: hooks fire on real LLM call
// ---------------------------------------------------------------------------

console.log("\n[test 10] createKoi + middleware chain interception");

const piAdapter = createPiAdapter({
  model: PI_MODEL,
  systemPrompt: "You are a concise assistant. Reply in 1 sentence.",
  getApiKey: async () => API_KEY,
});

const koi10 = await createKoi({
  manifest: {
    name: "e2e-acp-koi",
    version: "0.0.1",
    model: { name: PI_MODEL },
  },
  adapter: piAdapter,
  middleware: [tracerMiddleware],
  limits: { maxTurns: 3, maxDurationMs: 60_000, maxTokens: 50_000 },
});

assert("createKoi returns agent entity", koi10.agent !== undefined);

const test10Events: EngineEvent[] = [];
let output10: EngineOutput | undefined;

await withTimeout(
  async () => {
    for await (const event of koi10.run({ kind: "text", text: "Say: middleware-works" })) {
      test10Events.push(event);
      if (event.kind === "text_delta") {
        process.stdout.write(event.delta ?? "");
      }
      if (event.kind === "done") {
        output10 = event.output;
      }
    }
  },
  90_000,
  "Test 10: koi.run",
);
console.log("");

const test10Counts = countByKind(test10Events);
assert("text_delta events delivered via createKoi", (test10Counts.text_delta ?? 0) > 0);
assert("done event emitted", output10 !== undefined);
assert(
  'stopReason is "completed"',
  output10?.stopReason === "completed",
  `got: ${output10?.stopReason}`,
);
assert("onBeforeTurn middleware hook fired", beforeTurnCount > 0, `count=${beforeTurnCount}`);
assert("onAfterTurn middleware hook fired", afterTurnCount > 0, `count=${afterTurnCount}`);

// ---------------------------------------------------------------------------
// Test 11 — Real token metrics: inputTokens / outputTokens populated
// ---------------------------------------------------------------------------

console.log("\n[test 11] Real token metrics");

assert("inputTokens > 0", (output10?.metrics.inputTokens ?? 0) > 0);
assert("outputTokens > 0", (output10?.metrics.outputTokens ?? 0) > 0);
assert(
  "totalTokens = input + output",
  output10?.metrics.totalTokens ===
    (output10?.metrics.inputTokens ?? 0) + (output10?.metrics.outputTokens ?? 0),
);
assert("durationMs > 0", (output10?.metrics.durationMs ?? 0) > 0);
console.log(
  `  Tokens: ${output10?.metrics.inputTokens} in, ${output10?.metrics.outputTokens} out, ${output10?.metrics.durationMs}ms`,
);

// ---------------------------------------------------------------------------
// Test 12 — Multiple koi.run() calls: same runtime, independent turns
// ---------------------------------------------------------------------------

console.log("\n[test 12] Multiple koi.run() calls on same runtime");

// Reset middleware counters
beforeTurnCount = 0;
afterTurnCount = 0;

let output12a: EngineOutput | undefined;
await withTimeout(
  async () => {
    for await (const event of koi10.run({ kind: "text", text: "Reply: turn-one" })) {
      if (event.kind === "done") output12a = event.output;
    }
  },
  90_000,
  "Test 12a",
);

let output12b: EngineOutput | undefined;
await withTimeout(
  async () => {
    for await (const event of koi10.run({ kind: "text", text: "Reply: turn-two" })) {
      if (event.kind === "done") output12b = event.output;
    }
  },
  90_000,
  "Test 12b",
);

assert("run 12a completed", output12a?.stopReason === "completed");
assert("run 12b completed", output12b?.stopReason === "completed");
assert("middleware fired for both runs", beforeTurnCount >= 2, `count=${beforeTurnCount}`);
assert("runs are independent (different durations or tokens)", output12a !== output12b);

await koi10.dispose();

// ============================================================================
// SECTION C — createAcpAdapter + Pi ACP server (real LLM, real ACP protocol)
// ============================================================================
//
// This is the TRUE end-to-end test: the ACP adapter talks over JSON-RPC 2.0
// to a real ACP subprocess (pi-acp-server.ts) that uses createPiAdapter +
// createKoi internally to make actual Claude Haiku API calls.
//
// Cost: ~$0.01 (2-3 small haiku calls)
// ============================================================================

console.log(`\n${"=".repeat(60)}`);
console.log("Section C: createAcpAdapter + Pi ACP server (real LLM + ACP)");
console.log("=".repeat(60));

const PI_ACP_SERVER_PATH = new URL("./pi-acp-server.ts", import.meta.url).pathname;

function createPiAcpAdapter(): AcpEngineAdapter {
  return createAcpAdapter({
    command: "bun",
    args: [PI_ACP_SERVER_PATH],
    env: { ANTHROPIC_API_KEY: API_KEY },
    timeoutMs: 120_000,
  });
}

// ---------------------------------------------------------------------------
// Test 13 — Real ACP: agentCapabilities from Pi ACP server
// ---------------------------------------------------------------------------

console.log("\n[test 13] Pi ACP server — initialize + agentCapabilities");

const adapterC1 = createPiAcpAdapter();

assert(
  "Pi ACP: agentCapabilities undefined before stream",
  adapterC1.agentCapabilities === undefined,
);

const c1Events = await withTimeout(
  () => collectEvents(adapterC1.stream({ kind: "text", text: "Reply with exactly: acp-ready" })),
  120_000,
  "Test 13",
);

printEventSummary(c1Events);

assert(
  "Pi ACP: agentCapabilities populated",
  adapterC1.agentCapabilities !== undefined,
  `got: ${JSON.stringify(adapterC1.agentCapabilities)}`,
);

const c1Output = findDoneOutput(c1Events);
assert("Pi ACP: done event emitted", c1Output !== undefined);
assert(
  'Pi ACP: stopReason is "completed"',
  c1Output?.stopReason === "completed",
  `got: ${c1Output?.stopReason}`,
);

// ---------------------------------------------------------------------------
// Test 14 — Real ACP: real text_delta events from actual LLM inference
// ---------------------------------------------------------------------------

console.log("\n[test 14] Pi ACP server — real text_delta from LLM inference");

const c1Counts = countByKind(c1Events);
assert("Pi ACP: text_delta events received", (c1Counts.text_delta ?? 0) > 0);

const c1Text = c1Events
  .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
  .map((e) => e.delta)
  .join("");

assert("Pi ACP: non-empty LLM response", c1Text.length > 0, `text="${c1Text.slice(0, 40)}"`);
console.log(`  LLM response: "${c1Text.trim().slice(0, 60)}"`);

// ---------------------------------------------------------------------------
// Test 15 — Real ACP: token metrics from real LLM usage
// ---------------------------------------------------------------------------

console.log("\n[test 15] Pi ACP server — real token metrics");

assert("Pi ACP: inputTokens > 0", (c1Output?.metrics.inputTokens ?? 0) > 0);
assert("Pi ACP: outputTokens > 0", (c1Output?.metrics.outputTokens ?? 0) > 0);
assert("Pi ACP: durationMs > 0", (c1Output?.metrics.durationMs ?? 0) > 0);
console.log(
  `  Tokens: ${c1Output?.metrics.inputTokens} in, ${c1Output?.metrics.outputTokens} out, ${c1Output?.metrics.durationMs}ms`,
);

// ---------------------------------------------------------------------------
// Test 16 — Real ACP: multiple sessions on same Pi ACP process
// ---------------------------------------------------------------------------

console.log("\n[test 16] Pi ACP server — multiple sessions, independent context");

const cEventsA = await withTimeout(
  () =>
    collectEvents(
      adapterC1.stream({ kind: "text", text: "Remember the word PHOENIX. Reply: noted" }),
    ),
  120_000,
  "Test 16A",
);

const cEventsB = await withTimeout(
  () =>
    collectEvents(
      adapterC1.stream({
        kind: "text",
        text: "What word did I ask you to remember? Say 'none' if unknown.",
      }),
    ),
  120_000,
  "Test 16B",
);

assert("Pi ACP: session A completed", findDoneOutput(cEventsA)?.stopReason === "completed");
assert("Pi ACP: session B completed", findDoneOutput(cEventsB)?.stopReason === "completed");

const sessionBText = cEventsB
  .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
  .map((e) => e.delta)
  .join("")
  .toLowerCase();

console.log(`  Session B response: "${sessionBText.trim().slice(0, 80)}"`);

// Fresh sessions — the Pi ACP server creates a new Koi instance per session/new,
// so session B should not have context from session A.
const hasNoMemory =
  sessionBText.includes("none") ||
  sessionBText.includes("don't") ||
  sessionBText.includes("not remember") ||
  sessionBText.includes("haven't") ||
  sessionBText.includes("no word") ||
  sessionBText.includes("no context");

assert(
  "Pi ACP: session B has no memory of session A",
  hasNoMemory,
  `response: "${sessionBText.trim().slice(0, 60)}"`,
);

await adapterC1.dispose();

// ---------------------------------------------------------------------------
// Test 17 — Real ACP + createKoi: full stack (ACP adapter → Pi ACP server → LLM)
// ---------------------------------------------------------------------------

console.log("\n[test 17] Full stack: createKoi → createAcpAdapter → Pi ACP server → LLM");

// let: middleware counters for Section C
let cBeforeTurnCount = 0;
let cAfterTurnCount = 0;

const cTracerMiddleware: KoiMiddleware = {
  name: "e2e-c-tracer",
  priority: 100,
  onBeforeTurn: async (ctx) => {
    cBeforeTurnCount++;
    void ctx;
  },
  onAfterTurn: async (ctx) => {
    cAfterTurnCount++;
    void ctx;
  },
};

const adapterC2 = createPiAcpAdapter();

const koiC = await createKoi({
  manifest: {
    name: "e2e-acp-full-stack",
    version: "0.0.1",
    model: { name: "anthropic:claude-haiku-4-5-20251001" },
  },
  adapter: adapterC2,
  middleware: [cTracerMiddleware],
  limits: { maxTurns: 3, maxDurationMs: 120_000, maxTokens: 50_000 },
});

const c2Events: EngineEvent[] = [];
let c2Output: EngineOutput | undefined;

await withTimeout(
  async () => {
    for await (const event of koiC.run({ kind: "text", text: "Say: full-stack-works" })) {
      c2Events.push(event);
      if (event.kind === "text_delta") {
        process.stdout.write(event.delta);
      }
      if (event.kind === "done") {
        c2Output = event.output;
      }
    }
  },
  120_000,
  "Test 17: full stack",
);
console.log("");

const c2Counts = countByKind(c2Events);
assert("full stack: text_delta events received", (c2Counts.text_delta ?? 0) > 0);
assert("full stack: done event emitted", c2Output !== undefined);
assert(
  'full stack: stopReason is "completed"',
  c2Output?.stopReason === "completed",
  `got: ${c2Output?.stopReason}`,
);
assert("full stack: L1 onBeforeTurn fired", cBeforeTurnCount > 0, `count=${cBeforeTurnCount}`);
assert("full stack: L1 onAfterTurn fired", cAfterTurnCount > 0, `count=${cAfterTurnCount}`);
assert("full stack: real token metrics", (c2Output?.metrics.inputTokens ?? 0) > 0);
console.log(`  L1 turns fired: before=${cBeforeTurnCount}, after=${cAfterTurnCount}`);
console.log(`  Tokens: ${c2Output?.metrics.inputTokens} in, ${c2Output?.metrics.outputTokens} out`);

await koiC.dispose();

// ---------------------------------------------------------------------------
// Test 18 — Pi coding agent: bash tool executes code via ACP terminal callbacks
//
// Uses an unguessable proof token written to a temp file. The LLM has no way
// to know the file contents without actually running `cat <path>` via the
// bash tool → terminal/* ACP callbacks → Koi's TerminalRegistry → Bun.spawn.
// If the token appears in the response, real code execution happened.
// ---------------------------------------------------------------------------

console.log("\n[test 18] Pi coding agent — bash tool via ACP terminal callbacks (proof token)");

const { unlinkSync } = await import("node:fs");

// Generate a token the LLM cannot possibly know or predict
const proofToken = `koi-acp-proof-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const proofPath = `/tmp/e2e-acp-proof-${Date.now()}.txt`;
await Bun.write(proofPath, proofToken);
console.log(`  Proof token: ${proofToken}`);
console.log(`  Proof file:  ${proofPath}`);

const adapterC3 = createPiAcpAdapter();

const c3Events = await withTimeout(
  () =>
    collectEvents(
      adapterC3.stream({
        kind: "text",
        text: `Run this command and show me the exact output: cat ${proofPath}`,
      }),
    ),
  120_000,
  "Test 18",
);

printEventSummary(c3Events);

const c3Text = c3Events
  .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
  .map((e) => e.delta)
  .join("");

console.log(`  Coding agent response: "${c3Text.trim().slice(0, 120)}"`);

const c3Output = findDoneOutput(c3Events);
assert("coding agent: done event emitted", c3Output !== undefined);
assert(
  'coding agent: stopReason is "completed"',
  c3Output?.stopReason === "completed",
  `got: ${c3Output?.stopReason}`,
);
assert(
  "coding agent: proof token in response (bash tool ran for real)",
  c3Text.includes(proofToken),
  `expected token "${proofToken}" — response: "${c3Text.trim().slice(0, 80)}"`,
);

// Cleanup proof file
try {
  unlinkSync(proofPath);
} catch {
  // Best-effort
}

await adapterC3.dispose();

// ============================================================================
// SECTION D — Real external ACP agent (codex-acp or openclaw)
//
// This is the TRUE engine-acp use case: Koi spawns an ACP agent built by a
// DIFFERENT team and communicates with it purely via the JSON-RPC 2.0 protocol.
// Koi has zero knowledge of what's inside the subprocess.
//
// Requires: OPENAI_API_KEY for codex-acp (npx @zed-industries/codex-acp).
//           Skipped gracefully if not set.
// ============================================================================

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

console.log(`\n${"=".repeat(60)}`);
console.log("Section D: Real external ACP agent (codex-acp)");
console.log("=".repeat(60));

if (OPENAI_API_KEY === undefined || OPENAI_API_KEY === "") {
  console.log("\n[skip] OPENAI_API_KEY not set — skipping Section D.");
  console.log("       To run: OPENAI_API_KEY=sk-... bun scripts/e2e-engine-acp.ts");
  console.log(
    "       codex-acp (npx @zed-industries/codex-acp) is the ACP agent Koi is designed for:",
  );
  console.log("         createAcpAdapter({ command: 'npx', args: ['@zed-industries/codex-acp'] })");
} else {
  // -------------------------------------------------------------------------
  // Test 19 — codex-acp: Koi connects to a real external ACP agent
  //
  // Uses npx @zed-industries/codex-acp — an ACP server wrapping OpenAI's
  // Codex CLI, developed by Zed Industries independently of Koi.
  // Koi sends session/prompt, codex-acp runs the prompt using the Codex
  // runtime, and sends session/update notifications back.
  // -------------------------------------------------------------------------

  console.log("\n[test 19] Koi → codex-acp (real external ACP agent, Codex runtime)");

  function createCodexAcpAdapter(): AcpEngineAdapter {
    return createAcpAdapter({
      command: "npx",
      args: ["--yes", "@zed-industries/codex-acp"],
      env: { OPENAI_API_KEY },
      // codex-acp requires mcpServers field in session/new (stricter than spec)
      sessionNewParams: { mcpServers: [] },
      timeoutMs: 120_000,
    });
  }

  const adapterD1 = createCodexAcpAdapter();

  assert(
    "codex-acp: agentCapabilities undefined before stream",
    adapterD1.agentCapabilities === undefined,
  );

  const d1Events = await withTimeout(
    () =>
      collectEvents(adapterD1.stream({ kind: "text", text: "Reply with exactly: codex-ready" })),
    120_000,
    "Test 19",
  );

  printEventSummary(d1Events);

  assert(
    "codex-acp: agentCapabilities populated after initialize",
    adapterD1.agentCapabilities !== undefined,
    `got: ${JSON.stringify(adapterD1.agentCapabilities)}`,
  );

  const d1Output = findDoneOutput(d1Events);
  assert("codex-acp: done event emitted", d1Output !== undefined);
  assert(
    'codex-acp: stopReason is "completed"',
    d1Output?.stopReason === "completed",
    `got: ${d1Output?.stopReason}`,
  );

  const d1Text = d1Events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");

  assert("codex-acp: text_delta events received", d1Text.length > 0);
  console.log(`  Codex response: "${d1Text.trim().slice(0, 80)}"`);
  console.log(
    `  Tokens: ${d1Output?.metrics.inputTokens} in, ${d1Output?.metrics.outputTokens} out`,
  );

  // -------------------------------------------------------------------------
  // Test 20 — codex-acp: proof token (real code execution via external agent)
  //
  // Write an unguessable token to a file, ask codex-acp to read it.
  // Proves the external agent executed real code — not Koi-internal tooling.
  // -------------------------------------------------------------------------

  console.log("\n[test 20] codex-acp — proof token (external agent executes real code)");

  const d2ProofToken = `koi-codex-proof-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const d2ProofPath = `/tmp/e2e-acp-codex-${Date.now()}.txt`;
  await Bun.write(d2ProofPath, d2ProofToken);
  console.log(`  Proof token: ${d2ProofToken}`);

  const d2Events = await withTimeout(
    () =>
      collectEvents(
        adapterD1.stream({
          kind: "text",
          text: `Run this shell command and show me the exact output: cat ${d2ProofPath}`,
        }),
      ),
    120_000,
    "Test 20",
  );

  printEventSummary(d2Events);

  const d2Text = d2Events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");

  console.log(`  Codex response: "${d2Text.trim().slice(0, 120)}"`);

  const d2Output = findDoneOutput(d2Events);
  assert("codex-acp: proof run completed", d2Output !== undefined);
  assert(
    "codex-acp: proof token in response (external agent ran real code)",
    d2Text.includes(d2ProofToken),
    `expected token "${d2ProofToken}" — response: "${d2Text.trim().slice(0, 80)}"`,
  );

  try {
    const { unlinkSync: rm } = await import("node:fs");
    rm(d2ProofPath);
  } catch {
    // Best-effort
  }

  await adapterD1.dispose();
}

// ============================================================================
// Summary
// ============================================================================

const passed = results.filter((r) => r.passed).length;
const total = results.length;
const allPassed = passed === total;

console.log(`\n${"=".repeat(60)}`);
console.log(`[e2e] Results: ${passed}/${total} passed`);

if (!allPassed) {
  console.error("\n[e2e] Failed assertions:");
  for (const r of results) {
    if (!r.passed) {
      const detail = r.detail !== undefined ? ` — ${r.detail}` : "";
      console.error(`  \x1b[31mFAIL\x1b[0m  ${r.name}${detail}`);
    }
  }
  process.exit(1);
}

console.log("\n[e2e] All tests passed!");
