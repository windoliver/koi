import { describe, expect, test } from "bun:test";
import type { SandboxExecutor } from "@koi/core";
import { createExecuteScriptTool } from "./execute-script-tool.js";

function recordingExecutor(): {
  readonly executor: SandboxExecutor;
  readonly captured: { readonly args: unknown[][] };
} {
  const captured: unknown[][] = [];
  return {
    captured: { args: captured },
    executor: {
      execute: async (code, input, timeoutMs) => {
        captured.push([code, input, timeoutMs]);
        return { ok: true, value: { output: 7, durationMs: 1 } };
      },
    },
  };
}

describe("createExecuteScriptTool", () => {
  test("descriptor is execute_script with required code field", () => {
    const tool = createExecuteScriptTool({ executor: recordingExecutor().executor });
    expect(tool.descriptor.name).toBe("execute_script");
    expect(tool.descriptor.inputSchema).toMatchObject({ required: ["code"] });
  });

  test("rejects missing code with VALIDATION error envelope", async () => {
    const tool = createExecuteScriptTool({ executor: recordingExecutor().executor });
    const result = await tool.execute({});
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });

  test("rejects unsupported language", async () => {
    const tool = createExecuteScriptTool({ executor: recordingExecutor().executor });
    const result = await tool.execute({ code: "return 1;", language: "python" });
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });

  test("clamps timeout below MIN_TIMEOUT_MS up to 100", async () => {
    const { executor, captured } = recordingExecutor();
    const tool = createExecuteScriptTool({ executor });
    await tool.execute({ code: "return 1;", timeout_ms: 0 });
    expect(captured.args[0]?.[2]).toBe(100);
  });

  test("clamps timeout above MAX_TIMEOUT_MS down to 120_000", async () => {
    const { executor, captured } = recordingExecutor();
    const tool = createExecuteScriptTool({ executor });
    await tool.execute({ code: "return 1;", timeout_ms: 999_999 });
    expect(captured.args[0]?.[2]).toBe(120_000);
  });

  test("uses default timeout 30_000 when timeout_ms is non-numeric", async () => {
    const { executor, captured } = recordingExecutor();
    const tool = createExecuteScriptTool({ executor });
    await tool.execute({ code: "return 1;" });
    expect(captured.args[0]?.[2]).toBe(30_000);
  });
});
