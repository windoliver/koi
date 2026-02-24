#!/usr/bin/env bun

/**
 * Manual E2E test: @koi/middleware-compactor
 *
 * Validates the compactor middleware end-to-end:
 *   1. Loop adapter: compaction triggers + archiver + store with real model call
 *   2. Pi adapter:   session restore via onSessionStart + store.load()
 *   3. Pi adapter:   overflow recovery (simulated overflow, real retry with nonce-based piParamsStore)
 *
 * Usage:
 *   bun scripts/e2e-compactor.ts
 *
 * Requires: ANTHROPIC_API_KEY in environment (auto-loaded from .env by Bun).
 * Cost: ~$0.02-0.04 per run (haiku model, minimal prompts).
 */

import type { CompactionResult } from "../packages/core/src/context.js";
import type {
  EngineEvent,
  InboundMessage,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
} from "../packages/core/src/index.js";
import { createKoi } from "../packages/engine/src/koi.js";
import { createLoopAdapter } from "../packages/engine-loop/src/loop-adapter.js";
import { createPiAdapter } from "../packages/engine-pi/src/adapter.js";
import { createCompactorMiddleware } from "../packages/middleware-compactor/src/compactor-middleware.js";
import { createMemoryCompactionStore } from "../packages/middleware-compactor/src/memory-compaction-store.js";
import type {
  CompactionArchiver,
  CompactionStore,
} from "../packages/middleware-compactor/src/types.js";
import { createAnthropicAdapter } from "../packages/model-router/src/adapters/anthropic.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Skipping.");
  process.exit(1);
}

console.log("[e2e] Starting middleware-compactor E2E test...\n");

const PI_MODEL = "anthropic:claude-haiku-4-5-20251001";
const MODEL_NAME = "claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

const results: TestResult[] = []; // let justified: test accumulator

