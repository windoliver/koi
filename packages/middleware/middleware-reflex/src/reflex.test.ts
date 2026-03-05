import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "@koi/core/message";
import type { ModelHandler, ModelRequest, ModelResponse, TurnContext } from "@koi/core/middleware";
import {
  createMockInboundMessage,
  createMockTurnContext,
  createSpyModelHandler,
} from "@koi/test-utils";
import type { ReflexMiddlewareConfig } from "./config.js";
import { createReflexMiddleware } from "./reflex.js";
import type { ReflexMetrics, ReflexRule } from "./types.js";

function isTextMatch(b: ContentBlock, pattern: RegExp): boolean {
  return b.kind === "text" && pattern.test(b.text);
}

function greetingRule(overrides?: Partial<ReflexRule>): ReflexRule {
  return {
    name: "greeting",
    match: (msg) => msg.content.some((b) => isTextMatch(b, /^(hi|hello)$/i)),
    respond: () => "Hello! How can I help?",
    ...overrides,
  };
}

function statusRule(overrides?: Partial<ReflexRule>): ReflexRule {
  return {
    name: "status",
    match: (msg) => msg.content.some((b) => isTextMatch(b, /^status$/i)),
    respond: () => "All systems operational.",
    priority: 200,
    ...overrides,
  };
}

function ctxWithMessage(text: string): TurnContext {
  const msg = createMockInboundMessage({ text });
  return createMockTurnContext({ messages: [msg] });
}

/**
 * Extracts the wrapModelCall hook from a middleware, throwing if absent.
 * Avoids non-null assertions (`!`) which Biome forbids.
 */
function getWrapModelCall(
  mw: ReturnType<typeof createReflexMiddleware>,
): (ctx: TurnContext, request: ModelRequest, next: ModelHandler) => Promise<ModelResponse> {
  const hook = mw.wrapModelCall;
  if (hook === undefined) throw new Error("wrapModelCall not defined");
  return hook;
}

const dummyRequest: ModelRequest = { messages: [], metadata: {} };

