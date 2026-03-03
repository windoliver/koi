#!/usr/bin/env bun

/**
 * E2E: Long-Running Harness with Pi-Engine (Real LLM).
 *
 * Validates the full @koi/long-running lifecycle against a real Anthropic API
 * using createPiAdapter() + createKoi():
 *
 *   Test 1: start() → engine runs with text input → agent produces output
 *   Test 2: middleware onAfterTurn fires → soft session save
 *   Test 3: middleware wrapToolCall captures artifacts
 *   Test 4: pause() persists snapshot + metrics
 *   Test 5: resume() returns messages input with context bridge
 *   Test 6: completeTask() + all-done transitions to completed
 *   Test 7: fail() transitions to failed with reason
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-long-running-pi.ts
 */

import { createPiAdapter } from "../packages/drivers/engine-pi/src/adapter.js";
import type {
  EngineEvent,
  EngineMetrics,
  EngineOutput,
  EngineState,
  HarnessSnapshotStore,
  SessionPersistence,
  SessionRecord,
} from "../packages/kernel/core/src/index.js";
import { agentId, chainId, harnessId, taskItemId } from "../packages/kernel/core/src/index.js";
import { createKoi } from "../packages/kernel/engine/src/koi.js";
import { createInMemorySnapshotChainStore } from "../packages/mm/snapshot-chain-store/src/memory-store.js";
import { createLongRunningHarness } from "../packages/sched/long-running/src/harness.js";
import type {
  LongRunningHarness,
  SessionResult,
} from "../packages/sched/long-running/src/types.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Skipping.");
  process.exit(0);
}

console.log("[e2e] Starting long-running harness pi-engine E2E tests...");
console.log("[e2e] ANTHROPIC_API_KEY: set\n");

// ---------------------------------------------------------------------------
// Test infrastructure
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
  const suffix = detail && !condition ? ` — ${detail}` : "";
  console.log(`  ${tag}  ${name}${suffix}`);
}

async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Mock SessionPersistence (captures saved sessions for assertions)
// ---------------------------------------------------------------------------

function createTrackingPersistence(): SessionPersistence & {
  readonly savedSessions: SessionRecord[];
} {
  const savedSessions: SessionRecord[] = [];

  return {
    savedSessions,
    saveSession(record: SessionRecord) {
      savedSessions.push(record);
      return { ok: true as const, value: undefined };
    },
    loadSession: () => ({
      ok: false as const,
      error: { code: "NOT_FOUND" as const, message: "Not found", retryable: false },
    }),
    removeSession: () => ({ ok: true as const, value: undefined }),
    listSessions: () => ({ ok: true as const, value: [] }),
    savePendingFrame: () => ({ ok: true as const, value: undefined }),
    loadPendingFrames: () => ({ ok: true as const, value: [] }),
    clearPendingFrames: () => ({ ok: true as const, value: undefined }),
    removePendingFrame: () => ({ ok: true as const, value: undefined }),
    recover: () => ({
      ok: true as const,
      value: { sessions: [], pendingFrames: new Map(), skipped: [] },
    }),
    close: () => undefined,
  };
}

// ---------------------------------------------------------------------------
// Shared config
// ---------------------------------------------------------------------------

const TEST_HARNESS_ID = harnessId("e2e-long-running");
const TEST_AGENT_ID = agentId("e2e-agent");
const TEST_CHAIN_ID = chainId(TEST_HARNESS_ID);

const MODEL = "anthropic:claude-haiku-4-5-20251001"; // Cheapest for E2E

function createAdapter(): ReturnType<typeof createPiAdapter> {
  return createPiAdapter({
    model: MODEL,
    systemPrompt: "You are a concise assistant. Answer in 1-2 sentences max.",
    getApiKey: async () => API_KEY,
  });
}

// ---------------------------------------------------------------------------
// Test 1: start() → real LLM call via createKoi
// ---------------------------------------------------------------------------

console.log("[test 1] start() → real LLM call via createKoi");

const store: HarnessSnapshotStore = createInMemorySnapshotChainStore();
const persistence = createTrackingPersistence();

