import { describe, expect, it } from "bun:test";
import type { SandboxError, SandboxExecutor, SandboxResult } from "@koi/core/sandbox-executor";
import type { ChildSpanRecord } from "@koi/execution-context";
import { runWithSpanRecorder } from "@koi/execution-context";
import { createExecTool } from "./exec-tool.js";
import type { ExecToolConfig } from "./types.js";

/** Creates a mock executor that returns a fixed success result. */
function successExecutor(result: SandboxResult): SandboxExecutor {
  return {
    execute: async () => ({ ok: true as const, value: result }),
  };
}

/** Creates a mock executor that returns a fixed error result. */
function errorExecutor(error: SandboxError): SandboxExecutor {
  return {
    execute: async () => ({ ok: false as const, error }),
  };
}

/** Creates a mock executor that records its arguments and returns success. */
function spyExecutor(): {
  readonly executor: SandboxExecutor;
  readonly calls: ReadonlyArray<{
    readonly code: string;
    readonly input: unknown;
    readonly timeoutMs: number;
    readonly context: unknown;
  }>;
} {
  const calls: Array<{
    readonly code: string;
    readonly input: unknown;
    readonly timeoutMs: number;
    readonly context: unknown;
  }> = [];
  return {
    calls,
    executor: {
      execute: async (code: string, input: unknown, timeoutMs: number, context?: unknown) => {
        calls.push({ code, input, timeoutMs, context });
        return { ok: true as const, value: { output: "ok", durationMs: 1 } };
      },
    },
  };
}

/** Helper to create tool with defaults. */
function createTool(overrides?: Partial<ExecToolConfig>): ReturnType<typeof createExecTool> {
  return createExecTool({
    executor: successExecutor({ output: "hello", durationMs: 42 }),
    ...overrides,
  });
}

/** Helper to get the first spy call (asserts it exists). */
function firstCall(spy: ReturnType<typeof spyExecutor>): (typeof spy.calls)[number] {
  const call = spy.calls[0];
  expect(call).toBeDefined();
  // biome-ignore lint/style/noNonNullAssertion: guarded by expect above
  return call!;
}

