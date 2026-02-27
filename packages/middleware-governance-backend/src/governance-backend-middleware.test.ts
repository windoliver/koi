import { describe, expect, test } from "bun:test";
import type {
  GovernanceBackend,
  GovernanceVerdict,
  PolicyRequest,
} from "@koi/core/governance-backend";
import {
  createMockSessionContext,
  createMockTurnContext,
  createSpyModelHandler,
  createSpyToolHandler,
} from "@koi/test-utils";
import { validateGovernanceBackendConfig } from "./config.js";
import { createGovernanceBackendMiddleware } from "./governance-backend-middleware.js";

// ---------------------------------------------------------------------------
// Minimal GovernanceBackend test implementations
// ---------------------------------------------------------------------------

function makeAllowBackend(): GovernanceBackend {
  return {
    evaluator: { evaluate: async (): Promise<GovernanceVerdict> => ({ ok: true }) },
  };
}

function makeDenyBackend(messages: readonly string[]): GovernanceBackend {
  return {
    evaluator: {
      evaluate: async (): Promise<GovernanceVerdict> => ({
        ok: false,
        violations: messages.map((message) => ({
          rule: "test-rule",
          severity: "critical" as const,
          message,
        })),
      }),
    },
  };
}

function makeThrowingBackend(): GovernanceBackend {
  return {
    evaluator: {
      evaluate: async (): Promise<GovernanceVerdict> => {
        throw new Error("backend unreachable");
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createGovernanceBackendMiddleware", () => {
  const ctx = createMockTurnContext();
  const sessionCtx = createMockSessionContext();

  test("has name 'koi:governance-backend'", () => {
    const mw = createGovernanceBackendMiddleware({ backend: makeAllowBackend() });
    expect(mw.name).toBe("koi:governance-backend");
  });

  test("has priority 150", () => {
    const mw = createGovernanceBackendMiddleware({ backend: makeAllowBackend() });
    expect(mw.priority).toBe(150);
  });

  // ── wrapModelCall ──────────────────────────────────────────────────────

  test("wrapModelCall: allows when evaluate() returns ok:true", async () => {
    const mw = createGovernanceBackendMiddleware({ backend: makeAllowBackend() });
    const spy = createSpyModelHandler();
    const response = await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
    expect(spy.calls).toHaveLength(1);
    expect(response).toBeDefined();
  });

  test("wrapModelCall: throws when evaluate() returns ok:false (fail-closed)", async () => {
    const mw = createGovernanceBackendMiddleware({
      backend: makeDenyBackend(["policy A", "policy B"]),
    });
    const spy = createSpyModelHandler();
    try {
      await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(spy.calls).toHaveLength(0);
      expect((e as Error).message).toContain("policy A");
      expect((e as Error).message).toContain("policy B");
    }
  });

  test("wrapModelCall: throws when evaluate() throws (fail-closed)", async () => {
    const mw = createGovernanceBackendMiddleware({ backend: makeThrowingBackend() });
    const spy = createSpyModelHandler();
    try {
      await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(spy.calls).toHaveLength(0);
      expect((e as Error).message).toContain("backend unreachable");
    }
  });

  // ── wrapToolCall ───────────────────────────────────────────────────────

  test("wrapToolCall: allows when evaluate() returns ok:true", async () => {
    const mw = createGovernanceBackendMiddleware({ backend: makeAllowBackend() });
    const spy = createSpyToolHandler();
    const response = await mw.wrapToolCall?.(ctx, { toolId: "my_tool", input: {} }, spy.handler);
    expect(spy.calls).toHaveLength(1);
    expect(response).toBeDefined();
  });

  test("wrapToolCall: throws when evaluate() returns ok:false (fail-closed)", async () => {
    const mw = createGovernanceBackendMiddleware({ backend: makeDenyBackend(["denied tool"]) });
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, { toolId: "my_tool", input: {} }, spy.handler);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(spy.calls).toHaveLength(0);
      expect((e as Error).message).toContain("denied tool");
    }
  });

  test("wrapToolCall: throws when evaluate() throws (fail-closed)", async () => {
    const mw = createGovernanceBackendMiddleware({ backend: makeThrowingBackend() });
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, { toolId: "my_tool", input: {} }, spy.handler);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(spy.calls).toHaveLength(0);
      expect((e as Error).message).toContain("backend unreachable");
    }
  });

  // ── onViolation callback ───────────────────────────────────────────────

  test("onViolation callback fires on violation verdict", async () => {
    const violations: Array<{ verdict: GovernanceVerdict; request: PolicyRequest }> = [];
    const onViolation = (verdict: GovernanceVerdict, request: PolicyRequest) => {
      violations.push({ verdict, request });
    };
    const mw = createGovernanceBackendMiddleware({
      backend: makeDenyBackend(["violating rule"]),
      onViolation,
    });
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, { toolId: "my_tool", input: {} }, spy.handler);
    } catch {
      // expected
    }
    expect(violations).toHaveLength(1);
    expect(violations[0]?.request.kind).toBe("tool_call");
    if (violations[0] !== undefined && !violations[0].verdict.ok) {
      expect(violations[0].verdict.violations[0]?.message).toBe("violating rule");
    }
  });

  test("onViolation callback does NOT fire on success", async () => {
    const violations: unknown[] = [];
    const mw = createGovernanceBackendMiddleware({
      backend: makeAllowBackend(),
      onViolation: () => {
        violations.push(true);
      },
    });
    const spy = createSpyToolHandler();
    await mw.wrapToolCall?.(ctx, { toolId: "my_tool", input: {} }, spy.handler);
    expect(violations).toHaveLength(0);
  });

  // ── dispose on session end ─────────────────────────────────────────────

  test("onSessionEnd calls backend.dispose() when provided", async () => {
    let disposed = false;
    const backendWithDispose: GovernanceBackend = {
      ...makeAllowBackend(),
      dispose: async () => {
        disposed = true;
      },
    };
    const mw = createGovernanceBackendMiddleware({ backend: backendWithDispose });
    await mw.onSessionEnd?.(sessionCtx);
    expect(disposed).toBe(true);
  });

  test("onSessionEnd does not throw when backend.dispose is absent", async () => {
    const mw = createGovernanceBackendMiddleware({ backend: makeAllowBackend() });
    // Should not throw
    await mw.onSessionEnd?.(sessionCtx);
  });

  // ── error message content ──────────────────────────────────────────────

  test("violation error message includes 'Governance policy violation:' prefix", async () => {
    const mw = createGovernanceBackendMiddleware({ backend: makeDenyBackend(["rule X violated"]) });
    try {
      await mw.wrapModelCall?.(ctx, { messages: [] }, createSpyModelHandler().handler);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect((e as Error).message).toMatch(/^Governance policy violation:/);
    }
  });

  test("violation error message joins multiple violation messages with '; '", async () => {
    const mw = createGovernanceBackendMiddleware({
      backend: makeDenyBackend(["first", "second", "third"]),
    });
    try {
      await mw.wrapModelCall?.(ctx, { messages: [] }, createSpyModelHandler().handler);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect((e as Error).message).toContain("first; second; third");
    }
  });

  // ── wrapModelStream ────────────────────────────────────────────────────

  describe("wrapModelStream", () => {
    function streamOf(
      mw: ReturnType<typeof createGovernanceBackendMiddleware>,
    ): NonNullable<(typeof mw)["wrapModelStream"]> {
      const fn = mw.wrapModelStream;
      if (!fn) throw new Error("wrapModelStream not defined");
      return fn;
    }

    test("allows stream when evaluate() returns ok:true", async () => {
      const mw = createGovernanceBackendMiddleware({ backend: makeAllowBackend() });
      const chunks: unknown[] = [];
      for await (const chunk of streamOf(mw)(ctx, { messages: [] }, () => ({
        async *[Symbol.asyncIterator]() {
          yield { kind: "text_delta" as const, delta: "hi" };
        },
      }))) {
        chunks.push(chunk);
      }
      expect(chunks).toHaveLength(1);
    });

    test("throws before stream when evaluate() returns ok:false", async () => {
      const mw = createGovernanceBackendMiddleware({
        backend: makeDenyBackend(["stream denied"]),
      });
      try {
        for await (const _ of streamOf(mw)(ctx, { messages: [] }, () => ({
          async *[Symbol.asyncIterator]() {
            yield { kind: "text_delta" as const, delta: "never" };
          },
        }))) {
          // should not get here
        }
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect((e as Error).message).toContain("stream denied");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// validateGovernanceBackendConfig
// ---------------------------------------------------------------------------

describe("validateGovernanceBackendConfig", () => {
  test("returns error when config is null", () => {
    const result = validateGovernanceBackendConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("returns error when config is not an object", () => {
    const result = validateGovernanceBackendConfig("string");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("returns error when backend is missing", () => {
    const result = validateGovernanceBackendConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("returns error when backend has no evaluator", () => {
    const result = validateGovernanceBackendConfig({ backend: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("evaluator");
  });

  test("returns error when evaluator is not an object", () => {
    const result = validateGovernanceBackendConfig({ backend: { evaluator: 42 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("returns error when onViolation is not a function", () => {
    const result = validateGovernanceBackendConfig({
      backend: { evaluator: { evaluate: () => ({ ok: true }) } },
      onViolation: "not a function",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("onViolation");
  });

  test("succeeds with minimal valid config", () => {
    const result = validateGovernanceBackendConfig({
      backend: { evaluator: { evaluate: () => ({ ok: true }) } },
    });
    expect(result.ok).toBe(true);
  });

  test("succeeds with onViolation function", () => {
    const result = validateGovernanceBackendConfig({
      backend: { evaluator: { evaluate: () => ({ ok: true }) } },
      onViolation: () => undefined,
    });
    expect(result.ok).toBe(true);
  });
});