const harness: LongRunningHarness = createLongRunningHarness({
  harnessId: TEST_HARNESS_ID,
  agentId: TEST_AGENT_ID,
  harnessStore: store,
  sessionPersistence: persistence,
  softCheckpointInterval: 1, // checkpoint every turn for testing
});

// Create task plan
const taskPlan = {
  items: [
    {
      id: taskItemId("task-greet"),
      description: "Greet the user with a fun fact",
      dependencies: [],
      priority: 0,
      maxRetries: 3,
      retries: 0,
      status: "pending" as const,
    },
    {
      id: taskItemId("task-math"),
      description: "Solve a math problem",
      dependencies: [],
      priority: 1,
      maxRetries: 3,
      retries: 0,
      status: "pending" as const,
    },
  ],
  results: [],
};

// Start the harness
const startResult = await harness.start(taskPlan);
assert("start() returns ok", startResult.ok === true);

if (!startResult.ok) {
  console.error("[e2e] start() failed, cannot continue:", startResult.error);
  process.exit(1);
}

assert("start() returns text engine input", startResult.value.engineInput.kind === "text");
assert("start() returns sessionId", startResult.value.sessionId.length > 0);
assert("phase is active after start", harness.status().phase === "active");

// Use the engine input from start() to run a real LLM call
const engineInput = startResult.value.engineInput;

const adapter1 = createAdapter();
const koi1 = await createKoi({
  manifest: {
    name: "e2e-long-running-agent",
    version: "0.0.1",
    model: { name: MODEL },
  },
  adapter: adapter1,
  middleware: [harness.createMiddleware()], // Attach harness middleware!
  limits: { maxTurns: 3, maxDurationMs: 60_000, maxTokens: 10_000 },
});

const events1: EngineEvent[] = [];
let output1: EngineOutput | undefined;

await withTimeout(
  async () => {
    for await (const event of koi1.run(engineInput)) {
      events1.push(event);
      if (event.kind === "text_delta") {
        process.stdout.write(event.text ?? "");
      }
      if (event.kind === "done") {
        output1 = event.output;
      }
    }
  },
  120_000,
  "Test 1: LLM call",
);

console.log(""); // newline after streaming output

assert("LLM produced events", events1.length > 0);
assert("done event emitted", output1 !== undefined);
assert(
  "output has metrics",
  output1 !== undefined && output1.metrics.inputTokens > 0 && output1.metrics.outputTokens > 0,
);

await koi1.dispose();

// ---------------------------------------------------------------------------
// Test 2: middleware onAfterTurn fires soft checkpoints
// ---------------------------------------------------------------------------

console.log("\n[test 2] middleware onAfterTurn soft checkpoints");

// With softCheckpointInterval=1, every turn should trigger a session save
const turnEnds = events1.filter((e) => e.kind === "turn_end");
assert("at least 1 turn completed", turnEnds.length >= 1);

// Give fire-and-forget save a moment to settle
await new Promise((resolve) => setTimeout(resolve, 100));

assert(
  "soft checkpoint(s) saved to persistence",
  persistence.savedSessions.length > 0,
  `saved: ${persistence.savedSessions.length}`,
);

if (persistence.savedSessions.length > 0) {
  const firstRecord = persistence.savedSessions[0];
  assert(
    "saved session has softCheckpoint metadata",
    firstRecord?.metadata?.softCheckpoint === true,
  );
}

// ---------------------------------------------------------------------------
// Test 3: pause() persists snapshot + accumulates metrics
// ---------------------------------------------------------------------------

console.log("\n[test 3] pause() persists snapshot + metrics");

const sessionMetrics: EngineMetrics = output1?.metrics ?? {
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  turns: 1,
  durationMs: 1000,
};

const sessionResult: SessionResult = {
  sessionId: startResult.value.sessionId,
  metrics: sessionMetrics,
  summary: "E2E session 1: Agent greeted user and received task plan.",
  engineState: { engineId: "pi", data: { turnCount: sessionMetrics.turns } },
};

