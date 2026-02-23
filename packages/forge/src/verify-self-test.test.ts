import { describe, expect, test } from "bun:test";
import type { VerificationConfig } from "./config.js";
import type { ForgeContext, ForgeInput, ForgeVerifier, SandboxExecutor } from "./types.js";
import { verifySelfTest } from "./verify-self-test.js";

const DEFAULT_VERIFICATION: VerificationConfig = {
  staticTimeoutMs: 1_000,
  sandboxTimeoutMs: 5_000,
  selfTestTimeoutMs: 10_000,
  totalTimeoutMs: 30_000,
  maxBrickSizeBytes: 50_000,
  failFast: true,
};

const DEFAULT_CONTEXT: ForgeContext = {
  agentId: "agent-1",
  depth: 0,
  sessionId: "session-1",
  forgesThisSession: 0,
};

function mockExecutor(fn?: SandboxExecutor["execute"]): SandboxExecutor {
  return {
    execute:
      fn ??
      (async (_code, input, _timeout) => ({
        ok: true,
        value: { output: input, durationMs: 1 },
      })),
  };
}

describe("verifySelfTest — test cases", () => {
  test("passes with empty testCases array", async () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return input;",
      testCases: [],
    };
    const result = await verifySelfTest(
      input,
      mockExecutor(),
      [],
      DEFAULT_CONTEXT,
      DEFAULT_VERIFICATION,
    );
    expect(result.ok).toBe(true);
  });

  test("passes when test output matches expectedOutput", async () => {
    const executor = mockExecutor(async () => ({
      ok: true,
      value: { output: 42, durationMs: 1 },
    }));
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return 42;",
      testCases: [{ name: "returns 42", input: {}, expectedOutput: 42 }],
    };
    const result = await verifySelfTest(input, executor, [], DEFAULT_CONTEXT, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
  });

  test("fails when test output does not match expectedOutput", async () => {
    const executor = mockExecutor(async () => ({
      ok: true,
      value: { output: 99, durationMs: 1 },
    }));
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return 99;",
      testCases: [{ name: "expects 42", input: {}, expectedOutput: 42 }],
    };
    const result = await verifySelfTest(input, executor, [], DEFAULT_CONTEXT, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "self_test") {
      expect(result.error.code).toBe("TEST_FAILED");
      expect(result.error.failures).toHaveLength(1);
    }
  });

  test("passes when shouldThrow is true and execution fails", async () => {
    const executor = mockExecutor(async () => ({
      ok: false,
      error: { code: "CRASH", message: "expected failure", durationMs: 1 },
    }));
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "throw new Error('expected');",
      testCases: [{ name: "should throw", input: {}, shouldThrow: true }],
    };
    const result = await verifySelfTest(input, executor, [], DEFAULT_CONTEXT, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
  });

  test("fails when shouldThrow is true but execution succeeds", async () => {
    const executor = mockExecutor(async () => ({
      ok: true,
      value: { output: "ok", durationMs: 1 },
    }));
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return 'ok';",
      testCases: [{ name: "should throw", input: {}, shouldThrow: true }],
    };
    const result = await verifySelfTest(input, executor, [], DEFAULT_CONTEXT, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "self_test") {
      expect(result.error.code).toBe("TEST_FAILED");
    }
  });

  test("fails when execution fails but shouldThrow is not set", async () => {
    const executor = mockExecutor(async () => ({
      ok: false,
      error: { code: "CRASH", message: "unexpected", durationMs: 1 },
    }));
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "throw 'err';",
      testCases: [{ name: "no throw expected", input: {} }],
    };
    const result = await verifySelfTest(input, executor, [], DEFAULT_CONTEXT, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
  });

  test("distinguishes arrays from objects in expectedOutput", async () => {
    const executor = mockExecutor(async () => ({
      ok: true,
      value: { output: [1, 2], durationMs: 1 },
    }));
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return [1, 2];",
      testCases: [{ name: "array vs object", input: {}, expectedOutput: { 0: 1, 1: 2 } }],
    };
    const result = await verifySelfTest(input, executor, [], DEFAULT_CONTEXT, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "self_test") {
      expect(result.error.code).toBe("TEST_FAILED");
    }
  });

  test("passes when arrays match deeply", async () => {
    const executor = mockExecutor(async () => ({
      ok: true,
      value: { output: [1, [2, 3]], durationMs: 1 },
    }));
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return [1, [2, 3]];",
      testCases: [{ name: "nested arrays", input: {}, expectedOutput: [1, [2, 3]] }],
    };
    const result = await verifySelfTest(input, executor, [], DEFAULT_CONTEXT, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
  });

  test("passes without testCases (undefined)", async () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return 1;",
    };
    const result = await verifySelfTest(
      input,
      mockExecutor(),
      [],
      DEFAULT_CONTEXT,
      DEFAULT_VERIFICATION,
    );
    expect(result.ok).toBe(true);
  });
});

describe("verifySelfTest — pluggable verifiers", () => {
  test("passes when verifier approves", async () => {
    const verifier: ForgeVerifier = {
      name: "always-pass",
      verify: async () => ({ passed: true }),
    };
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return 1;",
    };
    const result = await verifySelfTest(
      input,
      mockExecutor(),
      [verifier],
      DEFAULT_CONTEXT,
      DEFAULT_VERIFICATION,
    );
    expect(result.ok).toBe(true);
  });

  test("fails when verifier rejects", async () => {
    const verifier: ForgeVerifier = {
      name: "always-reject",
      verify: async () => ({ passed: false, message: "not allowed" }),
    };
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return 1;",
    };
    const result = await verifySelfTest(
      input,
      mockExecutor(),
      [verifier],
      DEFAULT_CONTEXT,
      DEFAULT_VERIFICATION,
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "self_test") {
      expect(result.error.code).toBe("VERIFIER_REJECTED");
      expect(result.error.message).toContain("always-reject");
    }
  });

  test("runs verifiers in order and stops at first rejection", async () => {
    const calls: string[] = [];
    const v1: ForgeVerifier = {
      name: "v1",
      verify: async () => {
        calls.push("v1");
        return { passed: true };
      },
    };
    const v2: ForgeVerifier = {
      name: "v2",
      verify: async () => {
        calls.push("v2");
        return { passed: false, message: "nope" };
      },
    };
    const v3: ForgeVerifier = {
      name: "v3",
      verify: async () => {
        calls.push("v3");
        return { passed: true };
      },
    };
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return 1;",
    };
    await verifySelfTest(
      input,
      mockExecutor(),
      [v1, v2, v3],
      DEFAULT_CONTEXT,
      DEFAULT_VERIFICATION,
    );
    expect(calls).toEqual(["v1", "v2"]);
  });
});
