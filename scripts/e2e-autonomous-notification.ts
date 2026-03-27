#!/usr/bin/env bun

/**
 * E2E: Autonomous completion notification flow.
 *
 * Tests the full lifecycle WITHOUT an LLM — uses manual task completion
 * to validate the harness→scheduler→pause→resume→complete→notify flow.
 *
 * Flow:
 *   1. Create harness with onCompleted/onFailed callbacks
 *   2. Start harness with task plan (3 tasks)
 *   3. Pause harness (simulates copilot run ending)
 *   4. Scheduler resumes via onResumed callback
 *   5. onResumed callback completes tasks and pauses
 *   6. Scheduler resumes again, completes remaining tasks
 *   7. onCompleted callback fires → notification logged
 *
 * Usage:
 *   bun scripts/e2e-autonomous-notification.ts
 */

import type {
  HarnessSnapshot,
  HarnessStatus,
  KoiError,
} from "../packages/kernel/core/src/index.js";
import { agentId, harnessId, taskItemId } from "../packages/kernel/core/src/index.js";
import { createInMemorySnapshotChainStore } from "../packages/mm/snapshot-chain-store/src/memory-store.js";
import { createHarnessScheduler } from "../packages/sched/harness-scheduler/src/scheduler.js";
import { createLongRunningHarness } from "../packages/sched/long-running/src/harness.js";
import type { LongRunningHarness } from "../packages/sched/long-running/src/types.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function step(msg: string): void {
  console.log(`\n\x1b[36m[step]\x1b[0m ${msg}`);
}

// ---------------------------------------------------------------------------
// In-memory session persistence (minimal)
// ---------------------------------------------------------------------------

