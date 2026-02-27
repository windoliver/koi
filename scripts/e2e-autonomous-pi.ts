#!/usr/bin/env bun

/**
 * E2E: Autonomous Agent Infrastructure with Real LLM (Pi Engine).
 *
 * Validates all three new packages (@koi/snapshot-store-sqlite,
 * @koi/harness-scheduler, @koi/autonomous) wired through the
 * full L1 runtime (createKoi + createPiAdapter).
 *
 * Tests:
 *   1. SQLite snapshot store persists harness snapshots
 *   2. start() → real LLM call through createKoi with harness middleware
 *   3. pause() persists to SQLite store (not in-memory)
 *   4. Scheduler auto-resumes suspended harness
 *   5. Resume → real LLM call (session 2) through middleware chain
 *   6. AutonomousAgent.middleware() composes correctly
 *   7. completeTask() → all-done transition stops scheduler
 *   8. Dispose ordering: scheduler first, then harness
 *   9. SQLite store survives data across operations (read-back)
 *  10. Full lifecycle with AutonomousAgent composition
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-autonomous-pi.ts
 *
 * Cost: ~$0.02 per run (2–3 haiku calls).
 */

import { createAutonomousAgent } from "../packages/autonomous/src/autonomous.js";
import type {
  EngineEvent,
  EngineMetrics,
  EngineOutput,
  HarnessSnapshot,
  HarnessSnapshotStore,
  SessionCheckpoint,
  SessionPersistence,
} from "../packages/core/src/index.js";
import { agentId, chainId, harnessId, taskItemId } from "../packages/core/src/index.js";
import { createKoi } from "../packages/engine/src/koi.js";
import { createPiAdapter } from "../packages/engine-pi/src/adapter.js";
import { createHarnessScheduler } from "../packages/harness-scheduler/src/scheduler.js";
import { createLongRunningHarness } from "../packages/long-running/src/harness.js";
import type { LongRunningHarness, SessionResult } from "../packages/long-running/src/types.js";
import { createSqliteSnapshotStore } from "../packages/snapshot-store-sqlite/src/sqlite-store.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Skipping.");
  process.exit(0);
}

console.log("[e2e] Starting autonomous agent infrastructure E2E tests...");
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

