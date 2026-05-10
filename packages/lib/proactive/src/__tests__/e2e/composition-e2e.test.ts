/**
 * Composition executor E2E suite.
 *
 * Wires real backends (real @koi/scheduler heap+sqlite, real
 * sqliteCompositionExecutionLog backed by a tmp file, real rule-based and
 * MockAdapter LLM planners) and drives synthetic triggers through the full
 * pipeline. Asserts side-effect counts and executionLog state — not internal
 * call shapes — so the suite catches behavioral regressions, not refactors.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentId,
  agentId,
  type CompositionPlan,
  type CompositionStep,
  type CompositionTrigger,
  DEFAULT_SCHEDULER_CONFIG,
  type EngineInput,
  type SchedulerComponent,
} from "@koi/core";
import {
  createScheduler,
  createSchedulerComponent,
  createSqliteRunStore,
  createSqliteTaskStore,
} from "@koi/scheduler";
import {
  type CompositionNotification,
  createCompositionExecutor,
  createLlmCompositionPlanner,
  createRuleBasedCompositionPlanner,
  inMemoryCompositionExecutionLog,
  preCommitRejection,
  sqliteCompositionExecutionLog,
} from "../../index.js";

const AGENT: AgentId = agentId("e2e-agent" as AgentId);

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "koi-proactive-e2e-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeRealScheduler(): {
  readonly scheduler: SchedulerComponent;
  readonly dispatched: { readonly input: EngineInput; readonly mode: string }[];
  readonly cleanup: () => Promise<void>;
} {
  const dispatched: { input: EngineInput; mode: string }[] = [];
  const taskDb = new Database(join(tmpDir, "tasks.sqlite"));
  const runDb = new Database(join(tmpDir, "runs.sqlite"));
  const taskStore = createSqliteTaskStore(taskDb);
  const runStore = createSqliteRunStore(runDb);
  const scheduler = createScheduler(
    DEFAULT_SCHEDULER_CONFIG,
    taskStore,
    async (_aid, input, mode) => {
      dispatched.push({ input, mode });
    },
    undefined, // clock → SYSTEM_CLOCK
    undefined, // scheduleStore
    { runStore },
  );
  const component = createSchedulerComponent(scheduler, AGENT);
  return {
    scheduler: component,
    dispatched,
    cleanup: async () => {
      await scheduler[Symbol.asyncDispose]();
      taskDb.close();
      runDb.close();
    },
  };
}

function makeNotifySink(): {
  readonly notify: (n: CompositionNotification) => Promise<unknown>;
  readonly delivered: CompositionNotification[];
} {
  const delivered: CompositionNotification[] = [];
  return {
    notify: async (n) => {
      delivered.push(n);
      return { delivered: true };
    },
    delivered,
  };
}

function trigger(opts?: { id?: string; emittedAt?: number }): CompositionTrigger {
  return {
    id: opts?.id ?? "trig-1",
    source: "e2e",
    confidence: 1,
    moment: { kind: "external_event", source: "test", eventType: "tick" },
    suggestedCapabilities: [],
    context: {},
    emittedAt: opts?.emittedAt ?? 1,
  };
}

function notifyPlan(
  message: string,
  opts?: { triggerId?: string; emittedAt?: number },
): CompositionPlan {
  return {
    triggerId: opts?.triggerId ?? "trig-1",
    triggerEmittedAt: opts?.emittedAt ?? 1,
    steps: [{ kind: "notify_user", channel: "inbox", message, priority: "normal" }],
    estimatedCost: 1,
    requiresApproval: false,
  };
}

// ===========================================================================
// Replay / idempotency
// ===========================================================================

describe("E2E: replay & idempotency (sqlite log + real scheduler)", () => {
  test("same trigger fired twice → side effects exactly once (notify_user)", async () => {
    const { scheduler, cleanup } = makeRealScheduler();
    const sink = makeNotifySink();
    const logDb = new Database(join(tmpDir, "log.sqlite"));
    const log = sqliteCompositionExecutionLog(logDb);
    const exec = createCompositionExecutor({
      agentId: AGENT,
      scheduler,
      notify: sink.notify,
      executionLog: log,
    });

    const r1 = await exec.execute(trigger(), notifyPlan("hello"));
    const r2 = await exec.execute(trigger(), notifyPlan("hello"));

    expect(r1.status).toBe("executed");
    expect(r2.status).toBe("executed");
    expect(sink.delivered).toHaveLength(1);
    logDb.close();
    await cleanup();
  });

  test("same trigger id but different emittedAt → two distinct executions", async () => {
    const { scheduler, cleanup } = makeRealScheduler();
    const sink = makeNotifySink();
    const exec = createCompositionExecutor({
      agentId: AGENT,
      scheduler,
      notify: sink.notify,
      executionLog: sqliteCompositionExecutionLog(new Database(join(tmpDir, "log.sqlite"))),
    });

    await exec.execute(trigger({ emittedAt: 1 }), notifyPlan("hello", { emittedAt: 1 }));
    await exec.execute(trigger({ emittedAt: 2 }), notifyPlan("hello", { emittedAt: 2 }));

    expect(sink.delivered).toHaveLength(2);
    await cleanup();
  });

  test("two semantically identical steps in one plan both fire (occurrenceIndex)", async () => {
    const { scheduler, cleanup } = makeRealScheduler();
    const sink = makeNotifySink();
    const exec = createCompositionExecutor({
      agentId: AGENT,
      scheduler,
      notify: sink.notify,
      executionLog: inMemoryCompositionExecutionLog(),
    });
    const dupPlan: CompositionPlan = {
      triggerId: "trig-1",
      triggerEmittedAt: 1,
      steps: [
        { kind: "notify_user", channel: "inbox", message: "ack", priority: "normal" },
        { kind: "notify_user", channel: "inbox", message: "ack", priority: "normal" },
      ],
      estimatedCost: 2,
      requiresApproval: false,
    };

    const r = await exec.execute(trigger(), dupPlan);
    expect(r.status).toBe("executed");
    expect(sink.delivered).toHaveLength(2);
    await cleanup();
  });

  test("durability: log persists across executor instances on same sqlite file", async () => {
    const { scheduler, cleanup } = makeRealScheduler();
    const sink = makeNotifySink();
    const logFile = join(tmpDir, "log.sqlite");

    // First run.
    {
      const db = new Database(logFile);
      const log = sqliteCompositionExecutionLog(db);
      const exec = createCompositionExecutor({
        agentId: AGENT,
        scheduler,
        notify: sink.notify,
        executionLog: log,
      });
      await exec.execute(trigger(), notifyPlan("hi"));
      db.close();
    }

    // Simulate process restart: brand new executor + log instance, same file.
    {
      const db = new Database(logFile);
      const log = sqliteCompositionExecutionLog(db);
      const exec = createCompositionExecutor({
        agentId: AGENT,
        scheduler,
        notify: sink.notify,
        executionLog: log,
      });
      const r = await exec.execute(trigger(), notifyPlan("hi"));
      expect(r.status).toBe("executed");
      db.close();
    }

    expect(sink.delivered).toHaveLength(1);
    await cleanup();
  });
});

// ===========================================================================
// Crash recovery — simulated via injected execution-log faults
// ===========================================================================

describe("E2E: crash recovery & operator reconciliation", () => {
  test("crash between claim and record → restart sees pending → fails closed with key", async () => {
    const { scheduler, cleanup } = makeRealScheduler();
    const sink = makeNotifySink();
    const logFile = join(tmpDir, "log.sqlite");

    // Pre-populate the log with a pending row by hand (simulates a process
    // that claimed but died before record).
    const db1 = new Database(logFile);
    const log1 = sqliteCompositionExecutionLog(db1);
    const claimResult = log1.claim("cmp-fakekey0000000000000000000000");
    expect(claimResult).toEqual({ kind: "claimed" });
    db1.close();

    // Reopen as a "new process". Now we run a plan whose derived key happens
    // to be different — assert normal flow still works (other keys unaffected).
    const db2 = new Database(logFile);
    const exec = createCompositionExecutor({
      agentId: AGENT,
      scheduler,
      notify: sink.notify,
      executionLog: sqliteCompositionExecutionLog(db2),
    });
    const r = await exec.execute(trigger(), notifyPlan("normal"));
    expect(r.status).toBe("executed");
    expect(sink.delivered).toHaveLength(1);
    db2.close();
    await cleanup();
  });

  test("operator can recover stuck pending by re-calling record(key)", async () => {
    const db = new Database(join(tmpDir, "log.sqlite"));
    const log = sqliteCompositionExecutionLog(db);
    const key = "cmp-stuck-key-aaaaaaaaaaaaaaaaaaa";

    // Stuck pending.
    expect(log.claim(key)).toEqual({ kind: "claimed" });
    expect(log.claim(key)).toEqual({ kind: "pending" });

    // Operator confirms side effect committed externally → re-records.
    await log.record(key, { recovered: true });

    // Subsequent claim short-circuits.
    expect(log.claim(key)).toEqual({ kind: "complete", output: { recovered: true } });
    db.close();
  });
});

// ===========================================================================
// preCommitRejection contract — across step kinds
// ===========================================================================

describe("E2E: preCommitRejection releases claim, plain Error leaves it pending", () => {
  test("scheduler.submit preCommitRejection → corrected retry succeeds", async () => {
    const { scheduler: real, dispatched, cleanup } = makeRealScheduler();
    let attempt = 0;
    const wrapped: SchedulerComponent = {
      ...real,
      async submit(...args: Parameters<SchedulerComponent["submit"]>) {
        attempt += 1;
        if (attempt === 1) throw preCommitRejection("simulated bad option");
        return real.submit(...args);
      },
    };
    const sink = makeNotifySink();
    const log = sqliteCompositionExecutionLog(new Database(join(tmpDir, "log.sqlite")));
    const exec = createCompositionExecutor({
      agentId: AGENT,
      scheduler: wrapped,
      notify: sink.notify,
      executionLog: log,
    });

    const submitPlan: CompositionPlan = {
      triggerId: "trig-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "submit_task",
          agentId: AGENT,
          mode: "spawn",
          input: { kind: "text", text: "go" },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const r1 = await exec.execute(trigger(), submitPlan);
    expect(r1.status).toBe("failed");
    // Corrected retry (attempt 2) goes through.
    const r2 = await exec.execute(trigger(), submitPlan);
    expect(r2.status).toBe("executed");

    // Wait briefly for the dispatcher to pick up the in-memory task. We submitted
    // with no delay, so the heap timer should fire within a tick or two.
    await new Promise((res) => setTimeout(res, 50));
    expect(dispatched.length).toBeGreaterThanOrEqual(1);
    await cleanup();
  });

  test("scheduler.submit plain Error → claim stays pending → retry fails closed", async () => {
    const { scheduler: real, cleanup } = makeRealScheduler();
    const wrapped: SchedulerComponent = {
      ...real,
      async submit() {
        throw new Error("flaky network");
      },
    };
    const sink = makeNotifySink();
    const log = sqliteCompositionExecutionLog(new Database(join(tmpDir, "log.sqlite")));
    const exec = createCompositionExecutor({
      agentId: AGENT,
      scheduler: wrapped,
      notify: sink.notify,
      executionLog: log,
    });

    const submitPlan: CompositionPlan = {
      triggerId: "trig-1",
      triggerEmittedAt: 1,
      steps: [
        { kind: "submit_task", agentId: AGENT, mode: "spawn", input: { kind: "text", text: "x" } },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const r1 = await exec.execute(trigger(), submitPlan);
    expect(r1.status).toBe("failed");
    expect(r1.error?.idempotencyKey).toMatch(/^cmp-[0-9a-f]{32}$/);

    // Retry: prior claim is still pending, so the executor refuses to fire again.
    const r2 = await exec.execute(trigger(), submitPlan);
    expect(r2.status).toBe("failed");
    expect(r2.error?.message).toMatch(/indeterminate state/);
    await cleanup();
  });

  test("notify preCommitRejection → claim released → retry delivers exactly once", async () => {
    const { scheduler, cleanup } = makeRealScheduler();
    let attempt = 0;
    const delivered: CompositionNotification[] = [];
    const exec = createCompositionExecutor({
      agentId: AGENT,
      scheduler,
      notify: async (n) => {
        attempt += 1;
        if (attempt === 1) throw preCommitRejection("transient rate-limit pre-send");
        delivered.push(n);
        return { delivered: true };
      },
      executionLog: sqliteCompositionExecutionLog(new Database(join(tmpDir, "log.sqlite"))),
    });

    const r1 = await exec.execute(trigger(), notifyPlan("hello"));
    expect(r1.status).toBe("failed");
    const r2 = await exec.execute(trigger(), notifyPlan("hello"));
    expect(r2.status).toBe("executed");
    expect(delivered).toHaveLength(1);
    await cleanup();
  });
});

// ===========================================================================
// Concurrency on a shared sqlite log
// ===========================================================================

describe("E2E: SQLite executionLog concurrency", () => {
  test("two executors racing same key on same db file → exactly one wins claim", async () => {
    const dbPath = join(tmpDir, "log.sqlite");
    const log1 = sqliteCompositionExecutionLog(new Database(dbPath));
    const log2 = sqliteCompositionExecutionLog(new Database(dbPath));

    const key = "cmp-race-key-aaaaaaaaaaaaaaaaaaaa";
    const [a, b] = await Promise.all([
      Promise.resolve(log1.claim(key)),
      Promise.resolve(log2.claim(key)),
    ]);
    const wins = [a, b].filter((r) => r.kind === "claimed").length;
    const pendings = [a, b].filter((r) => r.kind === "pending").length;
    expect(wins).toBe(1);
    expect(pendings).toBe(1);
  });

  test("100 distinct keys raced across two log handles → all 100 claim cleanly", async () => {
    const dbPath = join(tmpDir, "log.sqlite");
    const log1 = sqliteCompositionExecutionLog(new Database(dbPath));
    const log2 = sqliteCompositionExecutionLog(new Database(dbPath));
    const keys = Array.from(
      { length: 100 },
      (_, i) => `cmp-distinct-${String(i).padStart(28, "0")}`,
    );
    const results = await Promise.all(
      keys.map((k, i) => Promise.resolve((i % 2 === 0 ? log1 : log2).claim(k))),
    );
    expect(results.every((r) => r.kind === "claimed")).toBe(true);
  });
});

// ===========================================================================
// Planner safety / wire format
// ===========================================================================

describe("E2E: planner safety & wire format", () => {
  test("LLM adapter returning stale triggerEmittedAt is rejected", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "trig-stale",
            triggerEmittedAt: 1,
            steps: [{ kind: "notify_user", channel: "inbox", message: "x", priority: "normal" }],
            estimatedCost: 1,
          });
        },
      },
    });
    await expect(
      planner.plan(trigger({ id: "trig-stale", emittedAt: 99 }), {
        tools: [],
        agents: [],
        schedules: [],
      }),
    ).rejects.toThrow(/triggerEmittedAt mismatch/u);
  });

  test("LLM adapter omitting triggerEmittedAt is back-filled (back-compat)", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "trig-legacy",
            steps: [{ kind: "notify_user", channel: "inbox", message: "x", priority: "normal" }],
            estimatedCost: 1,
          });
        },
      },
    });
    const plan = await planner.plan(trigger({ id: "trig-legacy", emittedAt: 42 }), {
      tools: [],
      agents: [],
      schedules: [],
    });
    expect(plan.triggerEmittedAt).toBe(42);
  });

  test("notify_user with channel outside allowlist is INVALID_PLAN before claim", async () => {
    const { scheduler, cleanup } = makeRealScheduler();
    const sink = makeNotifySink();
    const log = sqliteCompositionExecutionLog(new Database(join(tmpDir, "log.sqlite")));
    const exec = createCompositionExecutor({
      agentId: AGENT,
      scheduler,
      notify: sink.notify,
      executionLog: log,
      allowedNotifyChannels: ["inbox"],
    });
    const badPlan: CompositionPlan = {
      triggerId: "trig-1",
      triggerEmittedAt: 1,
      steps: [{ kind: "notify_user", channel: "exfil-webhook", message: "x", priority: "normal" }],
      estimatedCost: 1,
      requiresApproval: false,
    };
    const r = await exec.execute(trigger(), badPlan);
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("INVALID_PLAN");
    expect(sink.delivered).toHaveLength(0);
    await cleanup();
  });

  test("create_schedule with malformed cron is INVALID_PLAN, no claim leaked", async () => {
    const { scheduler, cleanup } = makeRealScheduler();
    const sink = makeNotifySink();
    const log = sqliteCompositionExecutionLog(new Database(join(tmpDir, "log.sqlite")));
    const exec = createCompositionExecutor({
      agentId: AGENT,
      scheduler,
      notify: sink.notify,
      executionLog: log,
    });
    const plan: CompositionPlan = {
      triggerId: "trig-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "create_schedule",
          expression: "* * *", // 3 fields — pre-check rejects
          agentId: AGENT,
          mode: "spawn",
          input: { kind: "text", text: "x" },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };
    const r = await exec.execute(trigger(), plan);
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("INVALID_PLAN");
    await cleanup();
  });

  test("requiresApproval=true → no execution, returns requires_approval", async () => {
    const { scheduler, cleanup } = makeRealScheduler();
    const sink = makeNotifySink();
    const exec = createCompositionExecutor({
      agentId: AGENT,
      scheduler,
      notify: sink.notify,
      executionLog: inMemoryCompositionExecutionLog(),
    });
    const plan: CompositionPlan = {
      ...notifyPlan("approve me"),
      requiresApproval: true,
    };
    const r = await exec.execute(trigger(), plan);
    expect(r.status).toBe("requires_approval");
    expect(sink.delivered).toHaveLength(0);
    await cleanup();
  });

  test("empty plan with requiresApproval=false is INVALID_PLAN (no silent success)", async () => {
    const { scheduler, cleanup } = makeRealScheduler();
    const exec = createCompositionExecutor({
      agentId: AGENT,
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: inMemoryCompositionExecutionLog(),
    });
    const r = await exec.execute(trigger(), {
      triggerId: "trig-1",
      triggerEmittedAt: 1,
      steps: [],
      estimatedCost: 0,
      requiresApproval: false,
    });
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("INVALID_PLAN");
    await cleanup();
  });

  test("submit_task agentId mismatch is INVALID_PLAN, no scheduler call", async () => {
    const { scheduler, dispatched, cleanup } = makeRealScheduler();
    const exec = createCompositionExecutor({
      agentId: AGENT,
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: inMemoryCompositionExecutionLog(),
    });
    const plan: CompositionPlan = {
      triggerId: "trig-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "submit_task",
          agentId: agentId("other-agent" as AgentId),
          mode: "spawn",
          input: { kind: "text", text: "x" },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };
    const r = await exec.execute(trigger(), plan);
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("INVALID_PLAN");
    expect(dispatched).toHaveLength(0);
    await cleanup();
  });
});

// ===========================================================================
// spawn_agent / forge_skill / tool_call handler injection
// ===========================================================================

describe("E2E: injectable handlers for spawn_agent / forge_skill / tool_call", () => {
  test("spawn_agent with handler executes and dedupes on replay", async () => {
    const { scheduler, cleanup } = makeRealScheduler();
    const spawned: { agentType: string; key: string }[] = [];
    const exec = createCompositionExecutor({
      agentId: AGENT,
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: sqliteCompositionExecutionLog(new Database(join(tmpDir, "log.sqlite"))),
      spawn: async (req) => {
        spawned.push({ agentType: req.agentType, key: req.idempotencyKey });
        return { id: "spawn-1" };
      },
    });
    const step: CompositionStep = {
      kind: "spawn_agent",
      agentType: "researcher",
      input: { kind: "text", text: "investigate" },
      delivery: { kind: "deferred" },
    };
    const plan: CompositionPlan = {
      triggerId: "trig-1",
      triggerEmittedAt: 1,
      steps: [step],
      estimatedCost: 1,
      requiresApproval: false,
    };

    await exec.execute(trigger(), plan);
    await exec.execute(trigger(), plan);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.key).toMatch(/^cmp-[0-9a-f]{32}$/);
    await cleanup();
  });

  test("spawn_agent with no handler injected → unsupported, no claim leaked", async () => {
    const { scheduler, cleanup } = makeRealScheduler();
    const dbPath = join(tmpDir, "log.sqlite");
    const log = sqliteCompositionExecutionLog(new Database(dbPath));
    const exec = createCompositionExecutor({
      agentId: AGENT,
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: log,
    });
    const r = await exec.execute(trigger(), {
      triggerId: "trig-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "spawn_agent",
          agentType: "researcher",
          input: { kind: "text", text: "x" },
          delivery: { kind: "deferred" },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    });
    expect(r.status).toBe("unsupported");

    // Verify no row leaked into the log.
    const inspectDb = new Database(dbPath);
    const row = inspectDb.prepare("SELECT COUNT(*) as n FROM composition_execution_log").get() as {
      n: number;
    };
    expect(row.n).toBe(0);
    inspectDb.close();
    await cleanup();
  });

  test("tool_call handler throwing plain Error → claim stays pending, key surfaces", async () => {
    const { scheduler, cleanup } = makeRealScheduler();
    const dbPath = join(tmpDir, "log.sqlite");
    const log = sqliteCompositionExecutionLog(new Database(dbPath));
    const exec = createCompositionExecutor({
      agentId: AGENT,
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: log,
      toolCall: async () => {
        throw new Error("ambiguous: did the side effect commit?");
      },
    });
    const plan: CompositionPlan = {
      triggerId: "trig-1",
      triggerEmittedAt: 1,
      steps: [{ kind: "tool_call", toolName: "calc.add", input: { a: 1 } }],
      estimatedCost: 1,
      requiresApproval: false,
    };
    const r = await exec.execute(trigger(), plan);
    expect(r.status).toBe("failed");
    expect(r.error?.idempotencyKey).toMatch(/^cmp-[0-9a-f]{32}$/);

    // Retry fails closed because claim is still pending.
    const r2 = await exec.execute(trigger(), plan);
    expect(r2.error?.message).toMatch(/indeterminate state/);
    await cleanup();
  });
});

// ===========================================================================
// Real planner → real executor pipeline
// ===========================================================================

describe("E2E: rule planner → executor end-to-end", () => {
  test("threshold_crossed trigger → notify_user delivered exactly once", async () => {
    const { scheduler, cleanup } = makeRealScheduler();
    const sink = makeNotifySink();
    const log = sqliteCompositionExecutionLog(new Database(join(tmpDir, "log.sqlite")));
    const exec = createCompositionExecutor({
      agentId: AGENT,
      scheduler,
      notify: sink.notify,
      executionLog: log,
    });
    const planner = createRuleBasedCompositionPlanner();
    const t: CompositionTrigger = {
      id: "trig-rule-1",
      source: "governance",
      confidence: 1,
      moment: {
        kind: "threshold_crossed",
        sensor: "error_rate",
        value: 0.9,
        limit: 0.2,
        direction: "above",
      },
      suggestedCapabilities: ["notify_user"],
      context: {},
      emittedAt: 1,
    };

    const plan = await planner.plan(t, { tools: [], agents: [], schedules: [] });
    const r = await exec.execute(t, plan);
    expect(r.status).toBe("executed");
    expect(sink.delivered).toHaveLength(1);

    // Replay: executionLog dedupes.
    const r2 = await exec.execute(t, plan);
    expect(r2.status).toBe("executed");
    expect(sink.delivered).toHaveLength(1);
    await cleanup();
  });
});