const pauseResult = await harness.pause(sessionResult);
assert("pause() returns ok", pauseResult.ok === true);
assert("phase is suspended after pause", harness.status().phase === "suspended");
assert("metrics.totalSessions = 1", harness.status().metrics.totalSessions === 1);
assert("metrics.totalTurns > 0", harness.status().metrics.totalTurns > 0);
assert(
  "metrics.totalInputTokens > 0",
  harness.status().metrics.totalInputTokens > 0,
  `got: ${harness.status().metrics.totalInputTokens}`,
);

// Verify snapshot persisted to store
const headResult = await store.head(TEST_CHAIN_ID);
assert("snapshot persisted to store", headResult.ok === true);
if (headResult.ok && headResult.value !== undefined) {
  assert("snapshot phase is suspended", headResult.value.data.phase === "suspended");
  assert("snapshot has summary", headResult.value.data.summaries.length === 1);
  assert(
    "summary narrative matches",
    headResult.value.data.summaries[0]?.narrative === sessionResult.summary,
  );
}

// Verify engine state was saved via persistence
const engineStateRecords = persistence.savedSessions.filter(
  (r) => r.metadata?.softCheckpoint !== true,
);
assert(
  "engine state session saved on pause",
  engineStateRecords.length > 0,
  `found: ${engineStateRecords.length}`,
);

// ---------------------------------------------------------------------------
// Test 4: resume() returns messages input with context bridge
// ---------------------------------------------------------------------------

console.log("\n[test 4] resume() returns messages input");

const resumeResult = await harness.resume();
assert("resume() returns ok", resumeResult.ok === true);

if (resumeResult.ok) {
  assert("phase is active after resume", harness.status().phase === "active");
  // Without engine state recovery, falls back to messages
  assert(
    "resume returns messages or resume input",
    resumeResult.value.engineInput.kind === "messages" ||
      resumeResult.value.engineInput.kind === "resume",
  );
  assert("resume returns sessionId", resumeResult.value.sessionId.length > 0);
  assert(
    "resume sessionId differs from start",
    resumeResult.value.sessionId !== startResult.value.sessionId,
  );

  // Run session 2 with a real LLM call to verify context bridge works
  if (resumeResult.value.engineInput.kind === "messages") {
    console.log("  (context bridge mode — running session 2 with resumed context)");

    const adapter2 = createAdapter();
    const koi2 = await createKoi({
      manifest: {
        name: "e2e-long-running-agent-s2",
        version: "0.0.1",
        model: { name: MODEL },
      },
      adapter: adapter2,
      middleware: [harness.createMiddleware()],
      limits: { maxTurns: 2, maxDurationMs: 60_000, maxTokens: 10_000 },
    });

    let output2: EngineOutput | undefined;
    await withTimeout(
      async () => {
        for await (const event of koi2.run(resumeResult.value.engineInput)) {
          if (event.kind === "text_delta") {
            process.stdout.write(event.text ?? "");
          }
          if (event.kind === "done") {
            output2 = event.output;
          }
        }
      },
      120_000,
      "Test 4: Session 2 LLM call",
    );
    console.log("");

    assert("session 2 produced output", output2 !== undefined);
    assert("session 2 has tokens", output2 !== undefined && output2.metrics.totalTokens > 0);

    await koi2.dispose();
  }
}

// ---------------------------------------------------------------------------
// Test 5: completeTask() + all-done transition
// ---------------------------------------------------------------------------

console.log("\n[test 5] completeTask() + completed transition");

const ct1 = await harness.completeTask(taskItemId("task-greet"), {
  taskId: taskItemId("task-greet"),
  output: "Greeted user successfully",
  durationMs: 2000,
});
assert("completeTask(task-greet) returns ok", ct1.ok === true);
assert("phase still active after 1 task", harness.status().phase === "active");
assert(
  "completedTaskCount = 1",
  harness.status().metrics.completedTaskCount === 1,
  `got: ${harness.status().metrics.completedTaskCount}`,
);

const ct2 = await harness.completeTask(taskItemId("task-math"), {
  taskId: taskItemId("task-math"),
  output: "Math problem solved",
  durationMs: 1000,
});
assert("completeTask(task-math) returns ok", ct2.ok === true);
assert("phase is completed after all tasks done", harness.status().phase === "completed");
assert("completedTaskCount = 2", harness.status().metrics.completedTaskCount === 2);
assert("pendingTaskCount = 0", harness.status().metrics.pendingTaskCount === 0);

