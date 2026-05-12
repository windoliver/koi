import { describe, expect, test } from "bun:test";
import type {
  AgentId,
  CompositionExecutionResult,
  CompositionGap,
  CompositionPlan,
  CompositionTrigger,
} from "@koi/core";
import {
  type CompositionExecutionLog,
  type CompositionExecutionStatus,
  type CompositionNotification,
  createCompositionExecutor,
  inMemoryCompositionExecutionLog,
} from "./composition-executor.js";
import {
  DEFAULT_COMPOSITION_GOVERNANCE,
  defaultPatternKey,
  evaluateCompositionGate,
  extractCapabilityGapsFromPlan,
  inferCompositionGap,
  inferMissingCapabilities,
  inMemoryNoveltyTracker,
  inMemorySessionRateTracker,
  type OutcomeRecorder,
} from "./composition-governance.js";

const aid: AgentId = "agent:test" as AgentId;

function trig(overrides: Partial<CompositionTrigger> = {}): CompositionTrigger {
  return {
    id: "trig-1",
    source: "test",
    confidence: 0.9,
    moment: { kind: "pattern_matched", patternId: "p1", description: "p" },
    suggestedCapabilities: [],
    context: {},
    emittedAt: 1000,
    ...overrides,
  };
}

function notifyPlan(overrides: Partial<CompositionPlan> = {}): CompositionPlan {
  return {
    triggerId: "trig-1",
    triggerEmittedAt: 1000,
    estimatedCost: 0.1,
    requiresApproval: false,
    steps: [{ kind: "notify_user", channel: "inbox", message: "hi", priority: "normal" }],
    ...overrides,
  };
}

const noopScheduler = {
  submit: async () => ({}),
  schedule: async () => ({}),
} as unknown as Parameters<typeof createCompositionExecutor>[0]["scheduler"];

function ctxBase(extra: Partial<Parameters<typeof createCompositionExecutor>[0]> = {}) {
  return {
    agentId: aid,
    scheduler: noopScheduler,
    notify: async (_: CompositionNotification) => ({ delivered: true }),
    executionLog: inMemoryCompositionExecutionLog(),
    ...extra,
  };
}

