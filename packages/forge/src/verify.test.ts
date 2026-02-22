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
        failFast: true,
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
