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
    await novelty.recordSuccess(defaultPatternKey(t));
    await novelty.recordSuccess(defaultPatternKey(t));
    expect((await evaluateCompositionGate(args)).allowed).toBe(false);
    await novelty.recordSuccess(defaultPatternKey(t));
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
    await novelty.recordSuccess(defaultPatternKey(t));
    await novelty.recordSuccess(defaultPatternKey(t));
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
