import { describe, expect, test } from "bun:test";
import { createDefaultForgeConfig } from "./config.js";
import type { ForgeContext, ForgeInput, ForgeVerifier, SandboxExecutor } from "./types.js";
import { verify } from "./verify.js";

const DEFAULT_CONTEXT: ForgeContext = {
  agentId: "agent-1",
  depth: 0,
  sessionId: "session-1",
  forgesThisSession: 0,
};

function mockExecutor(): SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => ({
      ok: true,
      value: { output: input, durationMs: 1 },
    }),
  };
}

const validToolInput: ForgeInput = {
  kind: "tool",
  name: "myTool",
  description: "A test tool",
  inputSchema: { type: "object" },
  implementation: "function run(input) { return input; }",
};

describe("verify — full pipeline", () => {
  test("succeeds for valid tool input", async () => {
    const config = createDefaultForgeConfig();
    const result = await verify(validToolInput, DEFAULT_CONTEXT, mockExecutor(), [], config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.passed).toBe(true);
      expect(result.value.stages).toHaveLength(4);
      expect(result.value.finalTrustTier).toBe("sandbox");
      expect(result.value.totalDurationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("succeeds for valid skill input", async () => {
    const config = createDefaultForgeConfig();
    const input: ForgeInput = {
      kind: "skill",
      name: "mySkill",
      description: "A skill",
      content: "# Skill content",
    };
    const result = await verify(input, DEFAULT_CONTEXT, mockExecutor(), [], config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.passed).toBe(true);
      expect(result.value.stages).toHaveLength(4);
    }
  });

  test("early-terminates on static validation failure", async () => {
    const config = createDefaultForgeConfig();
    const input: ForgeInput = {
      kind: "tool",
      name: "x", // too short
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return 1;",
    };
    const result = await verify(input, DEFAULT_CONTEXT, mockExecutor(), [], config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("static");
    }
  });

  test("early-terminates on sandbox failure", async () => {
    const config = createDefaultForgeConfig();
    const executor: SandboxExecutor = {
      execute: async () => ({
        ok: false,
        error: { code: "TIMEOUT", message: "timeout", durationMs: 5000 },
      }),
    };
    const result = await verify(validToolInput, DEFAULT_CONTEXT, executor, [], config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("sandbox");
    }
  });

  test("early-terminates on self-test failure", async () => {
    const config = createDefaultForgeConfig();
    const verifier: ForgeVerifier = {
      name: "reject",
      verify: async () => ({ passed: false, message: "nope" }),
    };
    const result = await verify(
      validToolInput,
      DEFAULT_CONTEXT,
      mockExecutor(),
      [verifier],
      config,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("self_test");
    }
  });
});

describe("verify — pipeline timeout", () => {
  test("aborts when totalTimeoutMs is exceeded between stages", async () => {
    // Use a slow executor that takes longer than the total timeout
    const slowExecutor: SandboxExecutor = {
      execute: async (_code, input, _timeout) => {
        // Simulate slow sandbox — block for longer than the total timeout
        const start = performance.now();
        while (performance.now() - start < 50) {
          // busy wait
        }
        return { ok: true, value: { output: input, durationMs: 50 } };
      },
    };

    // Set a very short total timeout so the pipeline timeout fires after sandbox
    const config = createDefaultForgeConfig({
      verification: {
        staticTimeoutMs: 1_000,
        sandboxTimeoutMs: 5_000,
        selfTestTimeoutMs: 10_000,
        totalTimeoutMs: 10, // 10ms total — sandbox alone takes 50ms
        maxBrickSizeBytes: 50_000,
      },
    });

    const result = await verify(validToolInput, DEFAULT_CONTEXT, slowExecutor, [], config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("sandbox");
      if (result.error.stage === "sandbox") {
        expect(result.error.code).toBe("TIMEOUT");
      }
    }
  });
});

describe("verify — timing", () => {
  test("reports total duration covering all stages", async () => {
    const config = createDefaultForgeConfig();
    const result = await verify(validToolInput, DEFAULT_CONTEXT, mockExecutor(), [], config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(result.value.stages).toHaveLength(4);
    }
  });
});

// ---------------------------------------------------------------------------
// Error accumulation — verify every stage reports complete error fields
// ---------------------------------------------------------------------------

describe("verify — error field completeness", () => {
  test("static error includes stage, code, and message", async () => {
    const config = createDefaultForgeConfig();
    const input: ForgeInput = {
      kind: "tool",
      name: "x", // too short → INVALID_NAME
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return 1;",
    };
    const result = await verify(input, DEFAULT_CONTEXT, mockExecutor(), [], config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("static");
      if (result.error.stage === "static") {
        expect(result.error.code).toBe("INVALID_NAME");
        expect(result.error.message.length).toBeGreaterThan(0);
      }
    }
  });

  test("sandbox error includes stage, code, message, and durationMs", async () => {
    const config = createDefaultForgeConfig();
    const executor: SandboxExecutor = {
      execute: async () => ({
        ok: false,
        error: { code: "CRASH", message: "segfault", durationMs: 123 },
      }),
    };
    const result = await verify(validToolInput, DEFAULT_CONTEXT, executor, [], config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("sandbox");
      if (result.error.stage === "sandbox") {
        expect(result.error.code).toBe("CRASH");
        expect(result.error.message.length).toBeGreaterThan(0);
        expect(result.error.durationMs).toBe(123);
      }
    }
  });

  test("self-test error includes failures array with test details", async () => {
    const config = createDefaultForgeConfig();
    const executor: SandboxExecutor = {
      execute: async (_code, _input, _timeout) => ({
        ok: true,
        value: { output: 99, durationMs: 1 },
      }),
    };
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A test tool",
      inputSchema: { type: "object" },
      implementation: "return 99;",
      testCases: [
        { name: "expects 42", input: {}, expectedOutput: 42 },
        { name: "expects 0", input: {}, expectedOutput: 0 },
      ],
    };
    const result = await verify(input, DEFAULT_CONTEXT, executor, [], config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("self_test");
      if (result.error.stage === "self_test") {
        expect(result.error.code).toBe("TEST_FAILED");
        expect(result.error.failures).toBeDefined();
        expect(result.error.failures?.length).toBeGreaterThanOrEqual(1);
        const failure = result.error.failures?.[0];
        expect(failure).toBeDefined();
        if (failure !== undefined) {
          expect(failure.testName).toBe("expects 42");
          expect(failure.expected).toBe(42);
          expect(failure.actual).toBe(99);
        }
      }
    }
  });

  test("verifier rejection includes verifier name in message", async () => {
    const config = createDefaultForgeConfig();
    const verifier: ForgeVerifier = {
      name: "safety-check",
      verify: async () => ({ passed: false, message: "unsafe code detected" }),
    };
    const result = await verify(
      validToolInput,
      DEFAULT_CONTEXT,
      mockExecutor(),
      [verifier],
      config,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("self_test");
      if (result.error.stage === "self_test") {
        expect(result.error.code).toBe("VERIFIER_REJECTED");
        expect(result.error.message).toContain("safety-check");
      }
    }
  });

  test("trust error includes stage and code when prior stage failed", async () => {
    // assignTrust itself rejects when a prior stage has passed=false.
    // This path is normally unreachable via verify() since verify() early-terminates,
    // but we test the trust error factory to ensure completeness.
    const config = createDefaultForgeConfig();
    const { assignTrust } = await import("./verify-trust.js");
    const failedStages = [
      { stage: "static" as const, passed: true, durationMs: 1 },
      { stage: "sandbox" as const, passed: false, durationMs: 2, message: "boom" },
    ];
    const result = assignTrust(validToolInput, config, failedStages);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("trust");
      if (result.error.stage === "trust") {
        expect(result.error.code).toBeDefined();
        expect(result.error.message.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("verify — stage ordering", () => {
  test("on success, stages are ordered static → sandbox → self_test → trust", async () => {
    const config = createDefaultForgeConfig();
    const result = await verify(validToolInput, DEFAULT_CONTEXT, mockExecutor(), [], config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const stageNames = result.value.stages.map((s) => s.stage);
      expect(stageNames).toEqual(["static", "sandbox", "self_test", "trust"]);
    }
  });

  test("sandbox failure stops pipeline — only static stage is reported as passed", async () => {
    const config = createDefaultForgeConfig();
    const executor: SandboxExecutor = {
      execute: async () => ({
        ok: false,
        error: { code: "OOM", message: "out of memory", durationMs: 10 },
      }),
    };
    const result = await verify(validToolInput, DEFAULT_CONTEXT, executor, [], config);
    // Pipeline should early-terminate — we don't get stages 3 and 4
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("sandbox");
    }
  });

  test("self-test failure stops pipeline — trust stage never runs", async () => {
    const config = createDefaultForgeConfig();
    const verifier: ForgeVerifier = {
      name: "blocker",
      verify: async () => ({ passed: false, message: "blocked" }),
    };
    const result = await verify(
      validToolInput,
      DEFAULT_CONTEXT,
      mockExecutor(),
      [verifier],
      config,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("self_test");
    }
  });

  test("each stage has non-negative durationMs", async () => {
    const config = createDefaultForgeConfig();
    const result = await verify(validToolInput, DEFAULT_CONTEXT, mockExecutor(), [], config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const stage of result.value.stages) {
        expect(stage.durationMs).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
