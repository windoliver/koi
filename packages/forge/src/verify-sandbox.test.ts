import { describe, expect, test } from "bun:test";
import type { VerificationConfig } from "./config.js";
import type { ForgeInput, SandboxExecutor } from "./types.js";
import { verifySandbox } from "./verify-sandbox.js";

const DEFAULT_VERIFICATION: VerificationConfig = {
  staticTimeoutMs: 1_000,
  sandboxTimeoutMs: 5_000,
  selfTestTimeoutMs: 10_000,
  totalTimeoutMs: 30_000,
  maxBrickSizeBytes: 50_000,
  failFast: true,
};

function mockExecutor(overrides?: Partial<SandboxExecutor>): SandboxExecutor {
  return {
    execute: async (_code, _input, _timeout) => ({
      ok: true,
      value: { output: "ok", durationMs: 10 },
    }),
    ...overrides,
  };
}

describe("verifySandbox", () => {
  test("skips for skill kind", async () => {
    const input: ForgeInput = {
      kind: "skill",
      name: "mySkill",
      description: "A skill",
      body: "content",
    };
    const result = await verifySandbox(input, mockExecutor(), DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.passed).toBe(true);
      expect(result.value.message).toContain("Skipped");
    }
  });

  test("skips for agent kind", async () => {
    const input: ForgeInput = {
      kind: "agent",
      name: "myAgent",
      description: "An agent",
      manifestYaml: "name: test",
    };
    const result = await verifySandbox(input, mockExecutor(), DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
  });

  test("skips for composite kind", async () => {
    const input: ForgeInput = {
      kind: "composite",
      name: "myComposite",
      description: "A composite",
      brickIds: ["a"],
    };
    const result = await verifySandbox(input, mockExecutor(), DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
  });

  test("succeeds for tool with passing executor", async () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return 1;",
    };
    const result = await verifySandbox(input, mockExecutor(), DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stage).toBe("sandbox");
      expect(result.value.passed).toBe(true);
    }
  });

  test("returns TIMEOUT error on timeout", async () => {
    const executor = mockExecutor({
      execute: async () => ({
        ok: false,
        error: { code: "TIMEOUT", message: "timeout exceeded", durationMs: 5000 },
      }),
    });
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "while(true){}",
    };
    const result = await verifySandbox(input, executor, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "sandbox") {
      expect(result.error.code).toBe("TIMEOUT");
    }
  });

  test("returns OOM error on memory issue", async () => {
    const executor = mockExecutor({
      execute: async () => ({
        ok: false,
        error: { code: "OOM", message: "out of memory", durationMs: 100 },
      }),
    });
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "new Array(1e9)",
    };
    const result = await verifySandbox(input, executor, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "sandbox") {
      expect(result.error.code).toBe("OOM");
    }
  });

  test("returns PERMISSION error on permission violation", async () => {
    const executor = mockExecutor({
      execute: async () => ({
        ok: false,
        error: { code: "PERMISSION", message: "permission denied", durationMs: 1 },
      }),
    });
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "require('child_process')",
    };
    const result = await verifySandbox(input, executor, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "sandbox") {
      expect(result.error.code).toBe("PERMISSION");
    }
  });

  test("returns CRASH error on generic failure", async () => {
    const executor = mockExecutor({
      execute: async () => ({
        ok: false,
        error: { code: "CRASH", message: "something broke", durationMs: 1 },
      }),
    });
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "throw 'oops'",
    };
    const result = await verifySandbox(input, executor, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "sandbox") {
      expect(result.error.code).toBe("CRASH");
    }
  });

  test("includes durationMs in error", async () => {
    const executor = mockExecutor({
      execute: async () => ({
        ok: false,
        error: { code: "TIMEOUT", message: "timeout exceeded", durationMs: 42 },
      }),
    });
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "x",
    };
    const result = await verifySandbox(input, executor, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "sandbox") {
      expect(result.error.durationMs).toBe(42);
    }
  });
});
