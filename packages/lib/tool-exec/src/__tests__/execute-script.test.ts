import { describe, expect, test } from "bun:test";
import type { Tool } from "@koi/core";
import { ACKNOWLEDGE_UNSANDBOXED_EXECUTION } from "../execute-code-tool.js";
import { DEFAULT_MAX_TOOL_CALLS, executeScript } from "../execute-script.js";
import type { ScriptConfig } from "../types.js";

const ACK = ACKNOWLEDGE_UNSANDBOXED_EXECUTION;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(name: string, fn: (args: Record<string, unknown>) => unknown): Tool {
  return {
    descriptor: {
      name,
      description: `test tool: ${name}`,
      inputSchema: { type: "object", properties: {} },
      origin: "operator",
    },
    origin: "operator",
    policy: { sandbox: false, capabilities: {} },
    execute: async (args) => fn(args as Record<string, unknown>),
  };
}

function config(
  overrides: Omit<Partial<ScriptConfig>, "code"> & {
    code?: string;
    tools?: ReadonlyMap<string, Tool>;
  } = {},
): ScriptConfig {
  return {
    acknowledgeUnsandboxedExecution: ACK,
    code: "",
    tools: new Map(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Basic execution
// ---------------------------------------------------------------------------

describe("executeScript — basic execution", () => {
  test("returns the script's return value", async () => {
    const result = await executeScript(config({ code: "return 42;" }));
    expect(result.ok).toBe(true);
    expect(result.result).toBe(42);
    expect(result.toolCallCount).toBe(0);
  });

  test("returns an object from the script", async () => {
    const result = await executeScript(config({ code: "return { a: 1, b: 'hello' };" }));
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ a: 1, b: "hello" });
  });

  test("handles scripts with no explicit return (null result)", async () => {
    const result = await executeScript(config({ code: "const x = 1 + 1;" }));
    expect(result.ok).toBe(true);
    expect(result.result).toBeNull();
  });

  test("returns error on script throw", async () => {
    const result = await executeScript(config({ code: `throw new Error("boom");` }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
  });

  test("records durationMs > 0", async () => {
    const result = await executeScript(config({ code: "return 1;" }));
    expect(result.durationMs).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

describe("executeScript — tool calls", () => {
  test("calls a registered tool and receives its result", async () => {
    const addTool = makeTool(
      "add",
      ({ a, b }: Record<string, unknown>) => (a as number) + (b as number),
    );
    const tools = new Map([["add", addTool]]);

    const result = await executeScript(
      config({
        tools,
        code: `const sum = await tools.add({ a: 3, b: 4 }); return sum;`,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.result).toBe(7);
    expect(result.toolCallCount).toBe(1);
  });

  test("calls multiple tools sequentially", async () => {
    const double = makeTool("double", ({ n }: Record<string, unknown>) => (n as number) * 2);
    const negate = makeTool("negate", ({ n }: Record<string, unknown>) => -(n as number));
    const tools = new Map([
      ["double", double],
      ["negate", negate],
    ]);

    const result = await executeScript(
      config({
        tools,
        code: `
          const d = await tools.double({ n: 5 });
          const n = await tools.negate({ n: d });
          return n;
        `,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.result).toBe(-10);
    expect(result.toolCallCount).toBe(2);
  });

  test("returns error for unknown tool", async () => {
    const result = await executeScript(config({ code: `await tools.nonexistent({ x: 1 });` }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/nonexistent|unknown tool/i);
  });

  test("uses callTool override when provided", async () => {
    const calls: string[] = [];
    const callTool = async (name: string): Promise<unknown> => {
      calls.push(name);
      return "mw-result";
    };

    // No tools in map — callTool intercepts all calls
    const result = await executeScript(
      config({
        code: `return await tools.someOp({});`,
        callTool,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.result).toBe("mw-result");
    expect(calls).toEqual(["someOp"]);
  });
});

// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------

describe("executeScript — tool call budget", () => {
  test("stops with error when budget is exceeded", async () => {
    const counter = makeTool("tick", () => "ok");
    const tools = new Map([["tick", counter]]);

    const maxToolCalls = 3;
    const result = await executeScript(
      config({
        tools,
        maxToolCalls,
        code: `
          for (let i = 0; i < 10; i++) {
            await tools.tick({});
          }
          return "done";
        `,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.toolCallCount).toBeLessThanOrEqual(maxToolCalls + 1);
    expect(result.error).toMatch(/budget/i);
  });

  test("fails the whole script when an over-budget tool call is caught", async () => {
    const counter = makeTool("tick", () => "ok");
    const tools = new Map([["tick", counter]]);

    const result = await executeScript(
      config({
        tools,
        maxToolCalls: 1,
        code: `
          try {
            await tools.tick({});
            await tools.tick({});
          } catch {
            return "caught budget error";
          }
          return "not caught";
        `,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.result).toBeNull();
    expect(result.error).toMatch(/budget/i);
  });

  test("default budget is DEFAULT_MAX_TOOL_CALLS", () => {
    expect(DEFAULT_MAX_TOOL_CALLS).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Concurrent calls
// ---------------------------------------------------------------------------

describe("executeScript — concurrent tool calls", () => {
  test("fails closed when script issues concurrent tool calls (Promise.all)", async () => {
    // Sequential-only contract: a concurrency violation is a script bug, not
    // a recoverable per-call error. The whole script must fail with ok: false.
    const slow = makeTool("slow", () => new Promise((r) => setTimeout(r, 300)));
    const fast = makeTool("fast", () => "fast-result");
    const tools = new Map([
      ["slow", slow],
      ["fast", fast],
    ]);

    const result = await executeScript(
      config({
        tools,
        code: `
          // Even if the script tries to swallow the rejection, the host must
          // still terminate the script with a concurrency error.
          const settled = await Promise.allSettled([tools.slow({}), tools.fast({})]);
          return { settled };
        `,
        timeoutMs: 2000,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/concurrent|sequential/i);
  });

  test("timeout while tool is in flight marks result inFlightAtSettlement (indeterminate)", async () => {
    // Regression: cooperative abort cannot guarantee remote backends (e.g. MCP)
    // did not commit. Callers must see a flag and avoid blind retries.
    const nonCancellable: Tool = {
      descriptor: {
        name: "noncancel",
        description: "ignores abort",
        inputSchema: { type: "object", properties: {} },
        origin: "operator",
      },
      origin: "operator",
      policy: { sandbox: false, capabilities: {} },
      // Intentionally ignores ctx.signal — simulates a non-cancellable backend.
      execute: async () => new Promise((r) => setTimeout(() => r("late-commit"), 500)),
    };
    const result = await executeScript(
      config({
        tools: new Map([["noncancel", nonCancellable]]),
        code: `return await tools.noncancel({});`,
        timeoutMs: 100,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/i);
    expect(result.inFlightAtSettlement).toBe(true);
  });

  test("normal completion does not set inFlightAtSettlement", async () => {
    const result = await executeScript(config({ code: "return 1;" }));
    expect(result.ok).toBe(true);
    expect(result.inFlightAtSettlement).toBeUndefined();
  });

  test("completed tool calls are not retroactively aborted on later failure", async () => {
    // Regression: a single shared AbortController would flip completed calls'
    // signals to aborted on later script failure. Each call must get its own
    // signal that is NOT aborted after the call resolves.
    let firstSignal: AbortSignal | undefined;
    let secondSignal: AbortSignal | undefined;
    const first: Tool = {
      descriptor: {
        name: "first",
        description: "first",
        inputSchema: { type: "object", properties: {} },
        origin: "operator",
      },
      origin: "operator",
      policy: { sandbox: false, capabilities: {} },
      execute: async (_args, ctx) => {
        firstSignal = ctx?.signal;
        return "first-done";
      },
    };
    const second: Tool = {
      descriptor: {
        name: "second",
        description: "second",
        inputSchema: { type: "object", properties: {} },
        origin: "operator",
      },
      origin: "operator",
      policy: { sandbox: false, capabilities: {} },
      execute: async (_args, ctx) => {
        secondSignal = ctx?.signal;
        throw new Error("second blew up");
      },
    };
    const result = await executeScript(
      config({
        tools: new Map([
          ["first", first],
          ["second", second],
        ]),
        code: `
          const a = await tools.first({});
          try { await tools.second({}); } catch (e) { /* swallow */ }
          return a;
        `,
      }),
    );

    expect(result.ok).toBe(true);
    expect(firstSignal?.aborted).toBe(false);
    expect(secondSignal?.aborted).toBe(false);
    expect(firstSignal).not.toBe(secondSignal);
  });

  test("concurrent-call spam cannot bypass maxToolCalls", async () => {
    // Regression: previously concurrent rejections did not consume the budget,
    // so a hostile script could emit unbounded `call` messages during one
    // pending call. Failing closed terminates after the first violation.
    const slow = makeTool("slow", () => new Promise((r) => setTimeout(r, 500)));
    const fast = makeTool("fast", () => "fast-result");
    const tools = new Map([
      ["slow", slow],
      ["fast", fast],
    ]);

    const result = await executeScript(
      config({
        tools,
        maxToolCalls: 2,
        code: `
          const promises = [tools.slow({})];
          for (let i = 0; i < 1000; i++) {
            promises.push(tools.fast({}));
          }
          await Promise.allSettled(promises);
          return "done";
        `,
        timeoutMs: 2000,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/concurrent|sequential/i);
    // The first slow call counted, then the script terminated on the next
    // concurrent call before any unbounded spam could fire.
    expect(result.toolCallCount).toBeLessThanOrEqual(2);
  });

  test("concurrent-call rejection aborts in-flight tool and does not throw post-settlement", async () => {
    // Regression: previously the in-flight tool kept running after settlement
    // and the host threw InvalidStateError when posting to the terminated worker.
    let slowAborted = false;
    let slowSettledAt = 0;
    const slow: Tool = {
      descriptor: {
        name: "slow",
        description: "slow",
        inputSchema: { type: "object", properties: {} },
        origin: "operator",
      },
      origin: "operator",
      policy: { sandbox: false, capabilities: {} },
      execute: async (_args, ctx) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            slowSettledAt = Date.now();
            resolve("slow-done");
          }, 1500);
          ctx?.signal?.addEventListener("abort", () => {
            slowAborted = true;
            slowSettledAt = Date.now();
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        }),
    };
    const fast = makeTool("fast", () => "fast-result");
    const tools = new Map([
      ["slow", slow],
      ["fast", fast],
    ]);

    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on("unhandledRejection", onUnhandled);
    process.on("uncaughtException", onUnhandled);

    const before = Date.now();
    try {
      await executeScript(
        config({
          tools,
          code: `
            const [a, b] = await Promise.all([tools.slow({}), tools.fast({})]);
            return { a, b };
          `,
          timeoutMs: 3000,
        }),
      );
      // Give the slow tool's natural timer a chance to fire if abort failed.
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      process.off("unhandledRejection", onUnhandled);
      process.off("uncaughtException", onUnhandled);
    }

    expect(slowAborted).toBe(true);
    // Slow tool should have been aborted long before its 1500ms natural completion.
    expect(slowSettledAt - before).toBeLessThan(1000);
    expect(unhandled).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Missing-await detection (script returned with tool call still pending)
// ---------------------------------------------------------------------------

describe("executeScript — missing await detection", () => {
  test("concurrency violation cannot be swallowed by script try/catch", async () => {
    // Regression: a script that catches the synchronous throw from the proxy
    // must still fail the run. Worker posts an authoritative error to host
    // before throwing so settlement is host-driven, not script-driven.
    const slow = makeTool("slow", () => new Promise((r) => setTimeout(r, 200)));
    const fast = makeTool("fast", () => "fast");
    const result = await executeScript(
      config({
        tools: new Map([
          ["slow", slow],
          ["fast", fast],
        ]),
        code: `
          const p = tools.slow({});
          try { tools.fast({}); } catch (e) { /* swallowed */ }
          await p;
          return "ok";
        `,
        timeoutMs: 2000,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/concurrent|sequential/i);
  });

  test("fails closed on Promise.all with fast-resolving tools", async () => {
    const a = makeTool("a", () => "a");
    const b = makeTool("b", () => "b");
    const result = await executeScript(
      config({
        tools: new Map([
          ["a", a],
          ["b", b],
        ]),
        // Both synchronous in the array-literal evaluation — second call
        // throws synchronously because first is still unresolved.
        code: `await Promise.all([tools.a({}), tools.b({})]); return "ok";`,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/concurrent|sequential/i);
  });

  test("fails closed when script returns while a tool call is in flight", async () => {
    // Regression: previously `tools.write({...}); return "ok"` would settle
    // success and silently abort the side-effecting call.
    let toolStarted = false;
    const slow: Tool = {
      descriptor: {
        name: "slow",
        description: "slow",
        inputSchema: { type: "object", properties: {} },
        origin: "operator",
      },
      origin: "operator",
      policy: { sandbox: false, capabilities: {} },
      execute: async () => {
        toolStarted = true;
        return new Promise((r) => setTimeout(() => r("late"), 200));
      },
    };
    const result = await executeScript(
      config({
        tools: new Map([["slow", slow]]),
        // No await on tools.slow — script returns while call is pending.
        code: `tools.slow({}); return "ok";`,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/in flight|awaited/i);
    expect(toolStarted).toBe(true);
    expect(result.inFlightAtSettlement).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Abort reason propagation
// ---------------------------------------------------------------------------

describe("executeScript — abort reason propagation", () => {
  test("inner tool sees TimeoutError reason on script timeout", async () => {
    // Regression: nested tools must receive a timeout-classified reason, not
    // a generic abort. Downstream middleware uses name === "TimeoutError" to
    // distinguish timeout vs user cancel vs upstream shutdown.
    let observedReason: unknown = "<not aborted>";
    const watch: Tool = {
      descriptor: {
        name: "watch",
        description: "watch",
        inputSchema: { type: "object", properties: {} },
        origin: "operator",
      },
      origin: "operator",
      policy: { sandbox: false, capabilities: {} },
      execute: async (_args, ctx) =>
        new Promise((_resolve, reject) => {
          ctx?.signal?.addEventListener("abort", () => {
            observedReason = ctx?.signal?.reason;
            reject(new Error("aborted"));
          });
        }),
    };

    const result = await executeScript(
      config({
        tools: new Map([["watch", watch]]),
        code: `await tools.watch({});`,
        timeoutMs: 50,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/i);
    expect(observedReason).toBeInstanceOf(DOMException);
    expect((observedReason as DOMException).name).toBe("TimeoutError");
  });

  test("downstream tool sees caller's abort reason on user cancel", async () => {
    let observedReason: unknown = "<not aborted>";
    const watch: Tool = {
      descriptor: {
        name: "watch",
        description: "watch",
        inputSchema: { type: "object", properties: {} },
        origin: "operator",
      },
      origin: "operator",
      policy: { sandbox: false, capabilities: {} },
      execute: async (_args, ctx) =>
        new Promise((_resolve, reject) => {
          ctx?.signal?.addEventListener("abort", () => {
            observedReason = ctx?.signal?.reason;
            reject(new Error("aborted"));
          });
        }),
    };

    const controller = new AbortController();
    const userReason = new Error("user-cancelled-with-context");
    setTimeout(() => controller.abort(userReason), 50);

    const result = await executeScript(
      config({
        tools: new Map([["watch", watch]]),
        code: `await tools.watch({});`,
        signal: controller.signal,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/aborted/i);
    expect(observedReason).toBe(userReason);
  });
});

// ---------------------------------------------------------------------------
// Trust gate on executeScript public export
// ---------------------------------------------------------------------------

describe("executeScript — trust gate", () => {
  test("refuses execution without acknowledgeUnsandboxedExecution", async () => {
    // @ts-expect-error — intentionally omitting required acknowledgement
    const result = await executeScript({ code: "return 1;", tools: new Map() });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/acknowledgeUnsandboxedExecution/);
  });

  test("refuses execution with the wrong acknowledgement string", async () => {
    const result = await executeScript({
      // @ts-expect-error — intentionally wrong sentinel value
      acknowledgeUnsandboxedExecution: "yes",
      code: "return 1;",
      tools: new Map(),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/acknowledgeUnsandboxedExecution/);
  });
});

// ---------------------------------------------------------------------------
// Guardrail validation on the public executeScript surface
// ---------------------------------------------------------------------------

describe("executeScript — guardrail validation", () => {
  test("rejects NaN timeoutMs", async () => {
    const result = await executeScript(config({ code: "return 1;", timeoutMs: Number.NaN }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeoutMs must be a positive finite number/i);
  });

  test("rejects Infinity timeoutMs", async () => {
    const result = await executeScript(
      config({ code: "return 1;", timeoutMs: Number.POSITIVE_INFINITY }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeoutMs/i);
  });

  test("rejects negative timeoutMs", async () => {
    const result = await executeScript(config({ code: "return 1;", timeoutMs: -5 }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeoutMs/i);
  });

  test("rejects NaN maxToolCalls (would disable budget)", async () => {
    const result = await executeScript(config({ code: "return 1;", maxToolCalls: Number.NaN }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/maxToolCalls/i);
  });

  test("rejects non-integer maxToolCalls", async () => {
    const result = await executeScript(config({ code: "return 1;", maxToolCalls: 2.5 }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/maxToolCalls/i);
  });

  test("rejects negative maxToolCalls", async () => {
    const result = await executeScript(config({ code: "return 1;", maxToolCalls: -1 }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/maxToolCalls/i);
  });

  test("accepts 0 maxToolCalls (valid: no tool calls permitted)", async () => {
    const result = await executeScript(config({ code: "return 1;", maxToolCalls: 0 }));
    expect(result.ok).toBe(true);
    expect(result.result).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Malformed tool arguments
// ---------------------------------------------------------------------------

describe("executeScript — malformed tool arguments", () => {
  // Helper: run a script that catches the expected error so we can assert on
  // the exact error string returned to the caller rather than the outer
  // result.error (which is the raw thrown message).
  async function runRejectsArgs(argExpr: string): Promise<{
    readonly callCount: number;
    readonly caught: string;
  }> {
    let callCount = 0;
    const spy = makeTool("spy", () => {
      callCount++;
      return "ran";
    });
    const result = await executeScript(
      config({
        tools: new Map([["spy", spy]]),
        code: `
          try {
            await tools.spy(${argExpr});
            return "no-error";
          } catch (e) {
            return e.message;
          }
        `,
      }),
    );
    expect(result.ok).toBe(true);
    return { callCount, caught: result.result as string };
  }

  test("rejects primitive string tool args (does not coerce to {})", async () => {
    const { callCount, caught } = await runRejectsArgs(`"/path/that/should/fail"`);
    expect(caught).toMatch(/must be a plain object/i);
    expect(callCount).toBe(0);
  });

  test("rejects null tool args", async () => {
    const { callCount, caught } = await runRejectsArgs(`null`);
    expect(caught).toMatch(/must be a plain object/i);
    expect(callCount).toBe(0);
  });

  test("rejects array tool args", async () => {
    const { callCount, caught } = await runRejectsArgs(`[1, 2, 3]`);
    expect(caught).toMatch(/must be a plain object/i);
    expect(callCount).toBe(0);
  });

  test("zero-arg call (tools.noop()) is treated as empty object", async () => {
    let received: unknown = "<not called>";
    const noop = makeTool("noop", (args) => {
      received = args;
      return "ran";
    });
    const result = await executeScript(
      config({
        tools: new Map([["noop", noop]]),
        code: `return await tools.noop();`,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.result).toBe("ran");
    expect(received).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Abort startup race
// ---------------------------------------------------------------------------

describe("executeScript — abort startup race", () => {
  test("abort fired between entry and listener registration still cancels the script", async () => {
    const controller = new AbortController();
    let toolCalled = false;
    const spy = makeTool("spy", () => {
      toolCalled = true;
      return "ran";
    });

    // Queue an abort on the next microtask — it will fire after executeScript()
    // begins transpiling/constructing the worker but before it posts `run`.
    queueMicrotask(() => controller.abort());

    const result = await executeScript(
      config({
        tools: new Map([["spy", spy]]),
        code: `await tools.spy({}); return "done";`,
        signal: controller.signal,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Script aborted");
    expect(toolCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pre-aborted signal
// ---------------------------------------------------------------------------

describe("executeScript — pre-aborted signal", () => {
  test("returns abort error immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await executeScript(
      config({
        code: `return "should not run";`,
        signal: controller.signal,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/abort/i);
    expect(result.toolCallCount).toBe(0);
    expect(result.durationMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe("executeScript — timeout", () => {
  test("times out a hanging script", async () => {
    const result = await executeScript(
      config({
        code: `await new Promise(() => {});`, // never resolves
        timeoutMs: 200,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });

  test("respects abort signal", async () => {
    const controller = new AbortController();
    const promise = executeScript(
      config({
        code: `await new Promise(() => {});`,
        signal: controller.signal,
      }),
    );

    // Abort after a short delay
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/abort/i);
  });
});

// ---------------------------------------------------------------------------
// TypeScript transpilation
// ---------------------------------------------------------------------------

describe("executeScript — TypeScript", () => {
  test("transpiles TypeScript type annotations", async () => {
    const result = await executeScript(
      config({
        code: `
          const x: number = 10;
          const greet = (name: string): string => "hello " + name;
          return greet("world");
        `,
        language: "typescript",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.result).toBe("hello world");
  });

  test("defaults to TypeScript language when unspecified", async () => {
    const result = await executeScript(
      config({
        code: `const n: number = 99; return n;`,
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.result).toBe(99);
  });
});