function createMinimalPersistence() {
  const sessions = new Map<string, unknown>();
  return {
    saveSession: (record: { sessionId: string }) => {
      sessions.set(record.sessionId, record);
      return { ok: true as const, value: undefined };
    },
    loadSession: (sid: string) => {
      const record = sessions.get(sid);
      if (record === undefined) {
        return {
          ok: false as const,
          error: { code: "NOT_FOUND" as const, message: "Not found", retryable: false },
        };
      }
      return { ok: true as const, value: record };
    },
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
    close: () => {},
  };
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

console.log("[e2e] Autonomous completion notification flow\n");

// Track callback invocations
let completedCallbackFired = false;
let completedStatus: HarnessStatus | undefined;
let failedCallbackFired = false;
let resumeCount = 0;

const hId = harnessId("e2e-notify-harness");
const aId = agentId("e2e-notify-agent");
const harnessStore = createInMemorySnapshotChainStore<HarnessSnapshot>();
const persistence = createMinimalPersistence();

// Step 1: Create harness with callbacks
step("1. Create harness with onCompleted/onFailed callbacks");

const harness: LongRunningHarness = createLongRunningHarness({
  harnessId: hId,
  agentId: aId,
  harnessStore,
  sessionPersistence: persistence as never, // structural compatibility
  onCompleted: (status: HarnessStatus) => {
    completedCallbackFired = true;
    completedStatus = status;
    console.log(
      `  [callback] onCompleted fired — phase: ${status.phase}, tasks: ${status.metrics.completedTaskCount}`,
    );
  },
  onFailed: (_status: HarnessStatus, error: KoiError) => {
    failedCallbackFired = true;
    console.log(`  [callback] onFailed fired — ${error.message}`);
  },
});

assert("harness created", harness.status().phase === "idle");

// Step 2: Create task plan and start harness
step("2. Start harness with 3 tasks (t1, t2, t3 depends on t1+t2)");

const taskPlan = {
  items: [
    {
      id: taskItemId("t1"),
      description: "say hello",
      dependencies: [],
      priority: 0,
      maxRetries: 3,
      retries: 0,
      status: "assigned" as const,
    },
    {
      id: taskItemId("t2"),
      description: "say goodbye",
      dependencies: [],
      priority: 1,
      maxRetries: 3,
      retries: 0,
      status: "assigned" as const,
    },
    {
      id: taskItemId("t3"),
      description: "combine greetings",
      dependencies: [taskItemId("t1"), taskItemId("t2")],
      priority: 2,
      maxRetries: 3,
      retries: 0,
      status: "assigned" as const,
    },
  ],
  results: [],
};

const startResult = await harness.start(taskPlan);
assert("harness started OK", startResult.ok === true);
assert("phase is active", harness.status().phase === "active");

// Step 3: Pause harness (simulates copilot's initial run ending)
step("3. Pause harness (copilot run finished)");

const metrics = { totalTokens: 100, inputTokens: 60, outputTokens: 40, turns: 1, durationMs: 1000 };
const pauseResult = await harness.pause({ sessionId: "session-1", metrics });
assert("pause OK", pauseResult.ok === true);
assert("phase is suspended", harness.status().phase === "suspended");

// Step 4: Create scheduler with onResumed that simulates engine sub-sessions
step("4. Create scheduler with onResumed callback");

const scheduler = createHarnessScheduler({
  harness,
  pollIntervalMs: 100, // fast polling for test
  maxRetries: 3,
  delay: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 100))),
  onResumed: async (_resumeResult: unknown) => {
    resumeCount++;
    console.log(`  [onResumed] resume #${resumeCount} — driving sub-session`);

    // Simulate engine sub-session: complete one or two tasks per session
    const board = harness.status().taskBoard;
    const remaining = board.items.filter((i) => i.status === "assigned");

    for (const task of remaining.slice(0, 2)) {
      console.log(`  [onResumed] completing task: ${task.id}`);
      const cr = await harness.completeTask(task.id, {
        taskId: task.id,
        output: `Output for ${task.id}`,
        durationMs: 500,
      });
      if (!cr.ok) {
        console.log(`  [onResumed] completeTask failed: ${cr.error.message}`);
      }
    }

    // Check if all done — if not, pause for next cycle
    if (harness.status().phase !== "completed") {
      const pauseR = await harness.pause({
        sessionId: `sub-session-${resumeCount}`,
        metrics: { totalTokens: 50, inputTokens: 30, outputTokens: 20, turns: 1, durationMs: 500 },
      });
      if (!pauseR.ok) {
        console.log(`  [onResumed] pause failed: ${pauseR.error.message}`);
      }
    }
  },
});

// Step 5: Start scheduler and wait for completion
step("5. Start scheduler — should resume, complete tasks, fire onCompleted");

scheduler.start();

// Wait for completion (max 10s)
const deadline = Date.now() + 10_000;
while (
  harness.status().phase !== "completed" &&
  harness.status().phase !== "failed" &&
  Date.now() < deadline
) {
  await new Promise((r) => setTimeout(r, 200));
}

const finalPhase = harness.status().phase;
const schedulerStatus = scheduler.status();

step("6. Verify results");

assert("harness reached completed phase", finalPhase === "completed", `got: ${finalPhase}`);
assert("scheduler stopped", schedulerStatus.phase === "stopped", `got: ${schedulerStatus.phase}`);
assert(
  "all 3 tasks completed",
  harness.status().metrics.completedTaskCount === 3,
  `got: ${harness.status().metrics.completedTaskCount}`,
);
assert("onCompleted callback fired", completedCallbackFired === true);
assert("onCompleted received correct status", completedStatus?.phase === "completed");
assert("onCompleted has correct task count", completedStatus?.metrics.completedTaskCount === 3);
assert("onFailed did NOT fire", failedCallbackFired === false);
assert("scheduler resumed at least once", resumeCount >= 1, `resumeCount: ${resumeCount}`);

// Cleanup
await scheduler.dispose();
await harness.dispose();

// Summary
console.log(`\n${"=".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);

if (failed > 0) {
  process.exit(1);
}
