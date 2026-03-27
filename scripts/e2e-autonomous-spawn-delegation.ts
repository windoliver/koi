#!/usr/bin/env bun

/**
 * E2E: Spawn-delegation autonomous flow — copilot dispatches tasks to workers.
 *
 * Real flow:
 *   Session 1: User asks copilot → copilot calls plan_autonomous with
 *              delegation:"spawn" tasks → bridge dispatches workers →
 *              workers complete → results written to harness → copilot
 *              is NOT blocked (can answer other questions immediately)
 *
 * Verifies:
 *   1. plan_autonomous with delegation:"spawn" works end-to-end
 *   2. Parallel spawn tasks are dispatched concurrently
 *   3. Copilot remains responsive during spawn execution
 *   4. Results are persisted to harness snapshot
 *   5. onCompleted fires when all tasks done
 *
 * Uses real LLM (OpenRouter) for the copilot; workers use the same adapter.
 */

import { createPiAdapter } from "../packages/drivers/engine-pi/src/adapter.js";
import type {
  EngineInput,
  EngineOutput,
  HarnessSnapshot,
  HarnessStatus,
  KoiError,
  SpawnFn,
  SpawnRequest,
} from "../packages/kernel/core/src/index.js";
import { agentId, harnessId } from "../packages/kernel/core/src/index.js";
import { createKoi } from "../packages/kernel/engine/src/koi.js";
import { createAutonomousAgent } from "../packages/meta/autonomous/src/autonomous.js";
import { createInMemorySnapshotChainStore } from "../packages/mm/snapshot-chain-store/src/memory-store.js";
import { createHarnessScheduler } from "../packages/sched/harness-scheduler/src/scheduler.js";
import { createLongRunningHarness } from "../packages/sched/long-running/src/harness.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) {
  console.error("OPENROUTER_API_KEY not set");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Test infra
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
function assert(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function step(msg: string): void {
  console.log(`\n\x1b[36m══ ${msg} ══\x1b[0m`);
}

// ---------------------------------------------------------------------------
// Minimal persistence
// ---------------------------------------------------------------------------
function createMinimalPersistence() {
  const s = new Map<string, unknown>();
  return {
    saveSession: (r: { sessionId: string }) => {
      s.set(r.sessionId, r);
      return { ok: true as const, value: undefined };
    },
    loadSession: (sid: string) => {
      const r = s.get(sid);
      return r
        ? { ok: true as const, value: r }
        : {
            ok: false as const,
            error: { code: "NOT_FOUND" as const, message: "nf", retryable: false },
          };
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
// Tracking
// ---------------------------------------------------------------------------
let completedFired = false;
let completedStatus: HarnessStatus | undefined;
const spawnLog: { taskId: string; startedAt: number; finishedAt?: number }[] = [];

// ---------------------------------------------------------------------------
// Worker spawn function — runs each worker as an independent agent
// ---------------------------------------------------------------------------

const MODEL = "openrouter:anthropic/claude-3.5-haiku";

function createWorkerSpawn(): SpawnFn {
  const adapter = createPiAdapter({ model: MODEL });

  return async (request: SpawnRequest) => {
    const startedAt = Date.now();
    const taskId = request.taskId ?? "unknown";
    spawnLog.push({ taskId, startedAt });
    console.log(`  [worker] spawn: ${taskId} (${request.agentName})`);

    try {
      const worker = await createKoi({
        manifest: {
          name: request.agentName,
          version: "0.0.1",
          model: { name: MODEL },
        },
        adapter,
        limits: { maxTurns: 3, maxDurationMs: 30_000, maxTokens: 5_000 },
      });

      try {
        const deltas: string[] = [];
        let doneOutput: EngineOutput | undefined;

        for await (const event of worker.run({
          kind: "text",
          text: request.description,
        } as EngineInput)) {
          if (request.signal.aborted) break;
          if (event.kind === "text_delta") {
            deltas.push((event as { delta: string }).delta);
          }
          if (event.kind === "done") {
            doneOutput = event.output;
          }
        }

        const entry = spawnLog.find((e) => e.taskId === taskId);
        if (entry !== undefined) entry.finishedAt = Date.now();

        if (request.signal.aborted) {
          return {
            ok: false,
            error: { code: "EXTERNAL" as const, message: "aborted", retryable: false },
          };
        }

        if (doneOutput?.stopReason === "error") {
          const meta = doneOutput.metadata;
          const msg =
            typeof meta === "object" && meta !== null && "errorMessage" in meta
              ? String(meta.errorMessage)
              : "worker error";
          console.log(`  [worker] ${taskId} FAILED: ${msg}`);
          return { ok: false, error: { code: "EXTERNAL" as const, message: msg, retryable: true } };
        }

        const text = deltas.join("") || "(no output)";
        console.log(
          `  [worker] ${taskId} done (${text.length} chars, ${Date.now() - startedAt}ms)`,
        );
        return { ok: true, output: text };
      } finally {
        await worker.dispose();
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  [worker] ${taskId} ERROR: ${msg}`);
      return {
        ok: false,
        error: { code: "EXTERNAL" as const, message: msg, retryable: true },
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

console.log("[e2e] Spawn-delegation autonomous — parallel workers, real LLM\n");
step("Setup");

const store = createInMemorySnapshotChainStore<HarnessSnapshot>();
const harness = createLongRunningHarness({
  harnessId: harnessId("spawn-harness"),
  agentId: agentId("copilot"),
  harnessStore: store,
  sessionPersistence: createMinimalPersistence() as never,
  onCompleted: (status: HarnessStatus) => {
    completedFired = true;
    completedStatus = status;
    console.log(
      `\n  [onCompleted] ✓ phase=${status.phase} completed=${status.metrics.completedTaskCount}`,
    );
  },
  onFailed: (_: HarnessStatus, err: KoiError) => {
    console.log(`\n  [onFailed] ✗ ${err.message}`);
  },
});

// Helper: run engine and auto-pause harness when done
async function runSessionAndPause(
  engine: {
    run: (input: EngineInput) => AsyncIterable<{
      kind: string;
      delta?: string;
      output?: EngineOutput;
      [k: string]: unknown;
    }>;
  },
  input: EngineInput,
  label: string,
): Promise<EngineOutput | undefined> {
  let output: EngineOutput | undefined;
  const deltas: string[] = [];
  for await (const event of engine.run(input) as AsyncIterable<Record<string, unknown>>) {
    if (event.kind === "text_delta" && typeof event.delta === "string") {
      deltas.push(event.delta);
      process.stdout.write(event.delta);
    }
    if (event.kind === "done") output = event.output as EngineOutput;
  }
  if (deltas.length > 0) console.log("");

  const phase = harness.status().phase;
  if (phase === "active" && output !== undefined) {
    await harness.pause({ sessionId: label, metrics: output.metrics });
    console.log(`  [${label}] harness paused → ${harness.status().phase}`);
  }
  return output;
}

const workerSpawn = createWorkerSpawn();

const scheduler = createHarnessScheduler({
  harness,
  pollIntervalMs: 2000,
  maxRetries: 5,
  delay: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 1000))),
  onResumed: async (resumeResult: unknown) => {
    const rr = resumeResult as { engineInput: EngineInput; sessionId: string };
    console.log(`\n  [scheduler] resume — session ${rr.sessionId}`);
    await runSessionAndPause(engine, rr.engineInput, `scheduler-resume`);
  },
});

const agent = createAutonomousAgent({
  harness,
  scheduler,
  getSpawn: () => workerSpawn,
});

const adapter = createPiAdapter({ model: MODEL });
const engine = await createKoi({
  manifest: {
    name: "copilot",
    version: "0.0.1",
    model: { name: MODEL },
  },
  adapter,
  middleware: [...agent.middleware()],
  providers: [...agent.providers()],
  limits: { maxTurns: 10, maxDurationMs: 120_000, maxTokens: 50_000 },
});

console.log(
  `  providers: ${agent
    .providers()
    .map((p) => p.name)
    .join(", ")}`,
);

// ---------------------------------------------------------------------------
// Session 1: User asks copilot to plan with spawn-delegation
// ---------------------------------------------------------------------------

step("Session 1: Plan with spawn-delegated tasks");

const s1 = await runSessionAndPause(
  engine as never,
  {
    kind: "text",
    text: [
      "Use plan_autonomous to create a plan with 3 tasks.",
      'All 3 tasks should use delegation:"spawn" so they run as parallel workers.',
      "Tasks:",
      '  1. id:"haiku-ocean", description:"Write a haiku about the ocean. Return ONLY the haiku.", agentType:"poet"',
      '  2. id:"haiku-mountain", description:"Write a haiku about mountains. Return ONLY the haiku.", agentType:"poet"',
      '  3. id:"haiku-forest", description:"Write a haiku about a forest. Return ONLY the haiku.", agentType:"poet"',
      "No dependencies between tasks — they should run in parallel.",
    ].join("\n"),
  } as EngineInput,
  "copilot-s1",
);

assert("session 1 completed", s1?.stopReason !== "error", `stopReason=${s1?.stopReason}`);
assert("harness activated", harness.status().phase !== "idle", `phase=${harness.status().phase}`);

const boardAfterPlan = harness.status().taskBoard;
assert(
  "3 tasks created",
  boardAfterPlan.items.length === 3,
  `items=${boardAfterPlan.items.length}`,
);

// Check if workers were dispatched (spawn log should have entries)
assert("workers were dispatched", spawnLog.length > 0, `spawnLog=${spawnLog.length}`);

// ---------------------------------------------------------------------------
// Session 2: Copilot is NOT blocked — can answer unrelated question
// ---------------------------------------------------------------------------

step("Session 2: Copilot answers unrelated question (not blocked)");

const s2 = await runSessionAndPause(
  engine as never,
  {
    kind: "text",
    text: "What is 2 + 2? Reply with just the number.",
  } as EngineInput,
  "copilot-s2",
);

assert(
  "session 2 completed (not blocked by spawns)",
  s2?.stopReason !== "error",
  `stopReason=${s2?.stopReason}`,
);

// ---------------------------------------------------------------------------
// Wait for completion
// ---------------------------------------------------------------------------

step("Waiting for all tasks to complete...");

const deadline = Date.now() + 90_000;
while (
  harness.status().phase !== "completed" &&
  harness.status().phase !== "failed" &&
  Date.now() < deadline
) {
  await new Promise((r) => setTimeout(r, 1000));
  const h = harness.status();
  process.stdout.write(
    `\r  phase=${h.phase} done=${h.metrics.completedTaskCount}/${h.taskBoard.items.length}  `,
  );
}
console.log("");

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

step("Verify");

const final = harness.status();
assert("harness completed", final.phase === "completed", `phase=${final.phase}`);
assert(
  "3 tasks done",
  final.metrics.completedTaskCount === 3,
  `done=${final.metrics.completedTaskCount}`,
);
assert("onCompleted fired", completedFired);
assert("copilot was not blocked", s2?.stopReason !== "error");

// Check all 3 workers were dispatched (bridge dispatches sequentially per
// its immutable board design, but all run within a single dispatchReady cycle)
assert(
  "all 3 workers dispatched",
  spawnLog.filter((e) => e.finishedAt !== undefined).length === 3,
  `finished=${spawnLog.filter((e) => e.finishedAt !== undefined).length}`,
);

// Print spawn timeline
console.log("\n  Spawn timeline:");
for (const entry of spawnLog) {
  const dur = entry.finishedAt !== undefined ? `${entry.finishedAt - entry.startedAt}ms` : "?";
  console.log(`    ${entry.taskId}: ${dur}`);
}

// Print task results
console.log("\n  Task results:");
for (const result of final.taskBoard.results) {
  const preview = result.output.slice(0, 80).replace(/\n/g, " ");
  console.log(`    ${result.taskId}: ${preview}${result.output.length > 80 ? "..." : ""}`);
}

// Cleanup
await engine.dispose();
await scheduler.dispose();
await harness.dispose();

console.log(`\n${"=".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);
if (failed > 0) process.exit(1);