async function waitForPhase(
  getPhase: () => string,
  targetPhases: readonly string[],
  timeoutMs: number = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!targetPhases.includes(getPhase())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for phase ${targetPhases.join("|")}, got ${getPhase()}`);
    }
    await Bun.sleep(10);
  }
}

// ---------------------------------------------------------------------------
// Mock SessionPersistence (captures checkpoints for assertions)
// ---------------------------------------------------------------------------

function createTrackingPersistence(): SessionPersistence & {
  readonly savedCheckpoints: SessionCheckpoint[];
} {
  const savedCheckpoints: SessionCheckpoint[] = [];

  return {
    savedCheckpoints,
    saveSession: () => ({ ok: true as const, value: undefined }),
    loadSession: () => ({
      ok: false as const,
      error: { code: "NOT_FOUND" as const, message: "Not found", retryable: false },
    }),
    removeSession: () => ({ ok: true as const, value: undefined }),
    listSessions: () => ({ ok: true as const, value: [] }),
    saveCheckpoint(cp: SessionCheckpoint) {
      savedCheckpoints.push(cp);
      return { ok: true as const, value: undefined };
    },
    loadLatestCheckpoint() {
      return { ok: true as const, value: undefined };
    },
    listCheckpoints: () => ({ ok: true as const, value: [] }),
    savePendingFrame: () => ({ ok: true as const, value: undefined }),
    loadPendingFrames: () => ({ ok: true as const, value: [] }),
    clearPendingFrames: () => ({ ok: true as const, value: undefined }),
    removePendingFrame: () => ({ ok: true as const, value: undefined }),
    recover: () => ({
      ok: true as const,
      value: { sessions: [], checkpoints: new Map(), pendingFrames: new Map(), skipped: [] },
    }),
    close: () => undefined,
  };
}

// ---------------------------------------------------------------------------
// Shared config
// ---------------------------------------------------------------------------

const TEST_HARNESS_ID = harnessId("e2e-autonomous");
const TEST_AGENT_ID = agentId("e2e-autonomous-agent");
const TEST_CHAIN_ID = chainId(TEST_HARNESS_ID);
const MODEL = "anthropic:claude-haiku-4-5-20251001"; // Cheapest for E2E

function createAdapter(): ReturnType<typeof createPiAdapter> {
  return createPiAdapter({
    model: MODEL,
    systemPrompt: "You are a concise assistant. Answer in 1-2 sentences max.",
    getApiKey: async () => API_KEY,
  });
}

// =========================================================================
// Test 1: SQLite snapshot store works as HarnessSnapshotStore
// =========================================================================

console.log("[test 1] SQLite snapshot store as HarnessSnapshotStore");

const sqliteStore: HarnessSnapshotStore & { readonly close: () => void } =
  createSqliteSnapshotStore<HarnessSnapshot>({ dbPath: ":memory:" });

assert("SQLite store created for HarnessSnapshot", sqliteStore !== undefined);

// Verify basic store operations before wiring into harness
const testSnapshot: HarnessSnapshot = {
  harnessId: TEST_HARNESS_ID,
  phase: "idle",
  sessionSeq: 0,
  taskBoard: { items: [], results: [] },
  summaries: [],
  keyArtifacts: [],
  metrics: {
    totalSessions: 0,
    totalTurns: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    completedTaskCount: 0,
    pendingTaskCount: 0,
    elapsedMs: 0,
  },
};

const putResult = await sqliteStore.put(TEST_CHAIN_ID, testSnapshot, []);
assert("SQLite store put() succeeds", putResult.ok === true);

if (putResult.ok && putResult.value !== undefined) {
  const getResult = await sqliteStore.get(putResult.value.nodeId);
  assert("SQLite store get() retrieves snapshot", getResult.ok === true);
  if (getResult.ok) {
    assert(
      "retrieved snapshot matches stored data",
      getResult.value.data.harnessId === TEST_HARNESS_ID,
    );
  }
}

// =========================================================================
// Test 2: Full lifecycle — createKoi + Pi adapter + harness middleware
// =========================================================================

console.log("\n[test 2] start() → real LLM call via createKoi + harness middleware");

// Use a FRESH SQLite store for the harness (the test 1 store has manual test data)
const harnessStore: HarnessSnapshotStore & { readonly close: () => void } =
  createSqliteSnapshotStore<HarnessSnapshot>({ dbPath: ":memory:" });
const persistence = createTrackingPersistence();

const harness: LongRunningHarness = createLongRunningHarness({
  harnessId: TEST_HARNESS_ID,
  agentId: TEST_AGENT_ID,
  harnessStore,
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
      description: "Solve a simple math problem",
      dependencies: [],
      priority: 1,
      maxRetries: 3,
      retries: 0,
      status: "pending" as const,
    },
  ],
  results: [],
};

const startResult = await harness.start(taskPlan);
assert("start() returns ok", startResult.ok === true);

if (!startResult.ok) {
  console.error("[e2e] start() failed, cannot continue:", startResult.error);
  process.exit(1);
}

assert("start() returns text engine input", startResult.value.engineInput.kind === "text");
assert("phase is active after start", harness.status().phase === "active");

// Run session 1 through createKoi with harness middleware
const adapter1 = createAdapter();
const koi1 = await createKoi({
  manifest: {
    name: "e2e-autonomous-agent",
    version: "0.0.1",
    model: { name: MODEL },
  },
  adapter: adapter1,
  middleware: [harness.createMiddleware()], // Harness middleware in the chain!
  limits: { maxTurns: 3, maxDurationMs: 60_000, maxTokens: 10_000 },
});

const events1: EngineEvent[] = [];
let output1: EngineOutput | undefined;

await withTimeout(
  async () => {
    for await (const event of koi1.run(startResult.value.engineInput)) {
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
  "Test 2: LLM session 1",
);

console.log(""); // newline after streaming

assert("LLM produced events", events1.length > 0);
assert("done event emitted", output1 !== undefined);
assert(
  "output has real tokens",
  output1 !== undefined && output1.metrics.inputTokens > 0 && output1.metrics.outputTokens > 0,
  `input=${output1?.metrics.inputTokens}, output=${output1?.metrics.outputTokens}`,
);

await koi1.dispose();

// =========================================================================
// Test 3: pause() persists snapshot to SQLite store
// =========================================================================

console.log("\n[test 3] pause() persists to SQLite store");

const sessionMetrics: EngineMetrics = output1?.metrics ?? {
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  turns: 1,
  durationMs: 1000,
};

const sessionResult1: SessionResult = {
  sessionId: startResult.value.sessionId,
  metrics: sessionMetrics,
  summary: "E2E session 1: Agent received task plan.",
  engineState: { engineId: "pi", data: { turnCount: sessionMetrics.turns } },
};

const pauseResult = await harness.pause(sessionResult1);
assert("pause() returns ok", pauseResult.ok === true);
assert("phase is suspended after pause", harness.status().phase === "suspended");
assert("metrics.totalSessions = 1", harness.status().metrics.totalSessions === 1);
assert("metrics.totalInputTokens > 0", harness.status().metrics.totalInputTokens > 0);

// Verify snapshot in SQLite store
const headAfterPause = await harnessStore.head(TEST_CHAIN_ID);
assert("SQLite store has snapshot after pause", headAfterPause.ok === true);
if (headAfterPause.ok && headAfterPause.value !== undefined) {
  assert(
    "snapshot phase is suspended",
    headAfterPause.value.data.phase === "suspended",
    `got: ${headAfterPause.value.data.phase}`,
  );
  assert(
    "snapshot has summary",
    headAfterPause.value.data.summaries.length === 1,
    `got: ${headAfterPause.value.data.summaries.length}`,
  );
}

// =========================================================================
// Test 4: Scheduler auto-resumes suspended harness
// =========================================================================

console.log("\n[test 4] Scheduler auto-resumes suspended harness");

// Create scheduler that polls the real harness
const scheduler = createHarnessScheduler({
  harness,
  pollIntervalMs: 100, // Fast for testing
  maxRetries: 3,
});

// Harness is currently suspended — scheduler should detect and resume
scheduler.start();
assert("scheduler phase is running", scheduler.status().phase === "running");

await waitForPhase(() => harness.status().phase, ["active"], 10_000);
assert("harness auto-resumed to active", harness.status().phase === "active");
assert("scheduler totalResumes >= 1", scheduler.status().totalResumes >= 1);

// Stop scheduler for now (we'll run session 2 manually)
scheduler.stop();
await waitForPhase(() => scheduler.status().phase, ["stopped"], 5_000);
assert("scheduler stopped after manual stop", scheduler.status().phase === "stopped");

// =========================================================================
// Test 5: Session 2 with resumed context through middleware chain
// =========================================================================

console.log("\n[test 5] Resume → real LLM call (session 2)");

// The harness.resume() was already called by the scheduler, so harness is active.
// We need the resume result to get the engine input for session 2.
// Since the scheduler called resume(), let's pause and resume manually for the engine input.

const pauseForS2: SessionResult = {
  sessionId: `scheduler-resumed-${Date.now()}`,
  metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
  summary: "Brief pause to get resumeResult for session 2.",
};
await harness.pause(pauseForS2);
assert("paused for session 2 setup", harness.status().phase === "suspended");

const resumeResult = await harness.resume();
assert("resume() returns ok", resumeResult.ok === true);

if (resumeResult.ok) {
  assert("phase is active after resume", harness.status().phase === "active");
  assert(
    "resume returns messages or resume input",
    resumeResult.value.engineInput.kind === "messages" ||
      resumeResult.value.engineInput.kind === "resume" ||
      resumeResult.value.engineInput.kind === "text",
  );
  assert(
    "resume sessionId differs from start",
    resumeResult.value.sessionId !== startResult.value.sessionId,
  );

  // Run session 2
  const adapter2 = createAdapter();
  const koi2 = await createKoi({
    manifest: {
      name: "e2e-autonomous-agent-s2",
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
    "Test 5: LLM session 2",
  );
  console.log("");

  assert("session 2 produced output", output2 !== undefined);
  assert(
    "session 2 has tokens",
    output2 !== undefined && output2.metrics.totalTokens > 0,
    `totalTokens=${output2?.metrics.totalTokens}`,
  );

  await koi2.dispose();
}

// =========================================================================
// Test 6: AutonomousAgent.middleware() composes correctly
// =========================================================================

console.log("\n[test 6] AutonomousAgent middleware composition");

// Create a fresh scheduler for the autonomous agent
const scheduler2 = createHarnessScheduler({
  harness,
  pollIntervalMs: 100,
});

const compactorMw = { name: "e2e-compactor" } as const;
const agent = createAutonomousAgent({
  harness,
  scheduler: scheduler2,
  compactorMiddleware: compactorMw,
});

const mw = agent.middleware();
assert("middleware() returns 2 items (harness + compactor)", mw.length === 2);
assert("first middleware is from harness", mw[0]?.name !== undefined && mw[0].name.length > 0);
assert("second middleware is compactor", mw[1]?.name === "e2e-compactor");
assert("agent.harness is the harness", agent.harness === harness);
assert("agent.scheduler is the scheduler", agent.scheduler === scheduler2);

// =========================================================================
// Test 7: completeTask() → all-done transition
// =========================================================================

console.log("\n[test 7] completeTask() → completed transition");

const ct1 = await harness.completeTask(taskItemId("task-greet"), {
  taskId: taskItemId("task-greet"),
  output: "Greeted user with fun fact",
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
  output: "Math solved",
  durationMs: 1000,
});
assert("completeTask(task-math) returns ok", ct2.ok === true);
assert(
  "phase is completed after all tasks done",
  harness.status().phase === "completed",
  `got: ${harness.status().phase}`,
);
assert("completedTaskCount = 2", harness.status().metrics.completedTaskCount === 2);
assert("pendingTaskCount = 0", harness.status().metrics.pendingTaskCount === 0);

// =========================================================================
// Test 8: Scheduler detects completed → stops
// =========================================================================

console.log("\n[test 8] Scheduler stops when harness completes");

const scheduler3 = createHarnessScheduler({
  harness,
  pollIntervalMs: 50,
});
scheduler3.start();

await waitForPhase(() => scheduler3.status().phase, ["stopped"], 5_000);
assert(
  "scheduler detected completed and stopped",
  scheduler3.status().phase === "stopped",
  `got: ${scheduler3.status().phase}`,
);
assert(
  "scheduler did not resume (harness was completed, not suspended)",
  scheduler3.status().totalResumes === 0,
);

await scheduler3.dispose();

// =========================================================================
// Test 9: SQLite store has full snapshot chain
// =========================================================================

console.log("\n[test 9] SQLite store snapshot chain integrity");

const listResult = await harnessStore.list(TEST_CHAIN_ID);
assert("list() returns ok", listResult.ok === true);
if (listResult.ok) {
  assert(
    "store has multiple snapshots (start + pause cycles)",
    listResult.value.length >= 2,
    `got: ${listResult.value.length}`,
  );

  // Most recent snapshot should be completed
  const latestHead = await harnessStore.head(TEST_CHAIN_ID);
  if (latestHead.ok && latestHead.value !== undefined) {
    assert(
      "latest snapshot shows completed phase",
      latestHead.value.data.phase === "completed",
      `got: ${latestHead.value.data.phase}`,
    );
    assert(
      "latest snapshot has accumulated metrics",
      latestHead.value.data.metrics.totalSessions >= 1,
      `totalSessions: ${latestHead.value.data.metrics.totalSessions}`,
    );
  }
}

// =========================================================================
// Test 10: Full AutonomousAgent dispose ordering
// =========================================================================

console.log("\n[test 10] AutonomousAgent dispose ordering");

// Use the autonomous agent from test 6 — disposes scheduler then harness
await agent.dispose();
assert("autonomous agent disposed without errors", true);

// Verify scheduler is stopped after dispose
assert(
  "scheduler stopped after dispose",
  scheduler2.status().phase === "idle" || scheduler2.status().phase === "stopped",
  `got: ${scheduler2.status().phase}`,
);

// =========================================================================
// Cleanup
// =========================================================================

sqliteStore.close();
harnessStore.close();

// =========================================================================
// Summary
// =========================================================================

const passed = results.filter((r) => r.passed).length;
const total = results.length;
const allPassed = passed === total;

console.log(`\n${"=".repeat(60)}`);
console.log(`[e2e] Results: ${passed}/${total} passed`);

if (!allPassed) {
  console.error("\n[e2e] Failed assertions:");
  for (const r of results) {
    if (!r.passed) {
      const detail = r.detail ? ` — ${r.detail}` : "";
      console.error(`  \x1b[31mFAIL\x1b[0m  ${r.name}${detail}`);
    }
  }
  process.exit(1);
}

console.log("\n[e2e] All tests passed!");
