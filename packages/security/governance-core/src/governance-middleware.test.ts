import { describe, expect, mock, test } from "bun:test";
import { agentId, sessionId } from "@koi/core";
import type { GovernanceController } from "@koi/core/governance";
import type {
  ComplianceRecord,
  GovernanceBackend,
  GovernanceVerdict,
} from "@koi/core/governance-backend";
import type { ModelRequest, ModelResponse, TurnContext } from "@koi/core/middleware";
import { createFlatRateCostCalculator } from "./cost-calculator.js";
import {
  createGovernanceMiddleware,
  GOVERNANCE_MIDDLEWARE_NAME,
  GOVERNANCE_MIDDLEWARE_PRIORITY,
} from "./governance-middleware.js";

function baseCfg(overrides: Partial<Parameters<typeof createGovernanceMiddleware>[0]> = {}) {
  const backend: GovernanceBackend = { evaluator: { evaluate: () => ({ ok: true }) } };
  const controller: GovernanceController = {
    check: () => ({ ok: true }),
    checkAll: () => ({ ok: true }),
    record: () => undefined,
    snapshot: () => ({ timestamp: 0, readings: [], healthy: true, violations: [] }),
    variables: () => new Map(),
    reading: () => undefined,
  };
  const cost = createFlatRateCostCalculator({ m: { inputUsdPer1M: 1, outputUsdPer1M: 1 } });
  return { backend, controller, cost, ...overrides };
}

describe("createGovernanceMiddleware — composition", () => {
  test("name is koi:governance-core", () => {
    expect(createGovernanceMiddleware(baseCfg()).name).toBe(GOVERNANCE_MIDDLEWARE_NAME);
    expect(GOVERNANCE_MIDDLEWARE_NAME).toBe("koi:governance-core");
  });

  test("priority is 150", () => {
    expect(createGovernanceMiddleware(baseCfg()).priority).toBe(150);
    expect(GOVERNANCE_MIDDLEWARE_PRIORITY).toBe(150);
  });

  test("exposes all expected hooks", () => {
    const mw = createGovernanceMiddleware(baseCfg());
    expect(typeof mw.wrapModelCall).toBe("function");
    expect(typeof mw.wrapModelStream).toBe("function");
    expect(typeof mw.wrapToolCall).toBe("function");
    expect(typeof mw.onBeforeTurn).toBe("function");
    expect(typeof mw.onSessionEnd).toBe("function");
    expect(typeof mw.describeCapabilities).toBe("function");
  });

  test("describeCapabilities returns label=governance", () => {
    const mw = createGovernanceMiddleware(baseCfg());
    const cap = mw.describeCapabilities({} as never);
    expect(cap?.label).toBe("governance");
  });
});

function ctx(): TurnContext {
  return {
    session: {
      sessionId: sessionId("s1"),
      agentId: agentId("a1"),
    },
  } as unknown as TurnContext;
}

function req(): ModelRequest {
  return { messages: [], model: "m" };
}

function response(input: number, output: number): ModelResponse {
  return {
    content: "ok",
    model: "m",
    usage: { inputTokens: input, outputTokens: output },
  };
}