describe("createReflexMiddleware", () => {
  // --- Metadata ---

  test("has name 'koi:reflex'", () => {
    const mw = createReflexMiddleware({ rules: [greetingRule()] });
    expect(mw.name).toBe("koi:reflex");
  });

  test("has priority 50", () => {
    const mw = createReflexMiddleware({ rules: [greetingRule()] });
    expect(mw.priority).toBe(50);
  });

  test("has phase 'intercept'", () => {
    const mw = createReflexMiddleware({ rules: [greetingRule()] });
    expect(mw.phase).toBe("intercept");
  });

  test("describeCapabilities returns undefined", () => {
    const mw = createReflexMiddleware({ rules: [greetingRule()] });
    const ctx = createMockTurnContext();
    expect(mw.describeCapabilities(ctx)).toBeUndefined();
  });

  // --- Simple match ---

  test("returns reflex response when rule matches", async () => {
    const mw = createReflexMiddleware({ rules: [greetingRule()] });
    const wrap = getWrapModelCall(mw);
    const spy = createSpyModelHandler();
    const ctx = ctxWithMessage("hello");

    const result = await wrap(ctx, dummyRequest, spy.handler);

    expect(result.content).toBe("Hello! How can I help?");
    expect(result.model).toBe("koi:reflex");
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(result.metadata).toMatchObject({ reflexRule: "greeting", reflexHit: true });
    expect(spy.calls).toHaveLength(0);
  });

  // --- No match ---

  test("passes through to LLM when no rule matches", async () => {
    const mw = createReflexMiddleware({ rules: [greetingRule()] });
    const wrap = getWrapModelCall(mw);
    const spy = createSpyModelHandler();
    const ctx = ctxWithMessage("what is 2+2?");

    const result = await wrap(ctx, dummyRequest, spy.handler);

    expect(result.content).toBe("mock response");
    expect(spy.calls).toHaveLength(1);
  });

  // --- Priority ordering ---

  test("checks lower priority rule first", async () => {
    const lowPriority: ReflexRule = {
      name: "low",
      match: () => true,
      respond: () => "low wins",
      priority: 10,
    };
    const highPriority: ReflexRule = {
      name: "high",
      match: () => true,
      respond: () => "high wins",
      priority: 200,
    };

    // Pass in reverse order to prove sorting happens
    const mw = createReflexMiddleware({ rules: [highPriority, lowPriority] });
    const wrap = getWrapModelCall(mw);
    const spy = createSpyModelHandler();
    const ctx = ctxWithMessage("anything");

    const result = await wrap(ctx, dummyRequest, spy.handler);
    expect(result.content).toBe("low wins");
  });

  test("first matching rule wins when priorities are equal", async () => {
    const ruleA: ReflexRule = { name: "a", match: () => true, respond: () => "A" };
    const ruleB: ReflexRule = { name: "b", match: () => true, respond: () => "B" };

    const mw = createReflexMiddleware({ rules: [ruleA, ruleB] });
    const wrap = getWrapModelCall(mw);
    const spy = createSpyModelHandler();
    const ctx = ctxWithMessage("x");

    const result = await wrap(ctx, dummyRequest, spy.handler);
    expect(result.content).toBe("A");
  });

  // --- Cooldown ---

  test("skips rule on cooldown", async () => {
    // let: clock mutated between calls to simulate time progression
    let clock = 1000;
    const rule = greetingRule({ cooldownMs: 5000 });
    const mw = createReflexMiddleware({ rules: [rule], now: () => clock });
    const wrap = getWrapModelCall(mw);
    const spy = createSpyModelHandler();

    // First call: hits
    const ctx1 = ctxWithMessage("hello");
    const r1 = await wrap(ctx1, dummyRequest, spy.handler);
    expect(r1.model).toBe("koi:reflex");

    // Second call at +1s: on cooldown → passes through
    clock = 2000;
    const ctx2 = ctxWithMessage("hello");
    const r2 = await wrap(ctx2, dummyRequest, spy.handler);
    expect(r2.content).toBe("mock response");
    expect(spy.calls).toHaveLength(1);
  });

  test("rule fires again after cooldown expires", async () => {
    // let: clock mutated between calls to simulate time progression
    let clock = 1000;
    const rule = greetingRule({ cooldownMs: 5000 });
    const mw = createReflexMiddleware({ rules: [rule], now: () => clock });
    const wrap = getWrapModelCall(mw);
    const spy = createSpyModelHandler();

    // First call
    await wrap(ctxWithMessage("hello"), dummyRequest, spy.handler);

    // After cooldown
    clock = 7000;
    const result = await wrap(ctxWithMessage("hello"), dummyRequest, spy.handler);
    expect(result.model).toBe("koi:reflex");
    expect(spy.calls).toHaveLength(0);
  });

  test("cooldown rule skipped, lower-priority rule fires instead", async () => {
    // let: clock mutated between calls to simulate time progression
    let clock = 0;
    const primary: ReflexRule = {
      name: "primary",
      match: () => true,
      respond: () => "primary",
      priority: 10,
      cooldownMs: 5000,
    };
    const fallback: ReflexRule = {
      name: "fallback",
      match: () => true,
      respond: () => "fallback",
      priority: 20,
    };

    const mw = createReflexMiddleware({ rules: [primary, fallback], now: () => clock });
    const wrap = getWrapModelCall(mw);
    const spy = createSpyModelHandler();

    // First call: primary wins
    const r1 = await wrap(ctxWithMessage("x"), dummyRequest, spy.handler);
    expect(r1.content).toBe("primary");

    // Second call: primary on cooldown, fallback fires
    clock = 1000;
    const r2 = await wrap(ctxWithMessage("x"), dummyRequest, spy.handler);
    expect(r2.content).toBe("fallback");
  });

  // --- Disabled ---

  test("bypasses all rules when disabled", async () => {
    const mw = createReflexMiddleware({ rules: [greetingRule()], enabled: false });
    const wrap = getWrapModelCall(mw);
    const spy = createSpyModelHandler();
    const ctx = ctxWithMessage("hello");

    const result = await wrap(ctx, dummyRequest, spy.handler);
    expect(result.content).toBe("mock response");
    expect(spy.calls).toHaveLength(1);
  });

  // --- Empty messages ---

  test("passes through when no messages", async () => {
    const mw = createReflexMiddleware({ rules: [greetingRule()] });
    const wrap = getWrapModelCall(mw);
    const spy = createSpyModelHandler();
    const ctx = createMockTurnContext({ messages: [] });

    const result = await wrap(ctx, dummyRequest, spy.handler);
    expect(result.content).toBe("mock response");
  });

  // --- Metrics ---

  test("fires onMetrics with hit info", async () => {
    const metrics: ReflexMetrics[] = [];
    const mw = createReflexMiddleware({
      rules: [greetingRule()],
      now: () => 1000,
      onMetrics: (m) => metrics.push(m),
    });
    const wrap = getWrapModelCall(mw);
    const spy = createSpyModelHandler();
    const ctx = ctxWithMessage("hello");

    await wrap(ctx, dummyRequest, spy.handler);

    expect(metrics).toHaveLength(1);
    const m = metrics[0];
    expect(m).toBeDefined();
    expect(m?.kind).toBe("hit");
    expect(m?.ruleName).toBe("greeting");
    expect(m?.responseLength).toBe("Hello! How can I help?".length);
  });

  test("fires onMetrics with miss info", async () => {
    const metrics: ReflexMetrics[] = [];
    const mw = createReflexMiddleware({
      rules: [greetingRule()],
      now: () => 1000,
      onMetrics: (m) => metrics.push(m),
    });
    const wrap = getWrapModelCall(mw);
    const spy = createSpyModelHandler();
    const ctx = ctxWithMessage("unrelated");

    await wrap(ctx, dummyRequest, spy.handler);

    expect(metrics).toHaveLength(1);
    const m = metrics[0];
    expect(m).toBeDefined();
    expect(m?.kind).toBe("miss");
  });

  test("swallows onMetrics callback errors", async () => {
    const mw = createReflexMiddleware({
      rules: [greetingRule()],
      onMetrics: () => {
        throw new Error("boom");
      },
    });
    const wrap = getWrapModelCall(mw);
    const spy = createSpyModelHandler();
    const ctx = ctxWithMessage("hello");

    // Should not throw
    const result = await wrap(ctx, dummyRequest, spy.handler);
    expect(result.model).toBe("koi:reflex");
  });

  // --- Error handling ---

  test("skips rule when match throws", async () => {
    const bad: ReflexRule = {
      name: "bad",
      match: () => {
        throw new Error("match error");
      },
      respond: () => "never",
    };
    const fallback: ReflexRule = {
      name: "fallback",
      match: () => true,
      respond: () => "fallback",
    };

    const mw = createReflexMiddleware({ rules: [bad, fallback] });
    const wrap = getWrapModelCall(mw);
    const spy = createSpyModelHandler();
    const ctx = ctxWithMessage("x");

    const result = await wrap(ctx, dummyRequest, spy.handler);
    expect(result.content).toBe("fallback");
  });

  test("skips rule when respond throws, continues to next", async () => {
    const bad: ReflexRule = {
      name: "bad-respond",
      match: () => true,
      respond: () => {
        throw new Error("respond error");
      },
    };
    const fallback: ReflexRule = {
      name: "fallback",
      match: () => true,
      respond: () => "fallback",
    };

    const mw = createReflexMiddleware({ rules: [bad, fallback] });
    const wrap = getWrapModelCall(mw);
    const spy = createSpyModelHandler();
    const ctx = ctxWithMessage("x");

    const result = await wrap(ctx, dummyRequest, spy.handler);
    expect(result.content).toBe("fallback");
  });

  test("passes through when respond throws on only matching rule", async () => {
    const bad: ReflexRule = {
      name: "bad-respond",
      match: () => true,
      respond: () => {
        throw new Error("respond error");
      },
    };

    const mw = createReflexMiddleware({ rules: [bad] });
    const wrap = getWrapModelCall(mw);
    const spy = createSpyModelHandler();
    const ctx = ctxWithMessage("x");

    const result = await wrap(ctx, dummyRequest, spy.handler);
    expect(result.content).toBe("mock response");
    expect(spy.calls).toHaveLength(1);
  });

  // --- Session isolation ---

  test("cooldown state is per-middleware instance", async () => {
    const config: ReflexMiddlewareConfig = {
      rules: [greetingRule({ cooldownMs: 10_000 })],
      now: () => 0,
    };

    const mw1 = createReflexMiddleware(config);
    const mw2 = createReflexMiddleware(config);
    const wrap1 = getWrapModelCall(mw1);
    const wrap2 = getWrapModelCall(mw2);
    const spy = createSpyModelHandler();
    const ctx = ctxWithMessage("hello");

    // Fire mw1
    await wrap1(ctx, dummyRequest, spy.handler);

    // mw2 should still fire (separate cooldown state)
    const result = await wrap2(ctx, dummyRequest, spy.handler);
    expect(result.model).toBe("koi:reflex");
  });

  // --- Multiple rules, none match ---

  test("all miss passes through to LLM", async () => {
    const mw = createReflexMiddleware({ rules: [greetingRule(), statusRule()] });
    const wrap = getWrapModelCall(mw);
    const spy = createSpyModelHandler();
    const ctx = ctxWithMessage("something completely different");

    const result = await wrap(ctx, dummyRequest, spy.handler);
    expect(result.content).toBe("mock response");
    expect(spy.calls).toHaveLength(1);
  });
});