describe("createExecTool", () => {
  describe("descriptor and metadata", () => {
    it("has descriptor with name exec", () => {
      const tool = createTool();
      expect(tool.descriptor.name).toBe("exec");
    });

    it("has sandbox policy", () => {
      const tool = createTool();
      expect(tool.policy.sandbox).toBe(true);
    });

    it("has code as required in inputSchema", () => {
      const tool = createTool();
      const schema = tool.descriptor.inputSchema;
      expect(schema.required).toEqual(["code"]);
    });
  });

  describe("success path", () => {
    it("returns ok result with output and durationMs", async () => {
      const tool = createTool();
      const result = await tool.execute({ code: "return 1 + 1" });
      expect(result).toEqual({ ok: true, output: "hello", durationMs: 42 });
    });

    it("passes code and input to executor", async () => {
      const spy = spyExecutor();
      const tool = createExecTool({ executor: spy.executor });
      await tool.execute({ code: "return input.x", input: { x: 42 } });
      expect(spy.calls).toHaveLength(1);
      const call = firstCall(spy);
      expect(call.code).toBe("return input.x");
      expect(call.input).toEqual({ x: 42 });
    });

    it("defaults input to null when omitted", async () => {
      const spy = spyExecutor();
      const tool = createExecTool({ executor: spy.executor });
      await tool.execute({ code: "return 1" });
      expect(firstCall(spy).input).toBeNull();
    });
  });

  describe("timeout handling", () => {
    it("uses default timeout when timeout_ms is omitted", async () => {
      const spy = spyExecutor();
      const tool = createExecTool({ executor: spy.executor });
      await tool.execute({ code: "return 1" });
      expect(firstCall(spy).timeoutMs).toBe(5_000);
    });

    it("uses custom defaultTimeoutMs from config", async () => {
      const spy = spyExecutor();
      const tool = createExecTool({ executor: spy.executor, defaultTimeoutMs: 10_000 });
      await tool.execute({ code: "return 1" });
      expect(firstCall(spy).timeoutMs).toBe(10_000);
    });

    it("respects model-requested timeout_ms", async () => {
      const spy = spyExecutor();
      const tool = createExecTool({ executor: spy.executor });
      await tool.execute({ code: "return 1", timeout_ms: 2_000 });
      expect(firstCall(spy).timeoutMs).toBe(2_000);
    });

    it("clamps timeout_ms to maxTimeoutMs", async () => {
      const spy = spyExecutor();
      const tool = createExecTool({ executor: spy.executor, maxTimeoutMs: 10_000 });
      await tool.execute({ code: "return 1", timeout_ms: 60_000 });
      expect(firstCall(spy).timeoutMs).toBe(10_000);
    });

    it("ignores non-positive timeout_ms and uses default", async () => {
      const spy = spyExecutor();
      const tool = createExecTool({ executor: spy.executor });
      await tool.execute({ code: "return 1", timeout_ms: -100 });
      expect(firstCall(spy).timeoutMs).toBe(5_000);
    });

    it("ignores non-number timeout_ms and uses default", async () => {
      const spy = spyExecutor();
      const tool = createExecTool({ executor: spy.executor });
      await tool.execute({ code: "return 1", timeout_ms: "fast" });
      expect(firstCall(spy).timeoutMs).toBe(5_000);
    });
  });

  describe("context passthrough", () => {
    it("forwards networkAllowed from config", async () => {
      const spy = spyExecutor();
      const tool = createExecTool({ executor: spy.executor, networkAllowed: true });
      await tool.execute({ code: "return 1" });
      expect(firstCall(spy).context).toEqual({ networkAllowed: true });
    });

    it("forwards resourceLimits from config", async () => {
      const spy = spyExecutor();
      const limits = { maxMemoryMb: 128, maxPids: 10 };
      const tool = createExecTool({ executor: spy.executor, resourceLimits: limits });
      await tool.execute({ code: "return 1" });
      expect(firstCall(spy).context).toEqual({ resourceLimits: limits });
    });

    it("omits networkAllowed when not configured", async () => {
      const spy = spyExecutor();
      const tool = createExecTool({ executor: spy.executor });
      await tool.execute({ code: "return 1" });
      expect(firstCall(spy).context).toEqual({});
    });
  });

  describe("span recording", () => {
    it("records validate span on successful execution", async () => {
      const spans: ChildSpanRecord[] = [];
      const recorder = {
        record: (span: ChildSpanRecord): void => {
          spans.push(span);
        },
      };
      const tool = createTool();

      await runWithSpanRecorder(recorder, () => tool.execute({ code: "return 1" }));

      const validateSpan = spans.find((s) => s.label === "tool-exec:validate");
      expect(validateSpan).toBeDefined();
      expect(validateSpan?.durationMs).toBeGreaterThanOrEqual(0);
      expect(validateSpan?.error).toBeUndefined();
    });

    it("records validate span with error on invalid input", async () => {
      const spans: ChildSpanRecord[] = [];
      const recorder = {
        record: (span: ChildSpanRecord): void => {
          spans.push(span);
        },
      };
      const tool = createTool();

      await runWithSpanRecorder(recorder, () => tool.execute({}));

      const validateSpan = spans.find((s) => s.label === "tool-exec:validate");
      expect(validateSpan).toBeDefined();
      expect(validateSpan?.error).toBe("Missing or empty `code` parameter");
    });

    it("does not throw when no recorder is active", async () => {
      const tool = createTool();
      const result = (await tool.execute({ code: "return 1" })) as { ok: boolean };
      expect(result.ok).toBe(true);
    });
  });

  describe("validation errors", () => {
    it("returns VALIDATION error for missing code", async () => {
      const tool = createTool();
      const result = (await tool.execute({})) as { ok: boolean; code: string };
      expect(result.ok).toBe(false);
      expect(result.code).toBe("VALIDATION");
    });

    it("returns VALIDATION error for empty code", async () => {
      const tool = createTool();
      const result = (await tool.execute({ code: "" })) as { ok: boolean; code: string };
      expect(result.ok).toBe(false);
      expect(result.code).toBe("VALIDATION");
    });

    it("returns VALIDATION error for non-string code", async () => {
      const tool = createTool();
      const result = (await tool.execute({ code: 42 })) as { ok: boolean; code: string };
      expect(result.ok).toBe(false);
      expect(result.code).toBe("VALIDATION");
    });
  });

  describe("executor error forwarding", () => {
    it("returns TIMEOUT error from executor", async () => {
      const tool = createExecTool({
        executor: errorExecutor({
          code: "TIMEOUT",
          message: "Execution timed out",
          durationMs: 5000,
        }),
      });
      const result = (await tool.execute({ code: "while(true){}" })) as {
        ok: boolean;
        code: string;
        error: string;
        durationMs: number;
      };
      expect(result.ok).toBe(false);
      expect(result.code).toBe("TIMEOUT");
      expect(result.error).toBe("Execution timed out");
      expect(result.durationMs).toBe(5000);
    });

    it("returns OOM error from executor", async () => {
      const tool = createExecTool({
        executor: errorExecutor({ code: "OOM", message: "Out of memory", durationMs: 100 }),
      });
      const result = (await tool.execute({ code: "new Array(1e10)" })) as {
        ok: boolean;
        code: string;
      };
      expect(result.ok).toBe(false);
      expect(result.code).toBe("OOM");
    });

    it("returns PERMISSION error from executor", async () => {
      const tool = createExecTool({
        executor: errorExecutor({
          code: "PERMISSION",
          message: "Network access denied",
          durationMs: 0,
        }),
      });
      const result = (await tool.execute({ code: "fetch('http://evil')" })) as {
        ok: boolean;
        code: string;
      };
      expect(result.ok).toBe(false);
      expect(result.code).toBe("PERMISSION");
    });

    it("returns CRASH error from executor", async () => {
      const tool = createExecTool({
        executor: errorExecutor({
          code: "CRASH",
          message: "Sandbox process exited",
          durationMs: 50,
        }),
      });
      const result = (await tool.execute({ code: "process.exit(1)" })) as {
        ok: boolean;
        code: string;
      };
      expect(result.ok).toBe(false);
      expect(result.code).toBe("CRASH");
    });

    it("returns CRASH error when executor throws an exception", async () => {
      const tool = createExecTool({
        executor: {
          execute: async () => {
            throw new Error("connection refused");
          },
        },
      });
      const result = (await tool.execute({ code: "return 1" })) as {
        ok: boolean;
        code: string;
        error: string;
      };
      expect(result.ok).toBe(false);
      expect(result.code).toBe("CRASH");
      expect(result.error).toBe("connection refused");
    });

    it("returns generic message when executor throws non-Error", async () => {
      const tool = createExecTool({
        executor: {
          execute: async () => {
            throw "string error";
          },
        },
      });
      const result = (await tool.execute({ code: "return 1" })) as {
        ok: boolean;
        code: string;
        error: string;
      };
      expect(result.ok).toBe(false);
      expect(result.code).toBe("CRASH");
      expect(result.error).toBe("Sandbox executor threw an unexpected error");
    });
  });
});
