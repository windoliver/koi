import { describe, expect, test } from "bun:test";
import type { SandboxError, SandboxExecutor, SandboxResult } from "@koi/core";
import { executeScript } from "./execute-script.js";

function mockSuccessExecutor(value: SandboxResult): SandboxExecutor {
  return {
    execute: async () => ({ ok: true, value }),
  };
}

function mockFailureExecutor(error: SandboxError): SandboxExecutor {
  return {
    execute: async () => ({ ok: false, error }),
  };
}

function mockCapturingExecutor(): {
  readonly executor: SandboxExecutor;
  readonly captured: { readonly args: unknown[][] };
} {
  const captured: unknown[][] = [];
  return {
    captured: { args: captured },
    executor: {
      execute: async (code, input, timeoutMs, context) => {
        captured.push([code, input, timeoutMs, context]);
        return { ok: true, value: { output: "ok", durationMs: 5 } };
      },
    },
  };
}

describe("executeScript", () => {
  test("returns ok+result on sandbox success", async () => {
    const result = await executeScript({
      code: "return 42;",
      executor: mockSuccessExecutor({ output: 42, durationMs: 10 }),
    });
    expect(result.ok).toBe(true);
    expect(result.result).toBe(42);
    expect(result.error).toBeUndefined();
  });

  test("transpiles TypeScript before forwarding to sandbox", async () => {
    const { executor, captured } = mockCapturingExecutor();
    await executeScript({
      code: "const x: number = 1; return x;",
      language: "typescript",
      executor,
    });
    expect(captured.args).toHaveLength(1);
    const wrapped = captured.args[0]?.[0] as string;
    expect(wrapped).toContain("const x = 1");
    expect(wrapped).not.toContain(": number");
  });

  test("returns TRANSPILE error when TypeScript is invalid", async () => {
    const result = await executeScript({
      code: "const x: = ;",
      language: "typescript",
      executor: mockSuccessExecutor({ output: 0, durationMs: 0 }),
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TRANSPILE");
  });

  test("preserves SandboxError code on failure", async () => {
    const result = await executeScript({
      code: "while (true) {}",
      executor: mockFailureExecutor({
        code: "TIMEOUT",
        message: "deadline exceeded",
        durationMs: 1234,
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TIMEOUT");
    expect(result.error?.message).toBe("deadline exceeded");
    expect(result.error?.durationMs).toBe(1234);
  });

  test("forwards input to sandbox and wraps script as async body", async () => {
    const { executor, captured } = mockCapturingExecutor();
    await executeScript({ code: "return input + 1;", input: 41, executor });
    const [code, input, timeoutMs] = captured.args[0] ?? [];
    expect(code).toContain("async function");
    expect(code).toContain("(input)");
    expect(code).toContain("return input + 1;");
    expect(input).toBe(41);
    expect(timeoutMs).toBe(30_000);
  });

  test("forwards explicit timeoutMs", async () => {
    const { executor, captured } = mockCapturingExecutor();
    await executeScript({ code: "return 0;", timeoutMs: 5_000, executor });
    expect(captured.args[0]?.[2]).toBe(5_000);
  });

  test("forwards execution context to sandbox", async () => {
    const { executor, captured } = mockCapturingExecutor();
    await executeScript({
      code: "return 0;",
      executor,
      context: { networkAllowed: false },
    });
    expect(captured.args[0]?.[3]).toEqual({ networkAllowed: false });
  });
});