describe("evaluateCompositionGate (unit)", () => {
  test("denies when estimatedCost > maxCostPerComposition", async () => {
    const d = await evaluateCompositionGate({
      trigger: trig({ confidence: 1 }),
      plan: notifyPlan({ estimatedCost: 99 }),
      agentId: aid,
      governance: { maxCostPerComposition: 1 },
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toContain("99");
  });

  test("denies when trigger.confidence < threshold", async () => {
    const d = await evaluateCompositionGate({
      trigger: trig({ confidence: 0.1 }),
      plan: notifyPlan(),
      agentId: aid,
      governance: { autoApproveConfidenceThreshold: 0.85 },
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toMatch(/confidence/);
  });

  test("delegationCheck denies with reason list", async () => {
    const d = await evaluateCompositionGate({
      trigger: trig(),
      plan: notifyPlan(),
      agentId: aid,
      governance: {
        delegationCheck: () => ["scope:notify missing", "scope:schedule missing"],
      },
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toMatch(/scope:notify missing/);
  });

  test("delegationCheck === true permits", async () => {
    const d = await evaluateCompositionGate({
      trigger: trig(),
      plan: notifyPlan(),
      agentId: aid,
      governance: { delegationCheck: () => true },
    });
    expect(d.allowed).toBe(true);
  });

  test("session rate limit denies past max", async () => {
    const tracker = inMemorySessionRateTracker();
    for (let i = 0; i < 5; i += 1) await tracker.increment("s1");
    const d = await evaluateCompositionGate({
      trigger: trig(),
      plan: notifyPlan(),
      agentId: aid,
      governance: { maxCompositionsPerSession: 5 },
      sessionId: "s1",
      sessionRate: tracker,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toMatch(/maxCompositionsPerSession/);
  });

  test("novel pattern requires approval until success threshold reached", async () => {
    const novelty = inMemoryNoveltyTracker();
    const t = trig();
    const args = {
      trigger: t,
      plan: notifyPlan(),
      agentId: aid,
      governance: { novelPatternAutoApproveAfter: 3 },
      novelty,
    };
    expect((await evaluateCompositionGate(args)).allowed).toBe(false);
    await novelty.recordSuccess(defaultPatternKey(t, notifyPlan(), aid));
    await novelty.recordSuccess(defaultPatternKey(t, notifyPlan(), aid));
    expect((await evaluateCompositionGate(args)).allowed).toBe(false);
    await novelty.recordSuccess(defaultPatternKey(t, notifyPlan(), aid));
    expect((await evaluateCompositionGate(args)).allowed).toBe(true);
  });

  test("novelPatternRequiresApproval=false skips guard entirely", async () => {
    const novelty = inMemoryNoveltyTracker();
    const d = await evaluateCompositionGate({
      trigger: trig(),
      plan: notifyPlan(),
      agentId: aid,
      governance: { novelPatternRequiresApproval: false },
      novelty,
    });
    expect(d.allowed).toBe(true);
  });

  test("rate-limit skipped without sessionId or tracker", async () => {
    const d = await evaluateCompositionGate({
      trigger: trig(),
      plan: notifyPlan(),
      agentId: aid,
      governance: {
        maxCompositionsPerSession: 0,
        novelPatternRequiresApproval: false,
      },
    });
    expect(d.allowed).toBe(true);
  });

  test("default constants match design (5/0.85/1.0/true/3)", () => {
    expect(DEFAULT_COMPOSITION_GOVERNANCE.maxCompositionsPerSession).toBe(5);
    expect(DEFAULT_COMPOSITION_GOVERNANCE.autoApproveConfidenceThreshold).toBe(0.85);
    expect(DEFAULT_COMPOSITION_GOVERNANCE.maxCostPerComposition).toBe(1.0);
    expect(DEFAULT_COMPOSITION_GOVERNANCE.novelPatternRequiresApproval).toBe(true);
    expect(DEFAULT_COMPOSITION_GOVERNANCE.novelPatternAutoApproveAfter).toBe(3);
  });
});

describe("inferMissingCapabilities", () => {
  test("tool_call → tool:<name>", () => {
    expect(
      inferMissingCapabilities({ kind: "tool_call", toolName: "summarize", input: {} }),
    ).toEqual(["tool:summarize"]);
  });
  test("spawn_agent → agent:<type>", () => {
    expect(
      inferMissingCapabilities({
        kind: "spawn_agent",
        agentType: "researcher",
        input: { messages: [] } as never,
        delivery: "fire_and_forget" as never,
      }),
    ).toEqual(["agent:researcher"]);
  });
  test("notify_user → channel:<channel>", () => {
    expect(
      inferMissingCapabilities({
        kind: "notify_user",
        channel: "slack",
        message: "x",
        priority: "low",
      }),
    ).toEqual(["channel:slack"]);
  });
});

describe("extractCapabilityGapsFromPlan", () => {
  test("returns one gap per step whose required capability isn't wired", () => {
    const t = trig({ id: "t-extract", emittedAt: 5000 });
    const plan: CompositionPlan = {
      triggerId: "t-extract",
      triggerEmittedAt: 5000,
      estimatedCost: 0,
      requiresApproval: false,
      steps: [
        { kind: "tool_call", toolName: "summarize", input: {} },
        { kind: "tool_call", toolName: "ocr", input: {} }, // wired
        {
          kind: "spawn_agent",
          agentType: "researcher",
          input: {} as never,
          delivery: "fire_and_forget" as never,
        },
        { kind: "notify_user", channel: "inbox", message: "x", priority: "normal" }, // not a gap source
      ],
    };
    const gaps = extractCapabilityGapsFromPlan({
      trigger: t,
      plan,
      wiredCapabilities: { tools: ["ocr"], agents: [] },
      now: 6000,
    });
    expect(gaps).toHaveLength(2);
    expect(gaps.map((g) => g.missingCapabilities)).toEqual([
      ["tool:summarize"],
      ["agent:researcher"],
    ]);
    expect(gaps[0]?.firstSeen).toBe(6000);
  });

  test("returns empty when every step's capability is wired", () => {
    const gaps = extractCapabilityGapsFromPlan({
      trigger: trig(),
      plan: notifyPlan(),
      wiredCapabilities: {},
      now: 1,
    });
    expect(gaps).toEqual([]);
  });
});

describe("inferCompositionGap", () => {
  test("populates triggerId, moment, capability, timestamps", () => {
    const t = trig({ id: "trig-99", emittedAt: 5000 });
    const gap: CompositionGap = inferCompositionGap({
      trigger: t,
      step: { kind: "tool_call", toolName: "ocr", input: {} },
      now: 6000,
    });
    expect(gap.triggerId).toBe("trig-99");
    expect(gap.moment).toEqual(t.moment);
    expect(gap.missingCapabilities).toEqual(["tool:ocr"]);
    expect(gap.firstSeen).toBe(6000);
    expect(gap.lastSeen).toBe(6000);
    expect(gap.frequency).toBe(1);
  });
});

describe("createCompositionExecutor governance integration", () => {
  test("denies plan with low confidence → requires_approval with reason", async () => {
    const exec = createCompositionExecutor(
      ctxBase({
        governance: { autoApproveConfidenceThreshold: 0.9, novelPatternRequiresApproval: false },
      }),
    );
    const result = await exec.execute(trig({ confidence: 0.1 }), notifyPlan());
    expect(result.status).toBe("requires_approval");
    if (result.status === "requires_approval") {
      expect(result.error.message).toMatch(/confidence/);
    }
  });

  test("permits plan that passes all components", async () => {
    const exec = createCompositionExecutor(
      ctxBase({
        governance: {
          autoApproveConfidenceThreshold: 0.5,
          novelPatternRequiresApproval: false,
          maxCostPerComposition: 1,
        },
      }),
    );
    const result = await exec.execute(trig({ confidence: 0.9 }), notifyPlan());
    expect(result.status).toBe("executed");
  });

  test("session rate limit blocks after maxCompositionsPerSession", async () => {
    const sessionRate = inMemorySessionRateTracker();
    const exec = createCompositionExecutor(
      ctxBase({
        sessionId: "s-x",
        sessionRate,
        governance: {
          maxCompositionsPerSession: 2,
          novelPatternRequiresApproval: false,
          autoApproveConfidenceThreshold: 0,
        },
      }),
    );
    // 2 successful executions consume the budget
    for (let i = 0; i < 2; i += 1) {
      const r = await exec.execute(
        trig({ id: `t-${i}`, emittedAt: 1000 + i }),
        notifyPlan({ triggerId: `t-${i}`, triggerEmittedAt: 1000 + i }),
      );
      expect(r.status).toBe("executed");
    }
    const blocked = await exec.execute(
      trig({ id: "t-3", emittedAt: 1003 }),
      notifyPlan({ triggerId: "t-3", triggerEmittedAt: 1003 }),
    );
    expect(blocked.status).toBe("requires_approval");
    if (blocked.status === "requires_approval") {
      expect(blocked.error.message).toMatch(/maxCompositionsPerSession/);
    }
  });

  test("novelty tracker auto-approves after N successes", async () => {
    const novelty = inMemoryNoveltyTracker();
    const ctx = ctxBase({
      novelty,
      governance: {
        novelPatternRequiresApproval: true,
        novelPatternAutoApproveAfter: 2,
        autoApproveConfidenceThreshold: 0,
      },
    });
    const exec = createCompositionExecutor(ctx);

    // First call: novel → require approval
    const r1 = await exec.execute(trig({ id: "t1" }), notifyPlan({ triggerId: "t1" }));
    expect(r1.status).toBe("requires_approval");

    // Manually seed 2 prior successes to flip the gate
    const t = trig();
    await novelty.recordSuccess(defaultPatternKey(t, notifyPlan(), aid));
    await novelty.recordSuccess(defaultPatternKey(t, notifyPlan(), aid));
    const r2 = await exec.execute(t, notifyPlan());
    expect(r2.status).toBe("executed");
  });

  test("outcomeRecorder.record is called with the result on every execute()", async () => {
    const seen: CompositionExecutionResult[] = [];
    const recorder: OutcomeRecorder = {
      record: async (_t, _p, r) => {
        seen.push(r);
      },
    };
    const exec = createCompositionExecutor(ctxBase({ outcomeRecorder: recorder }));
    await exec.execute(trig(), notifyPlan());
    await exec.execute(trig({ id: "trig-2", emittedAt: 2000 }), {
      ...notifyPlan(),
      triggerId: "trig-2",
      triggerEmittedAt: 2000,
    });
    expect(seen.length).toBe(2);
    expect(seen[0]?.status).toBe("executed");
  });

  test("outcomeRecorder.recordGap fires when handler is missing for tool_call", async () => {
    const gaps: CompositionGap[] = [];
    const exec = createCompositionExecutor(
      ctxBase({
        outcomeRecorder: { recordGap: (g) => void gaps.push(g) },
        // No `toolCall` handler wired → step is unsupported.
      }),
    );
    const plan: CompositionPlan = {
      triggerId: "trig-1",
      triggerEmittedAt: 1000,
      estimatedCost: 0,
      requiresApproval: false,
      steps: [{ kind: "tool_call", toolName: "summarize", input: {} }],
    };
    const result = await exec.execute(trig(), plan);
    expect(result.status).toBe("unsupported");
    expect(gaps.length).toBe(1);
    expect(gaps[0]?.missingCapabilities).toEqual(["tool:summarize"]);
  });

  test("recorder failures are swallowed (do not break execute)", async () => {
    const exec = createCompositionExecutor(
      ctxBase({
        outcomeRecorder: {
          record: () => {
            throw new Error("recorder boom");
          },
          recordGap: () => {
            throw new Error("gap boom");
          },
        },
      }),
    );
    const r = await exec.execute(trig(), notifyPlan());
    expect(r.status).toBe("executed");
  });

  test("session counter increments only on successful execution", async () => {
    const sessionRate = inMemorySessionRateTracker();
    const exec = createCompositionExecutor(
      ctxBase({
        sessionId: "s-y",
        sessionRate,
        governance: { autoApproveConfidenceThreshold: 0.99, novelPatternRequiresApproval: false },
      }),
    );
    // Confidence 0.5 → denied, no increment
    await exec.execute(trig({ confidence: 0.5 }), notifyPlan());
    expect(await sessionRate.count("s-y")).toBe(0);
    // Confidence 1.0 → executed, increment
    await exec.execute(trig({ confidence: 1 }), notifyPlan());
    expect(await sessionRate.count("s-y")).toBe(1);
  });

  test("plan.requiresApproval=true short-circuits before governance", async () => {
    const seen: string[] = [];
    const exec = createCompositionExecutor(
      ctxBase({
        governance: {
          delegationCheck: () => {
            seen.push("delegation-check");
            return true;
          },
          autoApproveConfidenceThreshold: 0,
        },
      }),
    );
    const r = await exec.execute(trig(), notifyPlan({ requiresApproval: true }));
    expect(r.status).toBe("requires_approval");
    expect(seen).toEqual([]);
  });

  test("replay-only execution does not increment session rate or novelty", async () => {
    const sessionRate = inMemorySessionRateTracker();
    const novelty = inMemoryNoveltyTracker();
    const sharedLog = inMemoryCompositionExecutionLog();
    const exec = createCompositionExecutor(
      ctxBase({
        executionLog: sharedLog,
        sessionId: "s-replay",
        sessionRate,
        novelty,
        governance: {
          autoApproveConfidenceThreshold: 0,
          novelPatternRequiresApproval: false,
        },
      }),
    );
    // First execute commits new work → counters bump.
    const r1 = await exec.execute(trig(), notifyPlan());
    expect(r1.status).toBe("executed");
    expect(await sessionRate.count("s-replay")).toBe(1);
    expect(await novelty.successCount(defaultPatternKey(trig(), notifyPlan(), aid))).toBe(1);

    // Re-execute the same trigger+plan → executionLog short-circuits each
    // step, no fresh side effect committed → counters MUST NOT bump.
    const r2 = await exec.execute(trig(), notifyPlan());
    expect(r2.status).toBe("executed");
    expect(await sessionRate.count("s-replay")).toBe(1);
    expect(await novelty.successCount(defaultPatternKey(trig(), notifyPlan(), aid))).toBe(1);
  });

  test("approval-gated and governance-denied plans do NOT emit gaps (trust boundary)", async () => {
    const gaps: CompositionGap[] = [];
    const recorder = { recordGap: (g: CompositionGap) => void gaps.push(g) };
    // plan.requiresApproval=true → no execution attempt, no gap emission.
    const execA = createCompositionExecutor(ctxBase({ outcomeRecorder: recorder }));
    const planRequiresApproval: CompositionPlan = {
      triggerId: "trig-1",
      triggerEmittedAt: 1000,
      estimatedCost: 0,
      requiresApproval: true,
      steps: [{ kind: "tool_call", toolName: "summarize", input: {} }],
    };
    expect((await execA.execute(trig(), planRequiresApproval)).status).toBe("requires_approval");
    // Governance gate denies → no execution attempt, no gap emission.
    const execB = createCompositionExecutor(
      ctxBase({
        outcomeRecorder: recorder,
        governance: {
          autoApproveConfidenceThreshold: 0.99,
          novelPatternRequiresApproval: false,
        },
      }),
    );
    const planUnsupported: CompositionPlan = {
      triggerId: "trig-1",
      triggerEmittedAt: 1000,
      estimatedCost: 0,
      requiresApproval: false,
      steps: [
        {
          kind: "spawn_agent",
          agentType: "research",
          input: {} as never,
          delivery: "fire_and_forget" as never,
        },
      ],
    };
    expect((await execB.execute(trig({ confidence: 0.1 }), planUnsupported)).status).toBe(
      "requires_approval",
    );
    // No gap recorded for either denied plan — only real execution attempts
    // can mutate the capability-gap feedback pipeline.
    expect(gaps).toHaveLength(0);
  });

  test("concurrent execute() calls cannot oversubscribe maxCompositionsPerSession", async () => {
    const sessionRate = inMemorySessionRateTracker();
    const exec = createCompositionExecutor(
      ctxBase({
        sessionId: "concurrent-s",
        sessionRate,
        governance: {
          maxCompositionsPerSession: 3,
          autoApproveConfidenceThreshold: 0,
          novelPatternRequiresApproval: false,
        },
      }),
    );
    // Fire 10 concurrent execute() calls with distinct triggers; only 3
    // should pass governance — the rest get requires_approval.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        exec.execute(
          trig({ id: `t-${i}`, emittedAt: 1000 + i }),
          notifyPlan({ triggerId: `t-${i}`, triggerEmittedAt: 1000 + i }),
        ),
      ),
    );
    const executed = results.filter((r) => r.status === "executed").length;
    const denied = results.filter((r) => r.status === "requires_approval").length;
    expect(executed).toBe(3);
    expect(denied).toBe(7);
    expect(await sessionRate.count("concurrent-s")).toBe(3);
  });

  test("default novelty key distinguishes plans with the same step kinds but different payloads", () => {
    const t = trig();
    const planA = notifyPlan({
      steps: [{ kind: "notify_user", channel: "inbox", message: "alpha", priority: "normal" }],
    });
    const planB = notifyPlan({
      steps: [{ kind: "notify_user", channel: "inbox", message: "beta", priority: "normal" }],
    });
    const keyA = defaultPatternKey(t, planA);
    const keyB = defaultPatternKey(t, planB);
    expect(keyA).not.toBe(keyB);
  });

  // Note: tryAcquire and release are now both required at the type level
  // (SessionRateTracker interface). Trackers missing either field fail
  // TypeScript compilation, so the previous "fails closed at gate"
  // runtime test is no longer reachable from typed code.

  test("default novelty key includes moment-specific discriminators", () => {
    expect(
      defaultPatternKey(
        trig({
          moment: {
            kind: "threshold_crossed",
            sensor: "errors",
            value: 1,
            limit: 0,
            direction: "above",
          },
        }),
      ),
    ).toBe("*|test|threshold_crossed|errors|above|0");
    // Different sensor on same moment kind → different bucket.
    expect(
      defaultPatternKey(
        trig({
          moment: {
            kind: "threshold_crossed",
            sensor: "latency",
            value: 1,
            limit: 0,
            direction: "above",
          },
        }),
      ),
    ).not.toBe(
      defaultPatternKey(
        trig({
          moment: {
            kind: "threshold_crossed",
            sensor: "errors",
            value: 1,
            limit: 0,
            direction: "above",
          },
        }),
      ),
    );
    expect(
      defaultPatternKey(
        trig({ moment: { kind: "task_terminal", taskId: "tk" as never, outcome: "completed" } }),
      ),
    ).toBe("*|test|task_terminal|completed");
  });

  test("warning and critical bands on the same sensor get distinct novelty keys", () => {
    const warning = defaultPatternKey(
      trig({
        moment: {
          kind: "threshold_crossed",
          sensor: "error_rate",
          value: 0.4,
          limit: 0.3,
          direction: "above",
        },
      }),
    );
    const critical = defaultPatternKey(
      trig({
        moment: {
          kind: "threshold_crossed",
          sensor: "error_rate",
          value: 0.4,
          limit: 0.9,
          direction: "above",
        },
      }),
    );
    expect(warning).not.toBe(critical);
  });

  test("partial commit (notify_user then unsupported step) still consumes session + novelty budget", async () => {
    const sessionRate = inMemorySessionRateTracker();
    const novelty = inMemoryNoveltyTracker();
    const exec = createCompositionExecutor(
      ctxBase({
        sessionId: "partial-s",
        sessionRate,
        novelty,
        governance: {
          maxCompositionsPerSession: 5,
          autoApproveConfidenceThreshold: 0,
          novelPatternRequiresApproval: false,
        },
      }),
    );
    const plan: CompositionPlan = {
      triggerId: "trig-1",
      triggerEmittedAt: 1000,
      estimatedCost: 0,
      requiresApproval: false,
      steps: [
        { kind: "notify_user", channel: "inbox", message: "hi", priority: "normal" },
        // tool_call with no handler → unsupported (later step fails)
        { kind: "tool_call", toolName: "missing", input: {} },
      ],
    };
    const result = await exec.execute(trig(), plan);
    expect(result.status).toBe("unsupported");
    // Session rate: a fresh side effect (notify_user) committed —
    // governance MUST consume budget so a buggy plan can't repeatedly
    // send notifications without ever hitting the cap.
    expect(await sessionRate.count("partial-s")).toBe(1);
    // Novelty: stricter — a partial run does NOT validate the pattern
    // for auto-approval. Only fully successful executions bump novelty
    // credit so unsupported plans can't age into auto-approval.
    expect(await novelty.successCount(defaultPatternKey(trig(), plan, aid))).toBe(0);
  });

  test("governance backend throw converts to failed result and releases acquired slot", async () => {
    const sessionRate = inMemorySessionRateTracker();
    const exec = createCompositionExecutor(
      ctxBase({
        sessionId: "throw-s",
        sessionRate,
        novelty: {
          successCount: () => {
            throw new Error("backend down");
          },
          recordSuccess: () => {},
        },
        governance: {
          maxCompositionsPerSession: 5,
          autoApproveConfidenceThreshold: 0,
          novelPatternRequiresApproval: true,
          novelPatternAutoApproveAfter: 99,
        },
      }),
    );
    // tryAcquire happens first and consumes a slot (count goes to 1).
    // Then novelty.successCount throws → execute() must return a
    // structured failed result AND release the slot back to 0.
    const result = await exec.execute(trig(), notifyPlan());
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.message).toMatch(/governance evaluation threw/);
    }
    // The slot acquired pre-throw was released.
    expect(await sessionRate.count("throw-s")).toBe(0);
  });

  test("post-commit executionLog.record failure does NOT refund the session slot", async () => {
    const sessionRate = inMemorySessionRateTracker();
    const log = {
      claim: () => ({ kind: "claimed" as const }),
      record: () => {
        throw new Error("log backend down");
      },
      release: () => {},
    };
    const exec = createCompositionExecutor(
      ctxBase({
        executionLog: log,
        sessionId: "post-commit-s",
        sessionRate,
        governance: {
          maxCompositionsPerSession: 1,
          autoApproveConfidenceThreshold: 0,
          novelPatternRequiresApproval: false,
        },
      }),
    );
    const result = await exec.execute(trig(), notifyPlan());
    expect(result.status).toBe("failed");
    // Side effect (notify_user) committed before record() threw — the
    // session slot must remain consumed so that another execute() does
    // not happily send a second notification under the same cap.
    expect(await sessionRate.count("post-commit-s")).toBe(1);
  });

  test("allowedToolNames rejects out-of-allowlist tool_call before claim", async () => {
    let toolCalled = false;
    const exec = createCompositionExecutor(
      ctxBase({
        toolCall: async () => {
          toolCalled = true;
          return {};
        },
        allowedToolNames: ["safe-tool"],
      }),
    );
    const plan: CompositionPlan = {
      triggerId: "trig-1",
      triggerEmittedAt: 1000,
      estimatedCost: 0,
      requiresApproval: false,
      steps: [{ kind: "tool_call", toolName: "dangerous-tool", input: {} }],
    };
    const r = await exec.execute(trig(), plan);
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.error.code).toBe("INVALID_PLAN");
      expect(r.error.message).toMatch(/dangerous-tool/);
    }
    expect(toolCalled).toBe(false);
  });

  test("novelty key includes agentId — different agents do NOT share approval credit", () => {
    const t = trig();
    const p = notifyPlan();
    const k1 = defaultPatternKey(t, p, "agent:a" as AgentId);
    const k2 = defaultPatternKey(t, p, "agent:b" as AgentId);
    expect(k1).not.toBe(k2);
    expect(k1.startsWith("agent:a|")).toBe(true);
    expect(k2.startsWith("agent:b|")).toBe(true);
  });

  test("confidence exactly at threshold is allowed (>= boundary)", async () => {
    const d = await evaluateCompositionGate({
      trigger: trig({ confidence: 0.85 }),
      plan: notifyPlan(),
      agentId: aid,
      governance: {
        autoApproveConfidenceThreshold: 0.85,
        novelPatternRequiresApproval: false,
      },
    });
    expect(d.allowed).toBe(true);
  });

  test("estimatedCost exactly at cap is allowed (<= boundary)", async () => {
    const d = await evaluateCompositionGate({
      trigger: trig(),
      plan: notifyPlan({ estimatedCost: 1.0 }),
      agentId: aid,
      governance: {
        maxCostPerComposition: 1.0,
        autoApproveConfidenceThreshold: 0,
        novelPatternRequiresApproval: false,
      },
    });
    expect(d.allowed).toBe(true);
  });

  test("plan with 0 steps is rejected as INVALID_PLAN and consumes no counters", async () => {
    const sessionRate = inMemorySessionRateTracker();
    const novelty = inMemoryNoveltyTracker();
    const exec = createCompositionExecutor(
      ctxBase({
        sessionId: "empty-s",
        sessionRate,
        novelty,
        governance: {
          autoApproveConfidenceThreshold: 0,
          novelPatternRequiresApproval: false,
        },
      }),
    );
    const empty: CompositionPlan = {
      triggerId: "trig-1",
      triggerEmittedAt: 1000,
      estimatedCost: 0,
      requiresApproval: false,
      steps: [],
    };
    const r = await exec.execute(trig(), empty);
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.error.code).toBe("INVALID_PLAN");
      expect(r.error.message).toMatch(/zero steps/);
    }
    // Refusal is pre-claim → no budget consumed.
    expect(await sessionRate.count("empty-s")).toBe(0);
    expect(await novelty.successCount(defaultPatternKey(trig(), empty, aid))).toBe(0);
  });

  test("allowedToolNames=[] rejects every tool_call (empty allowlist denies all)", async () => {
    let toolCalled = false;
    const exec = createCompositionExecutor(
      ctxBase({
        toolCall: async () => {
          toolCalled = true;
          return {};
        },
        allowedToolNames: [],
      }),
    );
    const plan: CompositionPlan = {
      triggerId: "trig-1",
      triggerEmittedAt: 1000,
      estimatedCost: 0,
      requiresApproval: false,
      steps: [{ kind: "tool_call", toolName: "anything", input: {} }],
    };
    const r = await exec.execute(trig(), plan);
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.error.code).toBe("INVALID_PLAN");
    expect(toolCalled).toBe(false);
  });

  test("allowedAgentTypes=[] rejects every spawn_agent (empty allowlist denies all)", async () => {
    let spawned = false;
    const exec = createCompositionExecutor(
      ctxBase({
        spawn: async () => {
          spawned = true;
          return {};
        },
        allowedAgentTypes: [],
      }),
    );
    const plan: CompositionPlan = {
      triggerId: "trig-1",
      triggerEmittedAt: 1000,
      estimatedCost: 0,
      requiresApproval: false,
      steps: [
        {
          kind: "spawn_agent",
          agentType: "researcher",
          input: {} as never,
          delivery: "fire_and_forget" as never,
        },
      ],
    };
    const r = await exec.execute(trig(), plan);
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.error.code).toBe("INVALID_PLAN");
    expect(spawned).toBe(false);
  });

  test("novelty key is order-sensitive: reordered steps hash differently", () => {
    const t = trig();
    const stepA = {
      kind: "notify_user" as const,
      channel: "inbox",
      message: "a",
      priority: "normal" as const,
    };
    const stepB = {
      kind: "notify_user" as const,
      channel: "inbox",
      message: "b",
      priority: "normal" as const,
    };
    const planAB = notifyPlan({ steps: [stepA, stepB] });
    const planBA = notifyPlan({ steps: [stepB, stepA] });
    expect(defaultPatternKey(t, planAB, aid)).not.toBe(defaultPatternKey(t, planBA, aid));
  });

  test("ambiguous executionLog handler short-circuits when claim returns 'pending'", async () => {
    const log: CompositionExecutionLog = {
      claim: (): CompositionExecutionStatus => ({ kind: "pending" }),
      record: () => {},
      release: () => {},
    };
    const exec = createCompositionExecutor(ctxBase({ executionLog: log }));
    const r = await exec.execute(trig(), notifyPlan());
    expect(r.status).toBe("failed");
  });
});