describe("wrapModelCall — gate + record", () => {
  test("allow verdict → next called → cost recorded", async () => {
    const cfg = baseCfg();
    const recorded: unknown[] = [];
    cfg.controller = {
      ...cfg.controller,
      record: (ev: Parameters<typeof cfg.controller.record>[0]) => {
        recorded.push(ev);
      },
    };
    const mw = createGovernanceMiddleware(cfg);
    const next = mock(async () => response(100, 50));
    await mw.wrapModelCall?.(ctx(), req(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(recorded[0]).toMatchObject({
      kind: "token_usage",
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  test("deny verdict → throws POLICY_VIOLATION before next called", async () => {
    const cfg = baseCfg({
      backend: {
        evaluator: {
          evaluate: () => ({
            ok: false,
            violations: [{ rule: "no-deploy", severity: "critical", message: "blocked" }],
          }),
        },
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    const next = mock(async () => response(1, 1));
    let threw: unknown;
    try {
      await mw.wrapModelCall?.(ctx(), req(), next);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error & { code?: string }).code).toBe("PERMISSION");
    expect(next).toHaveBeenCalledTimes(0);
  });

  test("controller setpoint exceeded → throws RATE_LIMIT before next", async () => {
    const cfg = baseCfg({
      controller: {
        ...baseCfg().controller,
        checkAll: () => ({
          ok: false,
          variable: "cost_usd",
          reason: "over $1",
          retryable: false,
        }),
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    const next = mock(async () => response(1, 1));
    let threw: unknown;
    try {
      await mw.wrapModelCall?.(ctx(), req(), next);
    } catch (e) {
      threw = e;
    }
    expect((threw as Error & { code?: string }).code).toBe("RATE_LIMIT");
    expect(next).toHaveBeenCalledTimes(0);
  });

  test("onUsage fires after successful call", async () => {
    const cfg = baseCfg();
    const onUsage = mock(() => {});
    cfg.onUsage = onUsage;
    const mw = createGovernanceMiddleware(cfg);
    await mw.wrapModelCall?.(ctx(), req(), async () => response(100, 50));
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  test("onViolation fires before throw", async () => {
    const cfg = baseCfg({
      backend: {
        evaluator: {
          evaluate: () => ({
            ok: false,
            violations: [{ rule: "r", severity: "critical", message: "m" }],
          }),
        },
      },
    });
    const onViolation = mock(() => {});
    cfg.onViolation = onViolation;
    const mw = createGovernanceMiddleware(cfg);
    try {
      await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1));
    } catch {
      /* expected */
    }
    expect(onViolation).toHaveBeenCalledTimes(1);
  });

  test("compliance record emitted for allow decision", async () => {
    const recordCompliance = mock((r: ComplianceRecord) => r);
    const allowBackend: GovernanceBackend = {
      evaluator: { evaluate: () => ({ ok: true }) },
      compliance: { recordCompliance },
    };
    const cfg = baseCfg({ backend: allowBackend });
    const mw = createGovernanceMiddleware(cfg);
    await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1));
    // Best-effort async fire-and-forget — give microtask a chance to run
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(recordCompliance).toHaveBeenCalledTimes(1);
  });
});

describe("wrapModelStream", () => {
  test("gate runs before first yield; cost recorded on done chunk", async () => {
    const cfg = baseCfg();
    const recorded: unknown[] = [];
    cfg.controller = {
      ...cfg.controller,
      record: (ev) => {
        recorded.push(ev);
      },
    };
    const mw = createGovernanceMiddleware(cfg);

    async function* source() {
      yield { kind: "text_delta" as const, delta: "hi" };
      yield {
        kind: "done" as const,
        response: { content: "hi", model: "m", usage: { inputTokens: 10, outputTokens: 5 } },
      };
    }
    const out = [];
    for await (const c of mw.wrapModelStream?.(ctx(), req(), source) ?? []) out.push(c);
    expect(out.length).toBe(2);
    expect(recorded[0]).toMatchObject({ kind: "token_usage", inputTokens: 10, outputTokens: 5 });
  });

  test("deny verdict → throws before first yield", async () => {
    const cfg = baseCfg({
      backend: {
        evaluator: {
          evaluate: () => ({
            ok: false,
            violations: [{ rule: "r", severity: "critical", message: "m" }],
          }),
        },
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    async function* source() {
      yield { kind: "text_delta" as const, delta: "x" };
    }
    let threw: unknown;
    try {
      for await (const _ of mw.wrapModelStream?.(ctx(), req(), source) ?? []) {
        /* drain */
      }
    } catch (e) {
      threw = e;
    }
    expect((threw as Error & { code?: string }).code).toBe("PERMISSION");
  });

  test("no done chunk → no cost recorded", async () => {
    const cfg = baseCfg();
    const recorded: unknown[] = [];
    cfg.controller = {
      ...cfg.controller,
      record: (ev) => {
        recorded.push(ev);
      },
    };
    const mw = createGovernanceMiddleware(cfg);
    async function* source() {
      yield { kind: "text_delta" as const, delta: "x" };
    }
    for await (const _ of mw.wrapModelStream?.(ctx(), req(), source) ?? []) {
      /* drain */
    }
    expect(recorded).toHaveLength(0);
  });
});

describe("wrapToolCall", () => {
  test("allow verdict → next called", async () => {
    const cfg = baseCfg();
    const mw = createGovernanceMiddleware(cfg);
    const next = mock(async () => ({ callId: "c1" as never, toolId: "t", result: "ok" }) as never);
    await mw.wrapToolCall?.(
      ctx(),
      { callId: "c1" as never, toolId: "t", input: {} } as never,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("deny verdict → throws, next never called", async () => {
    const cfg = baseCfg({
      backend: {
        evaluator: {
          evaluate: () => ({
            ok: false,
            violations: [{ rule: "dangerous", severity: "critical", message: "no" }],
          }),
        },
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    const next = mock(async () => ({}) as never);
    let threw: unknown;
    try {
      await mw.wrapToolCall?.(
        ctx(),
        { callId: "c1" as never, toolId: "t", input: {} } as never,
        next,
      );
    } catch (e) {
      threw = e;
    }
    expect((threw as Error & { code?: string }).code).toBe("PERMISSION");
    expect(next).toHaveBeenCalledTimes(0);
  });

  test("evaluator scope=['tool_call'] → model_call bypasses evaluator", async () => {
    const evaluate = mock((): GovernanceVerdict => ({ ok: true }));
    const cfg = baseCfg({
      backend: {
        evaluator: { evaluate, scope: ["tool_call"] },
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1));
    expect(evaluate).toHaveBeenCalledTimes(0);
    await mw.wrapToolCall?.(
      ctx(),
      { callId: "c" as never, toolId: "t", input: {} } as never,
      async () => ({}) as never,
    );
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});

describe("fail-closed", () => {
  test("evaluator throws → PERMISSION with cause preserved", async () => {
    const boom = new Error("boom");
    const cfg = baseCfg({
      backend: {
        evaluator: {
          evaluate: () => {
            throw boom;
          },
        },
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    let threw: unknown;
    try {
      await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1));
    } catch (e) {
      threw = e;
    }
    expect((threw as Error & { code?: string }).code).toBe("PERMISSION");
    expect((threw as Error).cause).toBe(boom);
  });

  test("controller.checkAll throws → PERMISSION with cause", async () => {
    const boom = new Error("sensor broken");
    const cfg = baseCfg({
      controller: {
        ...baseCfg().controller,
        checkAll: () => {
          throw boom;
        },
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    let threw: unknown;
    try {
      await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1));
    } catch (e) {
      threw = e;
    }
    expect((threw as Error & { code?: string }).code).toBe("PERMISSION");
    expect((threw as Error).cause).toBe(boom);
  });

  test("compliance.recordCompliance rejects → gate still denies, no loop", async () => {
    const cfg = baseCfg({
      backend: {
        evaluator: {
          evaluate: () => ({
            ok: false,
            violations: [{ rule: "r", severity: "critical", message: "m" }],
          }),
        },
        compliance: { recordCompliance: () => Promise.reject(new Error("audit down")) },
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    let threw: unknown;
    try {
      await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1));
    } catch (e) {
      threw = e;
    }
    expect((threw as Error & { code?: string }).code).toBe("PERMISSION");
  });
});

describe("issue checklist", () => {
  test("spend limit enforced via cost_usd setpoint", async () => {
    let cumulative = 0;
    const baseCtrl = baseCfg().controller;
    const cfg = baseCfg({
      controller: {
        ...baseCtrl,
        checkAll: () =>
          cumulative > 1
            ? { ok: false, variable: "cost_usd", reason: "over $1", retryable: false }
            : { ok: true },
        record: (ev) => {
          if (ev.kind === "token_usage" && ev.costUsd !== undefined) cumulative += ev.costUsd;
        },
      },
      cost: createFlatRateCostCalculator({ m: { inputUsdPer1M: 0.5, outputUsdPer1M: 0.5 } }),
    });
    const mw = createGovernanceMiddleware(cfg);

    // Call 1: records 0.5 + 0.5 = 1.0 (cumulative 1.0, still at threshold);
    // post-call check sees 1.0 NOT > 1 so call succeeds.
    await mw.wrapModelCall?.(ctx(), req(), async () => response(1_000_000, 1_000_000));
    // Call 2: pre-gate passes (cumulative=1.0 not > 1). Records another 1.0 →
    // cumulative 2.0. Post-call check sees 2.0 > 1 → RATE_LIMIT (fail-fast
    // containment: the same call that overshoots is denied, not the next one).
    let threw: unknown;
    try {
      await mw.wrapModelCall?.(ctx(), req(), async () => response(1_000_000, 1_000_000));
    } catch (e) {
      threw = e;
    }
    expect((threw as Error & { code?: string }).code).toBe("RATE_LIMIT");
  });

  test("action budget decremented via turn_count setpoint", async () => {
    let turns = 0;
    const baseCtrl = baseCfg().controller;
    const cfg = baseCfg({
      controller: {
        ...baseCtrl,
        checkAll: () =>
          turns >= 3
            ? { ok: false, variable: "turn_count", reason: "3 turns max", retryable: false }
            : { ok: true },
        record: (ev) => {
          if (ev.kind === "token_usage") turns += 1;
        },
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    // Calls 1-2: pre-gate + post-check both pass (turns=1, then 2; both < 3)
    await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1));
    await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1));
    // Call 3: pre-gate passes (turns=2 not >= 3). Recording bumps turns to 3.
    // Post-call check sees 3 >= 3 → RATE_LIMIT.
    let threw: unknown;
    try {
      await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1));
    } catch (e) {
      threw = e;
    }
    expect((threw as Error & { code?: string }).code).toBe("RATE_LIMIT");
    expect((threw as Error & { context?: { variable?: string } }).context?.variable).toBe(
      "turn_count",
    );
  });

  test("policy evaluation deterministic", async () => {
    const evaluate = mock(() => ({ ok: true }) as GovernanceVerdict);
    const cfg = baseCfg({ backend: { evaluator: { evaluate } } });
    const mw = createGovernanceMiddleware(cfg);
    for (let i = 0; i < 100; i++) {
      await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1));
    }
    expect(evaluate).toHaveBeenCalledTimes(100);
  });
});
