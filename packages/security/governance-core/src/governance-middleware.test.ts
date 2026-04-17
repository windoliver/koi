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
    // Accounting is fire-and-forget post-call — let the microtask drain.
    await new Promise((resolve) => setTimeout(resolve, 5));
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
    const onViolation = mock(() => {});
    cfg.onViolation = onViolation;
    const mw = createGovernanceMiddleware(cfg);

    // Call 1: records 0.5 + 0.5 = 1.0 (cumulative = threshold). Post-call
    // advisory check passes (1.0 NOT > 1), no onViolation, call returns.
    await mw.wrapModelCall?.(ctx(), req(), async () => response(1_000_000, 1_000_000));
    await new Promise((resolve) => setTimeout(resolve, 5)); // drain fire-and-forget
    expect(onViolation).toHaveBeenCalledTimes(0);

    // Call 2: pre-gate passes (1.0 NOT > 1). Records another 1.0 → cumulative
    // 2.0. Post-call advisory fires onViolation (model response is still
    // returned — throwing here would discard valid work). Next call's
    // pre-gate is where enforcement lives.
    await mw.wrapModelCall?.(ctx(), req(), async () => response(1_000_000, 1_000_000));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(onViolation).toHaveBeenCalledTimes(1);

    // Call 3: pre-gate sees cumulative 2.0 > 1 → RATE_LIMIT (fail-closed at
    // next boundary, the documented enforcement point).
    let threw: unknown;
    try {
      await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1));
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
    // Calls 1-3: pre-gate passes (turns < 3 at entry). Post-record advisory
    // fires onViolation on call 3 (turns reaches 3), but the valid response
    // is still returned.
    for (let i = 0; i < 3; i++) {
      await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1));
    }
    // Call 4: pre-gate sees turns 3 >= 3 → RATE_LIMIT at the next boundary.
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

  test("wrapToolCall records tool_success on success", async () => {
    const recorded: unknown[] = [];
    const cfg = baseCfg({
      controller: {
        ...baseCfg().controller,
        record: (ev) => {
          recorded.push(ev);
        },
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    await mw.wrapToolCall?.(
      ctx(),
      { callId: "c1" as never, toolId: "t", input: {} } as never,
      async () => ({ callId: "c1", toolId: "t", result: "ok" }) as never,
    );
    expect(recorded).toContainEqual({ kind: "tool_success", toolName: "t" });
  });

  test("wrapToolCall records tool_error when next throws and rethrows", async () => {
    const recorded: unknown[] = [];
    const cfg = baseCfg({
      controller: {
        ...baseCfg().controller,
        record: (ev) => {
          recorded.push(ev);
        },
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    const boom = new Error("tool crashed");
    let threw: unknown;
    try {
      await mw.wrapToolCall?.(
        ctx(),
        { callId: "c1" as never, toolId: "t", input: {} } as never,
        async () => {
          throw boom;
        },
      );
    } catch (e) {
      threw = e;
    }
    expect(threw).toBe(boom);
    expect(recorded).toContainEqual({ kind: "tool_error", toolName: "t" });
  });

  test("error_rate setpoint eventually blocks after repeated tool failures", async () => {
    // Simulate the controller tracking tool_error events; after 3 errors
    // the setpoint flips the pre-gate to fail. Verifies tool outcomes drive
    // error_rate enforcement end-to-end.
    let errors = 0;
    const cfg = baseCfg({
      controller: {
        ...baseCfg().controller,
        checkAll: () =>
          errors >= 3
            ? { ok: false, variable: "error_rate", reason: "too many errors", retryable: true }
            : { ok: true },
        record: (ev) => {
          if (ev.kind === "tool_error") errors += 1;
        },
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    const failing = async () => {
      throw new Error("boom");
    };
    for (let i = 0; i < 3; i++) {
      try {
        await mw.wrapToolCall?.(
          ctx(),
          { callId: `c${i}` as never, toolId: "t", input: {} } as never,
          failing as never,
        );
      } catch {
        /* expected */
      }
    }
    let threw: unknown;
    try {
      await mw.wrapToolCall?.(
        ctx(),
        { callId: "c4" as never, toolId: "t", input: {} } as never,
        failing as never,
      );
    } catch (e) {
      threw = e;
    }
    expect((threw as Error & { code?: string }).code).toBe("RATE_LIMIT");
    expect((threw as Error & { context?: { variable?: string } }).context?.variable).toBe(
      "error_rate",
    );
  });

  test("wrapModelStream accumulates incremental usage chunks", async () => {
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
      yield { kind: "usage" as const, inputTokens: 10, outputTokens: 5 };
      yield { kind: "usage" as const, inputTokens: 20, outputTokens: 15 };
      // No done/error chunk — finally path must sum the deltas.
    }
    for await (const _ of mw.wrapModelStream?.(ctx(), req(), source) ?? []) {
      /* drain */
    }
    const tokenEvent = recorded.find((e) => (e as { kind: string }).kind === "token_usage") as
      | { inputTokens: number; outputTokens: number }
      | undefined;
    expect(tokenEvent).toBeDefined();
    expect(tokenEvent?.inputTokens).toBe(30);
    expect(tokenEvent?.outputTokens).toBe(20);
  });

  test("wrapModelStream honors authoritative usage from error chunk", async () => {
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
      yield { kind: "usage" as const, inputTokens: 5, outputTokens: 3 };
      yield {
        kind: "error" as const,
        message: "rate limited",
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    }
    for await (const _ of mw.wrapModelStream?.(ctx(), req(), source) ?? []) {
      /* drain */
    }
    const tokenEvent = recorded.find((e) => (e as { kind: string }).kind === "token_usage") as
      | { inputTokens: number; outputTokens: number }
      | undefined;
    // error.usage is authoritative: it represents the provider's final count,
    // which may differ from the sum of streamed deltas.
    expect(tokenEvent?.inputTokens).toBe(100);
    expect(tokenEvent?.outputTokens).toBe(50);
  });

  test("onAfterTurn fails closed when controller.record throws", async () => {
    // Turn recording moved from onBeforeTurn to onAfterTurn to fix an
    // off-by-one (`turnCount >= maxTurns` would trip on turn 1 for
    // maxTurns:1 if recorded pre-gate). Record-failure must still fail-closed.
    const boom = new Error("controller degraded");
    const cfg = baseCfg({
      controller: {
        ...baseCfg().controller,
        record: () => {
          throw boom;
        },
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    let threw: unknown;
    try {
      await mw.onAfterTurn?.(ctx());
    } catch (e) {
      threw = e;
    }
    expect((threw as Error & { code?: string }).code).toBe("PERMISSION");
    expect((threw as Error).cause).toBe(boom);
  });

  test("onBeforeTurn does NOT record turn event (prevents off-by-one)", async () => {
    // Recording a turn before gating would flip `turnCount >= maxTurns`
    // early. maxTurns:1 should allow exactly one completed turn, not zero.
    const recorded: unknown[] = [];
    const cfg = baseCfg({
      controller: {
        ...baseCfg().controller,
        record: (ev) => {
          recorded.push(ev);
        },
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    await mw.onBeforeTurn?.(ctx());
    expect(recorded.filter((e) => (e as { kind: string }).kind === "turn")).toHaveLength(0);
    await mw.onAfterTurn?.(ctx());
    expect(recorded.filter((e) => (e as { kind: string }).kind === "turn")).toHaveLength(1);
  });

  test("wrapToolCall returns real result when tool_success record throws (fires onViolation)", async () => {
    // Side effect already happened — returning PERMISSION would lie about
    // what executed and invite duplicate writes on retry. Degradation is
    // surfaced via onViolation so the host can poison future calls.
    const cfg = baseCfg({
      controller: {
        ...baseCfg().controller,
        record: (ev) => {
          if (ev.kind === "tool_success") throw new Error("recorder down");
        },
      },
    });
    const onViolation = mock(() => {});
    cfg.onViolation = onViolation;
    const mw = createGovernanceMiddleware(cfg);
    const expected = { callId: "c1", toolId: "t", result: "ok" };
    const got = await mw.wrapToolCall?.(
      ctx(),
      { callId: "c1" as never, toolId: "t", input: {} } as never,
      async () => expected as never,
    );
    expect(got).toBe(expected as never);
    expect(onViolation).toHaveBeenCalledTimes(1);
  });

  test("wrapModelStream does NOT discard done chunk when accounting fails", async () => {
    // Completed provider responses are authoritative: accounting failures
    // fire onViolation + warn but must not lose the terminal chunk. The
    // provider has already consumed tokens; dropping the chunk wastes real
    // spend and can cause double-billing on retry.
    const cfg = baseCfg({
      controller: {
        ...baseCfg().controller,
        record: (ev) => {
          if (ev.kind === "token_usage") throw new Error("recorder down");
        },
      },
    });
    const onViolation = mock(() => {});
    cfg.onViolation = onViolation;
    const mw = createGovernanceMiddleware(cfg);
    async function* source() {
      yield {
        kind: "done" as const,
        response: { content: "hi", model: "m", usage: { inputTokens: 10, outputTokens: 5 } },
      };
    }
    const out: unknown[] = [];
    for await (const c of mw.wrapModelStream?.(ctx(), req(), source) ?? []) out.push(c);
    expect(out).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(onViolation).toHaveBeenCalledTimes(1);
  });

  test("wrapToolCall rethrows real tool error when tool_error record throws", async () => {
    const toolErr = new Error("tool failed");
    const cfg = baseCfg({
      controller: {
        ...baseCfg().controller,
        record: (ev) => {
          if (ev.kind === "tool_error") throw new Error("recorder down");
        },
      },
    });
    const onViolation = mock(() => {});
    cfg.onViolation = onViolation;
    const mw = createGovernanceMiddleware(cfg);
    let threw: unknown;
    try {
      await mw.wrapToolCall?.(
        ctx(),
        { callId: "c1" as never, toolId: "t", input: {} } as never,
        async () => {
          throw toolErr;
        },
      );
    } catch (e) {
      threw = e;
    }
    // Caller sees the ORIGINAL tool failure — governance degradation is
    // signalled via onViolation, not by masking the real error.
    expect(threw).toBe(toolErr);
    expect(onViolation).toHaveBeenCalledTimes(1);
  });

  test("degraded latch denies next call after tool outcome record failure", async () => {
    // Latch-based fail-closed: even though the first tool call returns its
    // real result (record failed), the NEXT gate() must deny because the
    // controller reads are stale.
    let recordFail = true;
    const cfg = baseCfg({
      controller: {
        ...baseCfg().controller,
        record: (ev) => {
          if (recordFail && ev.kind === "tool_success") throw new Error("down");
        },
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    await mw.wrapToolCall?.(
      ctx(),
      { callId: "c1" as never, toolId: "t", input: {} } as never,
      async () => ({ callId: "c1", toolId: "t", result: "ok" }) as never,
    );
    // Recorder recovers but latch does not — enforcement must still deny.
    recordFail = false;
    let threw: unknown;
    try {
      await mw.wrapToolCall?.(
        ctx(),
        { callId: "c2" as never, toolId: "t", input: {} } as never,
        async () => ({ callId: "c2", toolId: "t", result: "ok" }) as never,
      );
    } catch (e) {
      threw = e;
    }
    expect((threw as Error & { code?: string }).code).toBe("PERMISSION");
    expect((threw as Error).message).toMatch(/degraded/i);
  });

  test("degraded latch denies next call after onAfterTurn record failure", async () => {
    // onAfterTurn throws, but host runtimes often swallow it via .catch(noop).
    // The internal latch must make the next gate() deny regardless.
    let recordFail = true;
    const cfg = baseCfg({
      controller: {
        ...baseCfg().controller,
        record: (ev) => {
          if (recordFail && ev.kind === "turn") throw new Error("down");
        },
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    // Host swallows the throw.
    await (mw.onAfterTurn?.(ctx()).catch(() => {}) ?? Promise.resolve());
    recordFail = false;
    let threw: unknown;
    try {
      await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1));
    } catch (e) {
      threw = e;
    }
    expect((threw as Error & { code?: string }).code).toBe("PERMISSION");
    expect((threw as Error).message).toMatch(/degraded/i);
  });

  test("accounting awaits before returning — no race with slow async controller", async () => {
    // Slow controller: record() resolves after a microtask. Before the fix,
    // recordModelUsageSoft was fire-and-forget → next call could gate on
    // stale state. After the fix, wrapModelCall awaits accounting.
    const recorded: unknown[] = [];
    let recordResolve: (() => void) | undefined;
    const recordInFlight = new Promise<void>((r) => {
      recordResolve = r;
    });
    const cfg = baseCfg({
      controller: {
        ...baseCfg().controller,
        record: (ev) => {
          recorded.push(ev);
          return recordInFlight;
        },
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    const callP = mw.wrapModelCall?.(ctx(), req(), async () => response(10, 5));
    // Give the inner await a chance to suspend on the record promise.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(recorded).toHaveLength(1); // record was invoked
    recordResolve?.();
    await callP;
    // Recording completed BEFORE the call returned.
  });

  test("recordModelUsage omits costUsd when cost.calculate throws (controller fallback pricing runs)", async () => {
    const recorded: unknown[] = [];
    const cfg = baseCfg({
      controller: {
        ...baseCfg().controller,
        record: (ev) => {
          recorded.push(ev);
        },
      },
      cost: {
        calculate: () => {
          throw new Error("unknown model price");
        },
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    await mw.wrapModelCall?.(ctx(), req(), async () => response(10, 5));
    const tokenEvent = recorded.find((e) => (e as { kind: string }).kind === "token_usage") as
      | { inputTokens: number; outputTokens: number; costUsd?: number }
      | undefined;
    expect(tokenEvent).toBeDefined();
    expect(tokenEvent?.inputTokens).toBe(10);
    expect(tokenEvent?.outputTokens).toBe(5);
    // costUsd omitted, not 0 — controller's per-token fallback pricing runs
    // instead of recording an authoritative zero that understates spend.
    expect(tokenEvent?.costUsd).toBeUndefined();
  });

  test("degraded latch persists across session boundaries (runtime-scoped containment)", async () => {
    // Session end does NOT clear the latch: cost/token/spawn counters
    // survive the session boundary, so if prior accounting failed those
    // counters remain stale. Clearing here would re-admit calls on the
    // next session against understated state.
    const cfg = baseCfg({
      controller: {
        ...baseCfg().controller,
        record: (ev) => {
          if (ev.kind === "tool_success") throw new Error("down");
        },
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    await mw.wrapToolCall?.(
      ctx(),
      { callId: "c1" as never, toolId: "t", input: {} } as never,
      async () => ({ callId: "c1", toolId: "t", result: "ok" }) as never,
    );
    // Session boundary fires.
    await mw.onSessionEnd?.({ sessionId: sessionId("s1") } as never);
    // Latch still blocks the next call.
    let threw: unknown;
    try {
      await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1));
    } catch (e) {
      threw = e;
    }
    expect((threw as Error & { code?: string }).code).toBe("PERMISSION");
    expect((threw as Error).message).toMatch(/degraded/i);
  });

  test("setpoint denies emit compliance records", async () => {
    const recordCompliance = mock((r: ComplianceRecord) => r);
    const cfg = baseCfg({
      backend: {
        evaluator: { evaluate: () => ({ ok: true }) },
        compliance: { recordCompliance },
      },
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
    try {
      await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1));
    } catch {
      /* expected */
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(recordCompliance).toHaveBeenCalledTimes(1);
    // Redaction: model_call payload contains model; compliance should
    // receive the synthesized denial with variable identifier.
    const arg = recordCompliance.mock.calls[0]?.[0];
    expect(arg?.verdict.ok).toBe(false);
  });
});
