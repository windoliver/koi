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
      execute: async (code, input, timeoutMs, context) => {
        captured.push([code, input, timeoutMs, context]);
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

  test("requests sandbox execution with full policy context", async () => {
    const { executor, captured } = recordingExecutor();
    const tool = createExecuteScriptTool({ executor });
    await tool.execute({ code: "return 1;" });
    expect(captured.args[0]?.[3]).toEqual({
      networkAllowed: false,
      filesystem: {
        read: ["/usr", "/bin", "/lib", "/etc", "/tmp"],
        write: ["/tmp/koi-sandbox-*"],
      },
      resourceLimits: { maxMemoryMb: 512, maxPids: 64, maxOpenFiles: 256 },
    });
  });

  test("adds workspace path to execution context when configured", async () => {
    const { executor, captured } = recordingExecutor();
    const tool = createExecuteScriptTool({ executor, workspacePath: "/work/repo" });
    await tool.execute({ code: "return 1;" });
    expect(captured.args[0]?.[3]).toEqual({
      networkAllowed: false,
      workspacePath: "/work/repo",
      filesystem: {
        read: ["/usr", "/bin", "/lib", "/etc", "/tmp", "/work/repo"],
        write: ["/tmp/koi-sandbox-*"],
      },
      resourceLimits: { maxMemoryMb: 512, maxPids: 64, maxOpenFiles: 256 },
    });
  });

  test("adds workspace write access only when explicitly configured", async () => {
    const { executor, captured } = recordingExecutor();
    const tool = createExecuteScriptTool({
      executor,
      workspacePath: "/work/repo",
      workspaceWrite: true,
    });
    await tool.execute({ code: "return 1;" });
    expect(captured.args[0]?.[3]).toMatchObject({
      filesystem: { write: ["/tmp/koi-sandbox-*", "/work/repo"] },
    });
  });
});
