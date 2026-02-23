import { describe, expect, test } from "bun:test";
import {
  createAdversarialVerifiers,
  createExfiltrationVerifier,
  createInjectionVerifier,
  createResourceExhaustionVerifier,
} from "./adversarial-verifiers.js";
import type { ForgeContext, ForgeInput, SandboxExecutor } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CTX: ForgeContext = {
  agentId: "agent-1",
  depth: 0,
  sessionId: "session-1",
  forgesThisSession: 0,
};

function safeToolInput(impl?: string): ForgeInput {
  return {
    kind: "tool",
    name: "safeTool",
    description: "A safe tool",
    inputSchema: { type: "object" },
    implementation: impl ?? "return { result: 'ok' };",
  };
}

function skillInput(): ForgeInput {
  return {
    kind: "skill",
    name: "mySkill",
    description: "A skill",
    body: "# Hello",
  };
}

/** Executor that returns input as output (echo). */
function echoExecutor(): SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => ({
      ok: true as const,
      value: { output: input, durationMs: 1 },
    }),
  };
}

/** Executor that returns a fixed output. */
function fixedExecutor(output: unknown): SandboxExecutor {
  return {
    execute: async (_code, _input, _timeout) => ({
      ok: true as const,
      value: { output, durationMs: 1 },
    }),
  };
}

/** Executor that always times out. */
function timeoutExecutor(): SandboxExecutor {
  return {
    execute: async (_code, _input, _timeout) => ({
      ok: false as const,
      error: { code: "TIMEOUT" as const, message: "timed out", durationMs: 5000 },
    }),
  };
}

/** Executor that always OOMs. */
function oomExecutor(): SandboxExecutor {
  return {
    execute: async (_code, _input, _timeout) => ({
      ok: false as const,
      error: { code: "OOM" as const, message: "out of memory", durationMs: 100 },
    }),
  };
}

/** Executor that crashes. */
function crashExecutor(): SandboxExecutor {
  return {
    execute: async (_code, _input, _timeout) => ({
      ok: false as const,
      error: { code: "CRASH" as const, message: "crash", durationMs: 1 },
    }),
  };
}

// ---------------------------------------------------------------------------
// Injection verifier
// ---------------------------------------------------------------------------

describe("createInjectionVerifier", () => {
  test("passes when tool returns clean output", async () => {
    const verifier = createInjectionVerifier(fixedExecutor({ result: "clean" }));
    const result = await verifier.verify(safeToolInput(), CTX);
    expect(result.passed).toBe(true);
  });

  test("fails when tool returns proto-polluted output", async () => {
    const verifier = createInjectionVerifier(fixedExecutor({ polluted: true }));
    const result = await verifier.verify(safeToolInput(), CTX);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("prototype pollution");
  });

  test("passes when tool crashes on injection (sandbox caught it)", async () => {
    const verifier = createInjectionVerifier(crashExecutor());
    const result = await verifier.verify(safeToolInput(), CTX);
    expect(result.passed).toBe(true);
  });

  test("skips for non-tool inputs", async () => {
    const verifier = createInjectionVerifier(echoExecutor());
    const result = await verifier.verify(skillInput(), CTX);
    expect(result.passed).toBe(true);
    expect(result.message).toContain("Skipped");
  });

  test("detects nested proto pollution", async () => {
    const verifier = createInjectionVerifier(
      fixedExecutor({ data: { nested: { polluted: true } } }),
    );
    const result = await verifier.verify(safeToolInput(), CTX);
    expect(result.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Resource exhaustion verifier
// ---------------------------------------------------------------------------

describe("createResourceExhaustionVerifier", () => {
  test("passes when tool handles large inputs gracefully", async () => {
    const verifier = createResourceExhaustionVerifier(fixedExecutor({ result: "ok" }));
    const result = await verifier.verify(safeToolInput(), CTX);
    expect(result.passed).toBe(true);
  });

  test("fails when tool OOMs on large input", async () => {
    const verifier = createResourceExhaustionVerifier(oomExecutor());
    const result = await verifier.verify(safeToolInput(), CTX);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("OOM");
  });

  test("fails when tool times out on large input", async () => {
    const verifier = createResourceExhaustionVerifier(timeoutExecutor());
    const result = await verifier.verify(safeToolInput(), CTX);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("TIMEOUT");
  });

  test("passes when tool crashes (sandbox caught it)", async () => {
    const verifier = createResourceExhaustionVerifier(crashExecutor());
    const result = await verifier.verify(safeToolInput(), CTX);
    expect(result.passed).toBe(true);
  });

  test("skips for non-tool inputs", async () => {
    const verifier = createResourceExhaustionVerifier(echoExecutor());
    const result = await verifier.verify(skillInput(), CTX);
    expect(result.passed).toBe(true);
    expect(result.message).toContain("Skipped");
  });
});

// ---------------------------------------------------------------------------
// Exfiltration verifier
// ---------------------------------------------------------------------------

describe("createExfiltrationVerifier", () => {
  test("passes when tool does not leak sensitive input", async () => {
    const verifier = createExfiltrationVerifier(fixedExecutor({ result: "clean" }));
    const result = await verifier.verify(safeToolInput(), CTX);
    expect(result.passed).toBe(true);
  });

  test("fails when tool echoes secret values", async () => {
    // Echo executor returns input as output — leaks secrets
    const verifier = createExfiltrationVerifier(echoExecutor());
    const result = await verifier.verify(safeToolInput(), CTX);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("Exfiltration detected");
  });

  test("fails when output contains sensitive patterns", async () => {
    const verifier = createExfiltrationVerifier(
      fixedExecutor({ data: "Bearer eyJhbGciOiJIUzI1NiJ9.test" }),
    );
    const result = await verifier.verify(safeToolInput(), CTX);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("sensitive pattern");
  });

  test("fails when output contains password pattern", async () => {
    const verifier = createExfiltrationVerifier(
      fixedExecutor({ config: "password: my_secret_123" }),
    );
    const result = await verifier.verify(safeToolInput(), CTX);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("sensitive pattern");
  });

  test("skips for non-tool inputs", async () => {
    const verifier = createExfiltrationVerifier(echoExecutor());
    const result = await verifier.verify(skillInput(), CTX);
    expect(result.passed).toBe(true);
    expect(result.message).toContain("Skipped");
  });

  test("passes when tool crashes (no output to check)", async () => {
    const verifier = createExfiltrationVerifier(crashExecutor());
    const result = await verifier.verify(safeToolInput(), CTX);
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createAdversarialVerifiers (factory)
// ---------------------------------------------------------------------------

describe("createAdversarialVerifiers", () => {
  test("returns 3 verifiers", () => {
    const verifiers = createAdversarialVerifiers(echoExecutor());
    expect(verifiers).toHaveLength(3);
  });

  test("all verifiers have unique names", () => {
    const verifiers = createAdversarialVerifiers(echoExecutor());
    const names = verifiers.map((v) => v.name);
    expect(new Set(names).size).toBe(3);
  });

  test("verifier names follow adversarial: prefix", () => {
    const verifiers = createAdversarialVerifiers(echoExecutor());
    for (const v of verifiers) {
      expect(v.name).toMatch(/^adversarial:/);
    }
  });
});