function record(name: string, condition: boolean, detail?: string): void {
  results.push({ name, passed: condition, detail });
  const tag = condition ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${tag}  ${name}`);
  if (detail !== undefined) console.log(`        ${detail}`);
}

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const out: EngineEvent[] = []; // let justified: test accumulator
  for await (const event of iterable) {
    out.push(event);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Test 1: Compaction + Archiver + Store (loop adapter + real Anthropic model)
//
// Pre-seeds 3 messages so compaction triggers on the first model call.
// After compaction, the real Anthropic model call validates that the
// compacted context (summary + recent message) works end-to-end.
//
// messageCount: 3 triggers compaction (3 pre-seeded messages).
// preserveRecent: 1 keeps only the last message.
// ---------------------------------------------------------------------------

async function testCompactionWithArchiver(): Promise<void> {
  console.log("\n--- Test 1: Compaction + Archiver + Store (loop + real Anthropic) ---");

  // Track archiver calls
  let archiverCalled = false; // let required: set in archive callback
  let archivedSummary = ""; // let required: set in archive callback
  let archivedMessageCount = 0; // let required: set in archive callback
  const archiver: CompactionArchiver = {
    archive: async (messages, summary) => {
      archiverCalled = true;
      archivedSummary = summary;
      archivedMessageCount = messages.length;
    },
  };

  // Track store calls
  const store = createMemoryCompactionStore();
  let storeSaveSessionId = ""; // let required: set in store wrapper
  let storeSaveCalled = false; // let required: set in store wrapper
  const wrappedStore: CompactionStore = {
    save: async (sessionId, result) => {
      storeSaveCalled = true;
      storeSaveSessionId = sessionId;
      await store.save(sessionId, result);
    },
    load: async (sessionId) => store.load(sessionId),
  };

  // Real Anthropic model call
  const anthropic = createAnthropicAdapter({ apiKey: API_KEY });
  let callCount = 0; // let required: tracks model calls
  const modelCall: ModelHandler = async (request: ModelRequest): Promise<ModelResponse> => {
    callCount++;
    // Real LLM call — validates the compacted context is valid
    return anthropic.complete({ ...request, model: MODEL_NAME, maxTokens: 100 });
  };

  const compactorMw = createCompactorMiddleware({
    summarizer: async () => ({
      content: "Summary: User asked about math (2+2=4) and geography (capital of France).",
      model: MODEL_NAME,
    }),
    contextWindowSize: 10_000,
    trigger: { messageCount: 3 },
    preserveRecent: 1,
    maxSummaryTokens: 200,
    archiver,
    store: wrappedStore,
  });

  const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

  const runtime = await createKoi({
    manifest: { name: "e2e-compactor-1", version: "0.0.1", model: { name: MODEL_NAME } },
    adapter,
    middleware: [compactorMw],
  });

  try {
    // Pre-seed with 3 messages so compaction triggers on the first model call.
    // After compaction: [summary, lastUserMsg] → sent to real Anthropic.
    const preseededMessages: readonly InboundMessage[] = [
      {
        content: [{ kind: "text", text: "What is 2 + 2?" }],
        senderId: "user",
        timestamp: Date.now() - 2000,
      },
      {
        content: [{ kind: "text", text: "2 + 2 = 4." }],
        senderId: "assistant",
        timestamp: Date.now() - 1000,
      },
      {
        content: [{ kind: "text", text: "What is the capital of France?" }],
        senderId: "user",
        timestamp: Date.now(),
      },
    ];

    const events = await collectEvents(
      runtime.run({ kind: "messages", messages: preseededMessages }),
    );

    const doneEvent = events.find((e) => e.kind === "done");
    record("Agent completed", doneEvent !== undefined);
    record(
      "Real LLM call made with compacted context",
      callCount >= 1,
      `${String(callCount)} model calls`,
    );

    record(
      "Archiver called with messages + summary",
      archiverCalled && archivedMessageCount > 0 && archivedSummary.length > 0,
      archiverCalled
        ? `${String(archivedMessageCount)} msgs, summary: "${archivedSummary.slice(0, 60)}"`
        : "archiver was not called",
    );

    record(
      "Store.save() called with real sessionId",
      storeSaveCalled && storeSaveSessionId.length > 0,
      storeSaveCalled ? `sessionId: "${storeSaveSessionId}"` : "store.save() not called",
    );
  } finally {
    await runtime.dispose?.();
  }
}

// ---------------------------------------------------------------------------
// Test 2: Session restore via onSessionStart (Pi adapter)
//
// Pre-populates store, then creates a Pi runtime that calls onSessionStart.
// Observer middleware at priority 300 (inner to compactor 225) sees
// the compacted/restored messages.
// ---------------------------------------------------------------------------

async function testSessionRestore(): Promise<void> {
  console.log("\n--- Test 2: Session restore via onSessionStart (Pi adapter) ---");

  const summaryResult: CompactionResult = {
    messages: [
      {
        content: [{ kind: "text", text: "Previous session summary: user discussed weather." }],
        senderId: "system:compactor",
        timestamp: Date.now(),
        metadata: { compacted: true },
      },
    ],
    originalTokens: 500,
    compactedTokens: 50,
    strategy: "llm-summary",
  };

  let loadCalled = false; // let required: set in store wrapper
  let loadedSessionId = ""; // let required: set in store wrapper
  const wrappedStore: CompactionStore = {
    save: async () => {},
    load: async (sessionId) => {
      loadCalled = true;
      loadedSessionId = sessionId;
      return summaryResult;
    },
  };

  // Priority 300 = INNER to compactor (225), sees modified messages
  let interceptedMessages: readonly InboundMessage[] = []; // let required: set in middleware
  const innerObserver: KoiMiddleware = {
    name: "e2e-inner-observer",
    priority: 300,
    wrapModelStream: async function* (_ctx, request, next) {
      interceptedMessages = request.messages;
      yield* next(request);
    },
  };

  const compactorMw = createCompactorMiddleware({
    summarizer: async () => ({ content: "summary", model: MODEL_NAME }),
    trigger: { messageCount: 100 },
    store: wrappedStore,
  });

  const piAdapter = createPiAdapter({
    model: PI_MODEL,
    systemPrompt: "Reply with one word.",
    getApiKey: async () => API_KEY,
    thinkingLevel: "off",
  });

  const runtime = await createKoi({
    manifest: { name: "e2e-restore", version: "0.0.1", model: { name: MODEL_NAME } },
    adapter: piAdapter,
    middleware: [innerObserver, compactorMw],
  });

  try {
    const events = await collectEvents(runtime.run({ kind: "text", text: "Hello" }));

    const doneEvent = events.find((e) => e.kind === "done");
    record("Agent completed with store configured", doneEvent !== undefined);
    record(
      "store.load() called during onSessionStart",
      loadCalled && loadedSessionId.length > 0,
      `sessionId: "${loadedSessionId}"`,
    );

    // Check if summary was prepended (observer is inner, sees compacted messages)
    const hasSummary =
      interceptedMessages.length > 0 && interceptedMessages[0]?.senderId === "system:compactor";
    record(
      "Summary message prepended (inner observer sees it)",
      hasSummary,
      hasSummary
        ? `First message is system:compactor (${String(interceptedMessages.length)} total)`
        : `First senderId: "${interceptedMessages[0]?.senderId ?? "(none)"}" (${String(interceptedMessages.length)} total)`,
    );
  } finally {
    await runtime.dispose?.();
  }
}

// ---------------------------------------------------------------------------
// Test 3: Overflow recovery (Pi adapter, streaming)
//
// Uses Pi adapter with wrapModelStream (inner observer) to simulate overflow
// on the first stream attempt. The compactor catches the context-overflow
// error, force-compacts, and retries. This proves the nonce-based piParamsStore
// fix works end-to-end: middleware-modified messages survive object spread and
// are correctly converted back to pi Messages for the retry API call.
// ---------------------------------------------------------------------------

async function testOverflowRecovery(): Promise<void> {
  console.log("\n--- Test 3: Overflow recovery (Pi adapter, simulated overflow) ---");

  let modelStreamCount = 0; // let required: tracks model stream attempts

  // Priority 300 = INNER to compactor (225) — simulates model throwing overflow
  const overflowSimulator: KoiMiddleware = {
    name: "e2e-overflow-sim",
    priority: 300,
    async *wrapModelStream(_ctx, request, next) {
      modelStreamCount++;
      if (modelStreamCount === 1) {
        // Simulate Anthropic context overflow error shape
        throw Object.assign(new Error("prompt is too long"), {
          type: "invalid_request_error",
        });
      }
      yield* next(request);
    },
  };

  const compactorMw = createCompactorMiddleware({
    summarizer: async () => ({
      content: "Compacted summary after overflow.",
      model: MODEL_NAME,
    }),
    contextWindowSize: 1000,
    trigger: { messageCount: 100 }, // Won't trigger normally
    preserveRecent: 1,
    maxSummaryTokens: 200,
    overflowRecovery: { maxRetries: 1 },
  });

  const piAdapter = createPiAdapter({
    model: PI_MODEL,
    systemPrompt: "Reply with one word.",
    getApiKey: async () => API_KEY,
    thinkingLevel: "off",
  });

  const runtime = await createKoi({
    manifest: { name: "e2e-overflow", version: "0.0.1", model: { name: MODEL_NAME } },
    adapter: piAdapter,
    middleware: [overflowSimulator, compactorMw],
  });

  try {
    const events = await collectEvents(
      runtime.run({ kind: "text", text: "Tell me about the weather." }),
    );

    const doneEvent = events.find((e) => e.kind === "done");
    record("Agent completed after overflow recovery", doneEvent !== undefined);
    record(
      "Model stream retried after overflow (>= 2 attempts)",
      modelStreamCount >= 2,
      `${String(modelStreamCount)} model stream attempts`,
    );
  } finally {
    await runtime.dispose?.();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    await testCompactionWithArchiver();
    await testSessionRestore();
    await testOverflowRecovery();
  } catch (e: unknown) {
    console.error("\n[e2e] FATAL:", e instanceof Error ? e.message : String(e));
    if (e instanceof Error && e.stack !== undefined) {
      console.error(e.stack);
    }
    process.exit(1);
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Results: ${String(passed)}/${String(total)} passed, ${String(failed)} failed`);
  console.log("─".repeat(60));

  if (failed > 0) {
    console.log("\nFailed tests:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  - ${r.name}${r.detail !== undefined ? ` (${r.detail})` : ""}`);
    }
    process.exit(1);
  }
}

await main();
