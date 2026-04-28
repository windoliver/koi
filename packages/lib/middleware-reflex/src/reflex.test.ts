import { describe, expect, test } from "bun:test";
import type {
  ContentBlock,
  InboundMessage,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  TurnContext,
} from "@koi/core";

import { createReflexMiddleware, textOf } from "./reflex.js";
import type { ReflexRule } from "./types.js";

function callModel(
  mw: KoiMiddleware,
  ctx: TurnContext,
  request: ModelRequest,
  next: ModelHandler,
): Promise<ModelResponse> {
  if (mw.wrapModelCall === undefined) {
    throw new Error("middleware has no wrapModelCall");
  }
  return mw.wrapModelCall(ctx, request, next);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMessage(text: string, content?: readonly ContentBlock[]): InboundMessage {
  return {
    senderId: "user:1",
    timestamp: 0,
    content: content ?? [{ kind: "text", text }],
  };
}

function makeCtx(messages: readonly InboundMessage[]): TurnContext {
  return {
    session: {
      agentId: "test",
      sessionId: "s1" as never,
      runId: "r1" as never,
      metadata: {},
    },
    turnIndex: 0,
    turnId: "t1" as never,
    messages,
    metadata: {},
  };
}

function makeRequest(extras?: Partial<ModelRequest>): ModelRequest {
  return { messages: [], ...extras };
}

const passthroughResponse: ModelResponse = { content: "from-llm", model: "test-model" };

function passthrough(): { handler: ModelHandler; called: () => boolean } {
  let calls = 0;
  const handler: ModelHandler = async (_req) => {
    calls += 1;
    return passthroughResponse;
  };
  return { handler, called: () => calls > 0 };
}

const helloRule: ReflexRule = {
  name: "hello",
  match: (m) => /^hello$/i.test(textOf(m)),
  respond: () => "Hi!",
};

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe("createReflexMiddleware shape", () => {
  const mw = createReflexMiddleware({ rules: [helloRule] });

  test("name is 'koi:reflex'", () => {
    expect(mw.name).toBe("koi:reflex");
  });
  test("priority is 50", () => {
    expect(mw.priority).toBe(50);
  });
  test("phase is 'intercept'", () => {
    expect(mw.phase).toBe("intercept");
  });
  test("describeCapabilities returns undefined", () => {
    expect(mw.describeCapabilities(makeCtx([]))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Match / miss
// ---------------------------------------------------------------------------

describe("rule evaluation", () => {
  test("returns reflex response when rule matches", async () => {
    const mw = createReflexMiddleware({ rules: [helloRule] });
    const { handler, called } = passthrough();
    const ctx = makeCtx([makeMessage("hello")]);

    const res = await callModel(mw, ctx, makeRequest(), handler);

    expect(res.content).toBe("Hi!");
    expect(res.model).toBe("koi:reflex");
    expect(res.stopReason).toBe("stop");
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(res.metadata).toEqual({ reflexRule: "hello", reflexHit: true });
    expect(called()).toBe(false);
  });

  test("passes through when no rule matches", async () => {
    const mw = createReflexMiddleware({ rules: [helloRule] });
    const { handler, called } = passthrough();
    const ctx = makeCtx([makeMessage("goodbye")]);

    const res = await callModel(mw, ctx, makeRequest(), handler);

    expect(res).toBe(passthroughResponse);
    expect(called()).toBe(true);
  });

  test("passes through when no messages", async () => {
    const mw = createReflexMiddleware({ rules: [helloRule] });
    const { handler, called } = passthrough();
    const ctx = makeCtx([]);

    const res = await callModel(mw, ctx, makeRequest(), handler);

    expect(res).toBe(passthroughResponse);
    expect(called()).toBe(true);
  });

  test("bypasses all rules when disabled", async () => {
    const mw = createReflexMiddleware({ rules: [helloRule], enabled: false });
    const { handler, called } = passthrough();
    const ctx = makeCtx([makeMessage("hello")]);

    const res = await callModel(mw, ctx, makeRequest(), handler);

    expect(res).toBe(passthroughResponse);
    expect(called()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

describe("priority", () => {
  test("lower priority rule checked first", async () => {
    const order: string[] = [];
    const mwRules: ReflexRule[] = [
      {
        name: "high",
        priority: 200,
        match: (m) => {
          order.push("high");
          return /^x$/.test(textOf(m));
        },
        respond: () => "high",
      },
      {
        name: "low",
        priority: 10,
        match: (m) => {
          order.push("low");
          return /^x$/.test(textOf(m));
        },
        respond: () => "low",
      },
    ];
    const mw = createReflexMiddleware({ rules: mwRules });
    const { handler } = passthrough();
    const res = await callModel(mw, makeCtx([makeMessage("x")]), makeRequest(), handler);

    expect(res.content).toBe("low");
    expect(order[0]).toBe("low");
  });

  test("first matching rule wins on equal priority", async () => {
    const rules: ReflexRule[] = [
      { name: "a", match: () => true, respond: () => "a" },
      { name: "b", match: () => true, respond: () => "b" },
    ];
    const mw = createReflexMiddleware({ rules });
    const { handler } = passthrough();
    const res = await callModel(mw, makeCtx([makeMessage("x")]), makeRequest(), handler);
    expect(res.content).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// Cooldown
// ---------------------------------------------------------------------------

describe("cooldown", () => {
  test("blocks rematch within window", async () => {
    let t = 0;
    const rule: ReflexRule = {
      name: "throttled",
      cooldownMs: 1000,
      match: () => true,
      respond: () => "fired",
    };
    const mw = createReflexMiddleware({ rules: [rule], now: () => t });
    const { handler, called } = passthrough();

    const r1 = await callModel(mw, makeCtx([makeMessage("hi")]), makeRequest(), handler);
    expect(r1.content).toBe("fired");

    t = 500;
    const r2 = await callModel(mw, makeCtx([makeMessage("hi")]), makeRequest(), handler);
    expect(r2).toBe(passthroughResponse);
    expect(called()).toBe(true);
  });

  test("re-fires after cooldown expires", async () => {
    let t = 0;
    const rule: ReflexRule = {
      name: "throttled",
      cooldownMs: 1000,
      match: () => true,
      respond: () => "fired",
    };
    const mw = createReflexMiddleware({ rules: [rule], now: () => t });
    const { handler } = passthrough();

    await callModel(mw, makeCtx([makeMessage("hi")]), makeRequest(), handler);
    t = 1500;
    const r2 = await callModel(mw, makeCtx([makeMessage("hi")]), makeRequest(), handler);
    expect(r2.content).toBe("fired");
  });

  test("cooldown state is per-instance", async () => {
    const rule: ReflexRule = {
      name: "throttled",
      cooldownMs: 1000,
      match: () => true,
      respond: () => "fired",
    };
    const mw1 = createReflexMiddleware({ rules: [rule], now: () => 0 });
    const mw2 = createReflexMiddleware({ rules: [rule], now: () => 0 });
    const { handler } = passthrough();

    await callModel(mw1, makeCtx([makeMessage("hi")]), makeRequest(), handler);
    const r2 = await callModel(mw2, makeCtx([makeMessage("hi")]), makeRequest(), handler);
    expect(r2.content).toBe("fired");
  });
});

// ---------------------------------------------------------------------------
// Error resilience
// ---------------------------------------------------------------------------

describe("error resilience", () => {
  test("skips rule when match throws", async () => {
    const order: string[] = [];
    const rules: ReflexRule[] = [
      {
        name: "broken",
        priority: 10,
        match: () => {
          order.push("broken");
          throw new Error("boom");
        },
        respond: () => "broken-response",
      },
      {
        name: "ok",
        priority: 20,
        match: (m) => {
          order.push("ok");
          return /^hello$/.test(textOf(m));
        },
        respond: () => "ok-response",
      },
    ];
    const mw = createReflexMiddleware({ rules });
    const { handler } = passthrough();
    const res = await callModel(mw, makeCtx([makeMessage("hello")]), makeRequest(), handler);
    expect(res.content).toBe("ok-response");
    expect(order).toEqual(["broken", "ok"]);
  });

  test("skips rule when respond throws, continues to next rule", async () => {
    const rules: ReflexRule[] = [
      {
        name: "first",
        priority: 10,
        match: () => true,
        respond: () => {
          throw new Error("boom");
        },
      },
      {
        name: "second",
        priority: 20,
        match: () => true,
        respond: () => "second-response",
      },
    ];
    const mw = createReflexMiddleware({ rules });
    const { handler } = passthrough();
    const res = await callModel(mw, makeCtx([makeMessage("x")]), makeRequest(), handler);
    expect(res.content).toBe("second-response");
  });

  test("passes through when respond throws on only matching rule", async () => {
    const rule: ReflexRule = {
      name: "broken",
      match: () => true,
      respond: () => {
        throw new Error("boom");
      },
    };
    const mw = createReflexMiddleware({ rules: [rule] });
    const { handler, called } = passthrough();
    const res = await callModel(mw, makeCtx([makeMessage("x")]), makeRequest(), handler);
    expect(res).toBe(passthroughResponse);
    expect(called()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

describe("abort handling", () => {
  test("throws AbortError when request.signal already aborted", async () => {
    const mw = createReflexMiddleware({ rules: [helloRule] });
    const { handler } = passthrough();
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(
      callModel(mw, makeCtx([makeMessage("hello")]), makeRequest({ signal: ctrl.signal }), handler),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  test("throws AbortError when ctx.signal already aborted", async () => {
    const mw = createReflexMiddleware({ rules: [helloRule] });
    const { handler } = passthrough();
    const ctrl = new AbortController();
    ctrl.abort();
    const ctx: TurnContext = { ...makeCtx([makeMessage("hello")]), signal: ctrl.signal };

    await expect(callModel(mw, ctx, makeRequest(), handler)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

// ---------------------------------------------------------------------------
// textOf
// ---------------------------------------------------------------------------

describe("textOf", () => {
  test("concatenates text blocks with newline", () => {
    expect(
      textOf(
        makeMessage("", [
          { kind: "text", text: "a" },
          { kind: "text", text: "b" },
        ]),
      ),
    ).toBe("a\nb");
  });

  test("ignores non-text blocks", () => {
    expect(
      textOf(
        makeMessage("", [
          { kind: "text", text: "hello" },
          { kind: "image", url: "x://y" },
          { kind: "file", url: "x://y", mimeType: "text/plain" },
          { kind: "button", label: "ok", action: "submit" },
          { kind: "custom", type: "x", data: {} },
          { kind: "text", text: "world" },
        ]),
      ),
    ).toBe("hello\nworld");
  });

  test("returns empty string when no text blocks", () => {
    expect(textOf(makeMessage("", [{ kind: "image", url: "x://y" }]))).toBe("");
  });
});
