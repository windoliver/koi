#!/usr/bin/env bun

/**
 * E2E: Copilot autonomous flow — same agent, multi-session, self-delegation.
 *
 * Real flow:
 *   Session 1: User asks copilot → copilot calls plan_autonomous → agent works
 *              tasks via task_complete in the SAME session → engine run ends →
 *              harness auto-pauses (active → suspended)
 *   Session 2: User asks unrelated question → copilot answers (not blocked)
 *   If tasks remain: Scheduler resumes → onResumed drives next engine run →
 *              agent continues → auto-pause → repeat
 *   All done: onCompleted fires → copilot notified
 *
 * Uses real LLM (OpenRouter).
 */

import { createPiAdapter } from "../packages/drivers/engine-pi/src/adapter.js";
import type {
  EngineInput,
  EngineOutput,
  HarnessSnapshot,
  HarnessStatus,
  KoiError,
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
let _completedStatus: HarnessStatus | undefined;
let schedulerResumeCount = 0;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

console.log("[e2e] Copilot autonomous — self-delegation, scheduler-driven sessions\n");
step("Setup");

const store = createInMemorySnapshotChainStore<HarnessSnapshot>();
const harness = createLongRunningHarness({
  harnessId: harnessId("copilot-harness"),
  agentId: agentId("copilot"),
  harnessStore: store,
  sessionPersistence: createMinimalPersistence() as never,
  onCompleted: (status: HarnessStatus) => {
    completedFired = true;
    _completedStatus = status;
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

  // Auto-pause: if harness is active after engine run, pause it
  const phase = harness.status().phase;
  if (phase === "active" && output !== undefined) {
    await harness.pause({ sessionId: label, metrics: output.metrics });
    console.log(`  [${label}] harness paused → ${harness.status().phase}`);
  }
  return output;
}

// Scheduler with onResumed that drives resumed sessions
const scheduler = createHarnessScheduler({
  harness,
  pollIntervalMs: 2000,
  maxRetries: 5,
  delay: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 1000))),
  onResumed: async (resumeResult: unknown) => {
    schedulerResumeCount++;
    const rr = resumeResult as { engineInput: EngineInput; sessionId: string };
    console.log(`\n  [scheduler] resume #${schedulerResumeCount} — session ${rr.sessionId}`);
    await runSessionAndPause(engine, rr.engineInput, `scheduler-${schedulerResumeCount}`);
  },
});

const agent = createAutonomousAgent({ harness, scheduler });

const adapter = createPiAdapter({ model: "openrouter:anthropic/claude-sonnet-4" });
const engine = await createKoi({
  manifest: {
    name: "copilot",
    version: "0.0.1",
    model: { name: "openrouter:anthropic/claude-sonnet-4" },
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
// Session 1: User asks copilot to plan + execute tasks
// ---------------------------------------------------------------------------

step("Session 1: User asks copilot to plan work");

const s1 = await runSessionAndPause(
  engine as never,
  {
    kind: "text",
    text: "Use plan_autonomous to create 2 tasks: (1) write a haiku about the ocean, (2) write a haiku about mountains. Then complete each task using task_complete with the haiku as output.",
  } as EngineInput,
  "copilot-s1",
);

assert("session 1 completed", s1?.stopReason !== "error", `stopReason=${s1?.stopReason}`);
assert("harness activated", harness.status().phase !== "idle", `phase=${harness.status().phase}`);

// ---------------------------------------------------------------------------
// Session 2: User asks unrelated question (not blocked)
// ---------------------------------------------------------------------------

step("Session 2: Copilot answers unrelated question");

// Reset engine for a fresh conversational turn
const s2 = await runSessionAndPause(
  engine as never,
  {
    kind: "text",
    text: "What is the capital of Japan?",
  } as EngineInput,
  "copilot-s2",
);

assert(
  "session 2 completed (not blocked)",
  s2?.stopReason !== "error",
  `stopReason=${s2?.stopReason}`,
);

// ---------------------------------------------------------------------------
// Wait for background completion
// ---------------------------------------------------------------------------

step("Waiting for tasks to complete...");

const deadline = Date.now() + 60_000;
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
  "2 tasks done",
  final.metrics.completedTaskCount === 2,
  `done=${final.metrics.completedTaskCount}`,
);
assert("onCompleted fired", completedFired);
assert("copilot was not blocked (session 2 worked)", s2?.stopReason !== "error");

// Cleanup
await engine.dispose();
await scheduler.dispose();
await harness.dispose();

console.log(`\n${"=".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);
if (failed > 0) process.exit(1);