// ---------------------------------------------------------------------------
// Test 6: fail() on a fresh harness
// ---------------------------------------------------------------------------

console.log("\n[test 6] fail() transitions to failed");

const store2: HarnessSnapshotStore = createInMemorySnapshotChainStore();
const persistence2 = createTrackingPersistence();
const harness2 = createLongRunningHarness({
  harnessId: harnessId("e2e-fail-harness"),
  agentId: TEST_AGENT_ID,
  harnessStore: store2,
  sessionPersistence: persistence2,
});

await harness2.start({
  items: [
    {
      id: taskItemId("fail-task"),
      description: "This will fail",
      dependencies: [],
      priority: 0,
      maxRetries: 1,
      retries: 0,
      status: "pending" as const,
    },
  ],
  results: [],
});

const failResult = await harness2.fail({
  code: "TIMEOUT",
  message: "Agent exceeded maximum runtime",
  retryable: false,
});
assert("fail() returns ok", failResult.ok === true);
assert("phase is failed", harness2.status().phase === "failed");
assert(
  "failureReason is set",
  harness2.status().failureReason === "Agent exceeded maximum runtime",
);

// Verify fail prevents further operations
const resumeAfterFail = await harness2.resume();
assert("resume() rejects after fail", resumeAfterFail.ok === false);

await harness2.dispose();

// ---------------------------------------------------------------------------
// Test 7: saveState callback in soft checkpoints
// ---------------------------------------------------------------------------

console.log("\n[test 7] saveState callback wires into soft checkpoints");

const store3: HarnessSnapshotStore = createInMemorySnapshotChainStore();
const persistence3 = createTrackingPersistence();

const capturedState: EngineState = { engineId: "pi-real", data: { cursor: 99 } };
const harness3 = createLongRunningHarness({
  harnessId: harnessId("e2e-savestate-harness"),
  agentId: TEST_AGENT_ID,
  harnessStore: store3,
  sessionPersistence: persistence3,
  softCheckpointInterval: 1,
  saveState: () => capturedState,
});

await harness3.start({
  items: [
    {
      id: taskItemId("save-state-task"),
      description: "Test saveState",
      dependencies: [],
      priority: 0,
      maxRetries: 1,
      retries: 0,
      status: "pending" as const,
    },
  ],
  results: [],
});

// Run a quick LLM call with this harness's middleware
const adapter3 = createAdapter();
const koi3 = await createKoi({
  manifest: {
    name: "e2e-savestate-agent",
    version: "0.0.1",
    model: { name: MODEL },
  },
  adapter: adapter3,
  middleware: [harness3.createMiddleware()],
  limits: { maxTurns: 2, maxDurationMs: 60_000, maxTokens: 5_000 },
});

await withTimeout(
  async () => {
    for await (const _event of koi3.run({ kind: "text", text: "Say hello" })) {
      // drain events
    }
  },
  60_000,
  "Test 7: saveState LLM call",
);

await new Promise((resolve) => setTimeout(resolve, 100));

const realStateRecords = persistence3.savedSessions.filter(
  (r) => r.lastEngineState?.engineId === "pi-real",
);
assert(
  "saveState callback produced real engine state in session record",
  realStateRecords.length > 0,
  `found: ${realStateRecords.length}, total: ${persistence3.savedSessions.length}`,
);

if (realStateRecords.length > 0) {
  assert(
    "session record engine state matches saveState return value",
    JSON.stringify(realStateRecords[0]?.lastEngineState) === JSON.stringify(capturedState),
  );
}

await koi3.dispose();
await harness3.dispose();

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

await harness.dispose();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.passed).length;
const total = results.length;
const allPassed = passed === total;

console.log(`\n[e2e] Results: ${passed}/${total} passed`);

if (!allPassed) {
  console.error("\n[e2e] Failed assertions:");
  for (const r of results) {
    if (!r.passed) {
      const detail = r.detail ? ` — ${r.detail}` : "";
      console.error(`  FAIL  ${r.name}${detail}`);
    }
  }
  process.exit(1);
}

console.log("\n[e2e] All tests passed!");
