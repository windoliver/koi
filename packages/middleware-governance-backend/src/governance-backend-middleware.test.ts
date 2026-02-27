import { describe, expect, test } from "bun:test";
import { agentId } from "@koi/core";
import type {
  GovernanceBackend,
  GovernanceBackendEvent,
  GovernanceVerdict,
} from "@koi/core/governance-backend";
import { governanceAttestationId } from "@koi/core/governance-backend";
import {
  createMockSessionContext,
  createMockTurnContext,
  createSpyModelHandler,
  createSpyToolHandler,
} from "@koi/test-utils";
import { createGovernanceBackendMiddleware } from "./governance-backend-middleware.js";

// ---------------------------------------------------------------------------
// Minimal GovernanceBackend test implementations
// ---------------------------------------------------------------------------

function makeAllowBackend(): GovernanceBackend {
  return {
    evaluate: async (): Promise<GovernanceVerdict> => ({ ok: true }),
    checkConstraint: async () => true,
    recordAttestation: async () => ({
      ok: true,
      value: {
        id: governanceAttestationId("test-id"),
        agentId: agentId("agent"),
        ruleId: "governance-backend",
        verdict: { ok: true },
        attestedAt: Date.now(),
        attestedBy: "test",
      },
    }),
    getViolations: async () => ({ ok: true, value: [] }),
  };
}

function makeDenyBackend(messages: readonly string[]): GovernanceBackend {
  return {
    evaluate: async (): Promise<GovernanceVerdict> => ({
      ok: false,
      violations: messages.map((message) => ({
        rule: "test-rule",
        severity: "critical" as const,
        message,
      })),
    }),
    checkConstraint: async () => false,
    recordAttestation: async () => ({
      ok: true,
      value: {
        id: governanceAttestationId("test-id"),
        agentId: agentId("agent"),
        ruleId: "governance-backend",
        verdict: { ok: false, violations: [] },
        attestedAt: Date.now(),
        attestedBy: "test",
      },
    }),
    getViolations: async () => ({ ok: true, value: [] }),
  };
}

function makeThrowingBackend(): GovernanceBackend {
  return {
    evaluate: async (): Promise<GovernanceVerdict> => {
      throw new Error("backend unreachable");
    },
    checkConstraint: async () => {
      throw new Error("backend unreachable");
    },
    recordAttestation: async () => ({
      ok: true,
      value: {
        id: governanceAttestationId("test-id"),
        agentId: agentId("agent"),
        ruleId: "governance-backend",
        verdict: { ok: true },
        attestedAt: Date.now(),
        attestedBy: "test",
      },
    }),
    getViolations: async () => ({ ok: true, value: [] }),
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
    const violations: Array<{ verdict: GovernanceVerdict; event: GovernanceBackendEvent }> = [];
    const onViolation = (verdict: GovernanceVerdict, event: GovernanceBackendEvent) => {
      violations.push({ verdict, event });
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
    expect(violations[0]?.event.kind).toBe("tool_call");
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
});
