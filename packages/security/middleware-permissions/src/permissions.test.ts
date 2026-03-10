import { describe, expect, mock, test } from "bun:test";
import type { KoiError } from "@koi/core/errors";
import type { ModelRequest, SessionContext, ToolRequest } from "@koi/core/middleware";
import type { PermissionBackend, PermissionDecision } from "@koi/core/permission-backend";
import {
  createMockSessionContext,
  createMockTurnContext,
  createSpyModelHandler,
  createSpyToolHandler,
} from "@koi/test-utils";
import type { ApprovalHandler } from "./engine.js";
import { createAutoApprovalHandler, createPatternPermissionBackend } from "./engine.js";
import { createPermissionsMiddleware } from "./permissions.js";

const backend = createPatternPermissionBackend({
  rules: { allow: ["calc", "search"], deny: ["rm"], ask: ["deploy"] },
});

describe("createPermissionsMiddleware", () => {
  const ctx = createMockTurnContext();

  const makeToolRequest = (toolId: string): ToolRequest => ({
    toolId,
    input: {},
  });

  test("has name 'permissions'", () => {
    const mw = createPermissionsMiddleware({ backend });
    expect(mw.name).toBe("permissions");
  });

  test("has priority 100", () => {
    const mw = createPermissionsMiddleware({ backend });
    expect(mw.priority).toBe(100);
  });

  test("allowed tool calls next()", async () => {
    const mw = createPermissionsMiddleware({ backend });
    const spy = createSpyToolHandler();
    const response = await mw.wrapToolCall?.(ctx, makeToolRequest("calc"), spy.handler);
    expect(spy.calls).toHaveLength(1);
    expect(response?.output).toEqual({ result: "mock" });
  });

  test("denied tool does NOT call next()", async () => {
    const mw = createPermissionsMiddleware({ backend });
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("rm"), spy.handler);
      expect.unreachable("should have thrown");
    } catch (_e) {
      expect(spy.calls).toHaveLength(0);
    }
  });

  test("denied tool throws PERMISSION error", async () => {
    const mw = createPermissionsMiddleware({ backend });
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("rm"), spy.handler);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as KoiError;
      expect(err.code).toBe("PERMISSION");
      expect(err.retryable).toBe(false);
      expect(err.context).toEqual({ toolId: "rm" });
    }
  });

  test("ask flow with approval calls next()", async () => {
    const approvalHandler = createAutoApprovalHandler();
    const mw = createPermissionsMiddleware({ backend, approvalHandler });
    const spy = createSpyToolHandler();
    const response = await mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), spy.handler);
    expect(spy.calls).toHaveLength(1);
    expect(response?.output).toEqual({ result: "mock" });
  });

  test("ask flow with denial throws PERMISSION", async () => {
    const denyHandler: ApprovalHandler = {
      requestApproval: async () => false,
    };
    const mw = createPermissionsMiddleware({ backend, approvalHandler: denyHandler });
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), spy.handler);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as KoiError;
      expect(err.code).toBe("PERMISSION");
      expect(spy.calls).toHaveLength(0);
    }
  });

  test("ask flow with timeout throws TIMEOUT", async () => {
    const slowHandler: ApprovalHandler = {
      requestApproval: async () =>
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 5000)),
    };
    const mw = createPermissionsMiddleware({
      backend,
      approvalHandler: slowHandler,
      approvalTimeoutMs: 50,
    });
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), spy.handler);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as KoiError;
      expect(err.code).toBe("TIMEOUT");
      expect(err.retryable).toBe(true);
      expect(spy.calls).toHaveLength(0);
    }
  });

  test("approval cleans up timeout timer (no leak)", async () => {
    const fastHandler: ApprovalHandler = {
      requestApproval: async () => true,
    };
    const mw = createPermissionsMiddleware({
      backend,
      approvalHandler: fastHandler,
      approvalTimeoutMs: 60_000,
    });
    const spy = createSpyToolHandler();
    const response = await mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), spy.handler);
    expect(spy.calls).toHaveLength(1);
    expect(response?.output).toEqual({ result: "mock" });
  });

  test("defaultDeny backend blocks unmatched tools", async () => {
    const denyBackend = createPatternPermissionBackend({
      rules: { allow: [], deny: [], ask: [] },
    });
    const mw = createPermissionsMiddleware({ backend: denyBackend });
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("unknown"), spy.handler);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as KoiError;
      expect(err.code).toBe("PERMISSION");
    }
  });

  test("wildcard allow passes all tools", async () => {
    const allowAll = createPatternPermissionBackend({
      rules: { allow: ["*"], deny: [], ask: [] },
    });
    const mw = createPermissionsMiddleware({ backend: allowAll });
    const spy = createSpyToolHandler();
    await mw.wrapToolCall?.(ctx, makeToolRequest("anything"), spy.handler);
    expect(spy.calls).toHaveLength(1);
  });

  test("prefix wildcard in deny blocks matching tools", async () => {
    const denyFs = createPatternPermissionBackend({
      rules: { allow: ["*"], deny: ["fs:*"], ask: [] },
    });
    const mw = createPermissionsMiddleware({ backend: denyFs });
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("fs:delete"), spy.handler);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as KoiError;
      expect(err.code).toBe("PERMISSION");
    }
  });

  test("ask without approvalHandler throws PERMISSION", async () => {
    const mw = createPermissionsMiddleware({ backend /* no approvalHandler */ });
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), spy.handler);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as KoiError;
      expect(err.code).toBe("PERMISSION");
      expect(err.message).toContain("No approval handler");
    }
  });

  test("passes original request to next()", async () => {
    const mw = createPermissionsMiddleware({ backend });
    const spy = createSpyToolHandler();
    const request = makeToolRequest("calc");
    await mw.wrapToolCall?.(ctx, request, spy.handler);
    expect(spy.calls[0]).toBe(request);
  });
});

// ---------------------------------------------------------------------------
// wrapModelCall — tool filtering
// ---------------------------------------------------------------------------

describe("wrapModelCall", () => {
  const ctx = createMockTurnContext();

  const makeModelRequest = (toolNames: readonly string[]): ModelRequest => ({
    messages: [],
    tools: toolNames.map((name) => ({
      name,
      description: `Tool ${name}`,
      inputSchema: {},
    })),
  });

  test("filters denied tools from model request", async () => {
    const mw = createPermissionsMiddleware({ backend });
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, makeModelRequest(["calc", "rm", "deploy"]), spy.handler);

    expect(spy.calls).toHaveLength(1);
    const passedTools = spy.calls[0]?.tools ?? [];
    const toolNames = passedTools.map((t) => t.name);
    expect(toolNames).toContain("calc");
    expect(toolNames).toContain("deploy"); // "ask" tools are kept
    expect(toolNames).not.toContain("rm"); // "deny" tools are filtered
  });

  test("passes through when no tools in request", async () => {
    const mw = createPermissionsMiddleware({ backend });
    const spy = createSpyModelHandler();
    const request: ModelRequest = { messages: [] };
    await mw.wrapModelCall?.(ctx, request, spy.handler);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.tools).toBeUndefined();
  });

  test("passes through when tools array is empty", async () => {
    const mw = createPermissionsMiddleware({ backend });
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, makeModelRequest([]), spy.handler);
    expect(spy.calls).toHaveLength(1);
  });

  test("uses checkBatch when available", async () => {
    const batchFn = mock((queries: readonly { readonly resource: string }[]) =>
      queries.map((q) =>
        q.resource === "rm"
          ? ({ effect: "deny", reason: "no" } as PermissionDecision)
          : ({ effect: "allow" } as PermissionDecision),
      ),
    );
    const batchBackend: PermissionBackend = {
      check: () => ({ effect: "allow" }),
      checkBatch: batchFn,
    };
    const mw = createPermissionsMiddleware({ backend: batchBackend });
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, makeModelRequest(["calc", "rm"]), spy.handler);

    expect(batchFn).toHaveBeenCalledTimes(1);
    const passedTools = spy.calls[0]?.tools ?? [];
    expect(passedTools.map((t) => t.name)).toEqual(["calc"]);
  });
});

// ---------------------------------------------------------------------------
// Decision cache
// ---------------------------------------------------------------------------

describe("decision cache", () => {
  const ctx = createMockTurnContext();

  const makeToolRequest = (toolId: string): ToolRequest => ({
    toolId,
    input: {},
  });

  test("caches allow decisions — second call skips backend", async () => {
    const checkFn = mock(() => ({ effect: "allow" }) as PermissionDecision);
    const mockBackend: PermissionBackend = { check: checkFn };
    const mw = createPermissionsMiddleware({ backend: mockBackend, cache: true });
    const spy = createSpyToolHandler();

    await mw.wrapToolCall?.(ctx, makeToolRequest("calc"), spy.handler);
    await mw.wrapToolCall?.(ctx, makeToolRequest("calc"), spy.handler);

    expect(checkFn).toHaveBeenCalledTimes(1);
    expect(spy.calls).toHaveLength(2);
  });

  test("cache disabled by default", async () => {
    const checkFn = mock(() => ({ effect: "allow" }) as PermissionDecision);
    const mockBackend: PermissionBackend = { check: checkFn };
    const mw = createPermissionsMiddleware({ backend: mockBackend });
    const spy = createSpyToolHandler();

    await mw.wrapToolCall?.(ctx, makeToolRequest("calc"), spy.handler);
    await mw.wrapToolCall?.(ctx, makeToolRequest("calc"), spy.handler);

    expect(checkFn).toHaveBeenCalledTimes(2);
  });

  test("different resources get separate cache entries", async () => {
    const checkFn = mock(() => ({ effect: "allow" }) as PermissionDecision);
    const mockBackend: PermissionBackend = { check: checkFn };
    const mw = createPermissionsMiddleware({ backend: mockBackend, cache: true });
    const spy = createSpyToolHandler();

    await mw.wrapToolCall?.(ctx, makeToolRequest("calc"), spy.handler);
    await mw.wrapToolCall?.(ctx, makeToolRequest("search"), spy.handler);

    expect(checkFn).toHaveBeenCalledTimes(2);
  });

  test("cache expires after TTL using injected clock", async () => {
    let now = 1000;
    const checkFn = mock(() => ({ effect: "allow" }) as PermissionDecision);
    const mockBackend: PermissionBackend = { check: checkFn };
    const mw = createPermissionsMiddleware({
      backend: mockBackend,
      cache: { allowTtlMs: 500 },
      clock: () => now,
    });
    const spy = createSpyToolHandler();

    await mw.wrapToolCall?.(ctx, makeToolRequest("calc"), spy.handler);
    expect(checkFn).toHaveBeenCalledTimes(1);

    // Still within TTL — should use cache
    now = 1400;
    await mw.wrapToolCall?.(ctx, makeToolRequest("calc"), spy.handler);
    expect(checkFn).toHaveBeenCalledTimes(1);

    // Past TTL — cache miss, calls backend again
    now = 1600;
    await mw.wrapToolCall?.(ctx, makeToolRequest("calc"), spy.handler);
    expect(checkFn).toHaveBeenCalledTimes(2);
  });

  test("does not cache 'ask' decisions", async () => {
    const checkFn = mock(() => ({ effect: "ask", reason: "needs approval" }) as PermissionDecision);
    const mockBackend: PermissionBackend = { check: checkFn };
    const approvalHandler = createAutoApprovalHandler();
    const mw = createPermissionsMiddleware({
      backend: mockBackend,
      approvalHandler,
      cache: true,
    });
    const spy = createSpyToolHandler();

    await mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), spy.handler);
    await mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), spy.handler);

    // Should call backend both times since "ask" is not cached in decision cache
    expect(checkFn).toHaveBeenCalledTimes(2);
  });

  test("batch (wrapModelCall) uses cache for already-cached tools", async () => {
    const checkFn = mock(
      (q: { readonly resource: string }) =>
        ({ effect: q.resource === "rm" ? "deny" : "allow" }) as PermissionDecision,
    );
    const mockBackend: PermissionBackend = { check: checkFn };
    const mw = createPermissionsMiddleware({ backend: mockBackend, cache: true });
    const spy = createSpyToolHandler();

    // Prime cache via individual wrapToolCall
    await mw.wrapToolCall?.(ctx, makeToolRequest("calc"), spy.handler);
    expect(checkFn).toHaveBeenCalledTimes(1);

    // Now batch via wrapModelCall — "calc" should come from cache
    const modelSpy = createSpyModelHandler();
    const request: ModelRequest = {
      messages: [],
      tools: [
        { name: "calc", description: "calc", inputSchema: {} },
        { name: "search", description: "search", inputSchema: {} },
      ],
    };
    await mw.wrapModelCall?.(ctx, request, modelSpy.handler);

    // Only "search" should hit the backend (calc was cached)
    expect(checkFn).toHaveBeenCalledTimes(2); // 1 initial + 1 for search
  });
});

// ---------------------------------------------------------------------------
// Approval cache (ask decisions — identity-scoped, TTL-based)
// ---------------------------------------------------------------------------

describe("approval cache", () => {
  const ctx = createMockTurnContext();

  const makeToolRequest = (toolId: string): ToolRequest => ({
    toolId,
    input: {},
  });

  test("caches approved 'ask' decisions — second call skips approval handler", async () => {
    const requestApproval = mock(async () => true);
    const approvalHandler: ApprovalHandler = { requestApproval };
    const askBackend = createPatternPermissionBackend({
      rules: { allow: [], deny: [], ask: ["deploy"] },
    });
    const mw = createPermissionsMiddleware({
      backend: askBackend,
      approvalHandler,
      cache: true,
    });
    const spy = createSpyToolHandler();

    await mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(1);

    // Second call — approval cache hit, no re-prompt
    await mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(spy.calls).toHaveLength(2);
  });

  test("different userId triggers separate approval", async () => {
    const requestApproval = mock(async () => true);
    const approvalHandler: ApprovalHandler = { requestApproval };
    const askBackend = createPatternPermissionBackend({
      rules: { allow: [], deny: [], ask: ["deploy"] },
    });
    const mw = createPermissionsMiddleware({
      backend: askBackend,
      approvalHandler,
      cache: true,
    });
    const spy = createSpyToolHandler();
    const ctxA = createMockTurnContext({
      session: createMockSessionContext({ userId: "user-a" }),
    });
    const ctxB = createMockTurnContext({
      session: createMockSessionContext({ userId: "user-b" }),
    });

    // Approve for user-a
    await mw.wrapToolCall?.(ctxA, makeToolRequest("deploy"), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(1);

    // Same tool for user-b — cache miss, prompts again
    await mw.wrapToolCall?.(ctxB, makeToolRequest("deploy"), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  test("different agentId shares approval cache (user-scoped, not agent-scoped)", async () => {
    const requestApproval = mock(async () => true);
    const approvalHandler: ApprovalHandler = { requestApproval };
    const askBackend = createPatternPermissionBackend({
      rules: { allow: [], deny: [], ask: ["deploy"] },
    });
    const mw = createPermissionsMiddleware({
      backend: askBackend,
      approvalHandler,
      cache: true,
    });
    const spy = createSpyToolHandler();
    const ctxAgent1 = createMockTurnContext({
      session: createMockSessionContext({ agentId: "agent-1", userId: "same-user" }),
    });
    const ctxAgent2 = createMockTurnContext({
      session: createMockSessionContext({ agentId: "agent-2", userId: "same-user" }),
    });

    // Approve for agent-1
    await mw.wrapToolCall?.(ctxAgent1, makeToolRequest("deploy"), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(1);

    // Same user, different agent — cache hit (approvals are user-scoped)
    await mw.wrapToolCall?.(ctxAgent2, makeToolRequest("deploy"), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  test("anonymous userId does not leak to authenticated userId", async () => {
    const requestApproval = mock(async () => true);
    const approvalHandler: ApprovalHandler = { requestApproval };
    const askBackend = createPatternPermissionBackend({
      rules: { allow: [], deny: [], ask: ["deploy"] },
    });
    const mw = createPermissionsMiddleware({
      backend: askBackend,
      approvalHandler,
      cache: true,
    });
    const spy = createSpyToolHandler();
    const { userId: _dropped, ...anonSession } = createMockSessionContext();
    const anonCtx = createMockTurnContext({
      session: anonSession as SessionContext,
    });
    const authCtx = createMockTurnContext({
      session: createMockSessionContext({ userId: "real-user" }),
    });

    // Approve as anonymous
    await mw.wrapToolCall?.(anonCtx, makeToolRequest("deploy"), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(1);

    // Same tool with real identity — must re-prompt
    await mw.wrapToolCall?.(authCtx, makeToolRequest("deploy"), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  test("expired TTL causes re-prompt", async () => {
    let now = 1000;
    const requestApproval = mock(async () => true);
    const approvalHandler: ApprovalHandler = { requestApproval };
    const askBackend = createPatternPermissionBackend({
      rules: { allow: [], deny: [], ask: ["deploy"] },
    });
    const mw = createPermissionsMiddleware({
      backend: askBackend,
      approvalHandler,
      cache: { ttlMs: 500 },
      clock: () => now,
    });
    const spy = createSpyToolHandler();

    // Approve
    await mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(1);

    // Past TTL — should re-prompt
    now = 1600;
    await mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  test("ttlMs: 0 disables expiry", async () => {
    let now = 1000;
    const requestApproval = mock(async () => true);
    const approvalHandler: ApprovalHandler = { requestApproval };
    const askBackend = createPatternPermissionBackend({
      rules: { allow: [], deny: [], ask: ["deploy"] },
    });
    const mw = createPermissionsMiddleware({
      backend: askBackend,
      approvalHandler,
      cache: { ttlMs: 0 },
      clock: () => now,
    });
    const spy = createSpyToolHandler();

    await mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(1);

    // Advance time significantly — cache should still hit
    now = 999_999;
    await mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  test("allowed tools bypass approval cache entirely", async () => {
    const requestApproval = mock(async () => true);
    const approvalHandler: ApprovalHandler = { requestApproval };
    const mw = createPermissionsMiddleware({
      backend,
      approvalHandler,
      cache: true,
    });
    const spy = createSpyToolHandler();

    // Allowed tool — no approval needed, no cache interaction
    await mw.wrapToolCall?.(ctx, makeToolRequest("calc"), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(0);
    expect(spy.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

describe("audit trail", () => {
  const ctx = createMockTurnContext();

  const makeToolRequest = (toolId: string): ToolRequest => ({
    toolId,
    input: {},
  });

  test("logs allow decisions to auditSink", async () => {
    const entries: unknown[] = [];
    const sink = {
      log: async (entry: unknown) => {
        entries.push(entry);
      },
    };
    const mw = createPermissionsMiddleware({ backend, auditSink: sink });
    const spy = createSpyToolHandler();

    await mw.wrapToolCall?.(ctx, makeToolRequest("calc"), spy.handler);

    // Give fire-and-forget promise a tick to resolve
    await new Promise((r) => setTimeout(r, 0));
    expect(entries).toHaveLength(1);
    const entry = entries[0] as Record<string, unknown>;
    expect((entry.metadata as Record<string, unknown>).effect).toBe("allow");
    expect((entry.metadata as Record<string, unknown>).resource).toBe("calc");
  });

  test("logs deny decisions with reason", async () => {
    const entries: unknown[] = [];
    const sink = {
      log: async (entry: unknown) => {
        entries.push(entry);
      },
    };
    const mw = createPermissionsMiddleware({ backend, auditSink: sink });
    const spy = createSpyToolHandler();

    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("rm"), spy.handler);
    } catch (_e) {
      // expected
    }

    await new Promise((r) => setTimeout(r, 0));
    expect(entries).toHaveLength(1);
    const entry = entries[0] as Record<string, unknown>;
    expect((entry.metadata as Record<string, unknown>).effect).toBe("deny");
    expect((entry.metadata as Record<string, unknown>).reason).toBeDefined();
  });

  test("swallows auditSink errors", async () => {
    const sink = {
      log: async () => {
        throw new Error("sink down");
      },
    };
    const mw = createPermissionsMiddleware({ backend, auditSink: sink });
    const spy = createSpyToolHandler();

    // Should not throw even though sink fails
    await mw.wrapToolCall?.(ctx, makeToolRequest("calc"), spy.handler);
    await new Promise((r) => setTimeout(r, 0));
    expect(spy.calls).toHaveLength(1);
  });

  test("no auditSink is a no-op", async () => {
    const mw = createPermissionsMiddleware({ backend });
    const spy = createSpyToolHandler();

    // Should work normally without auditSink
    await mw.wrapToolCall?.(ctx, makeToolRequest("calc"), spy.handler);
    expect(spy.calls).toHaveLength(1);
  });

  test("uses injected clock for timestamps", async () => {
    const entries: unknown[] = [];
    const sink = {
      log: async (entry: unknown) => {
        entries.push(entry);
      },
    };
    const mw = createPermissionsMiddleware({
      backend,
      auditSink: sink,
      clock: () => 42_000,
    });
    const spy = createSpyToolHandler();

    await mw.wrapToolCall?.(ctx, makeToolRequest("calc"), spy.handler);
    await new Promise((r) => setTimeout(r, 0));
    expect((entries[0] as Record<string, unknown>).timestamp).toBe(42_000);
  });

  test("captures backend latency in durationMs", async () => {
    let now = 1000;
    const entries: unknown[] = [];
    const sink = {
      log: async (entry: unknown) => {
        entries.push(entry);
      },
    };
    const slowBackend: PermissionBackend = {
      check: () => {
        now += 50; // simulate 50ms backend latency
        return { effect: "allow" as const };
      },
    };
    const mw = createPermissionsMiddleware({
      backend: slowBackend,
      auditSink: sink,
      clock: () => now,
    });
    const spy = createSpyToolHandler();

    await mw.wrapToolCall?.(ctx, makeToolRequest("calc"), spy.handler);
    await new Promise((r) => setTimeout(r, 0));
    expect((entries[0] as Record<string, unknown>).durationMs).toBe(50);
  });

  test("wrapModelCall audits all decisions including denials", async () => {
    const entries: unknown[] = [];
    const sink = {
      log: async (entry: unknown) => {
        entries.push(entry);
      },
    };
    const mw = createPermissionsMiddleware({ backend, auditSink: sink });
    const spy = createSpyModelHandler();

    const request: ModelRequest = {
      messages: [],
      tools: [
        { name: "calc", description: "calc", inputSchema: {} },
        { name: "rm", description: "rm", inputSchema: {} },
        { name: "deploy", description: "deploy", inputSchema: {} },
      ],
    };
    await mw.wrapModelCall?.(ctx, request, spy.handler);
    await new Promise((r) => setTimeout(r, 0));

    expect(entries).toHaveLength(3);
    const effects = entries.map(
      (e) => ((e as Record<string, unknown>).metadata as Record<string, unknown>).effect,
    );
    expect(effects).toContain("allow");
    expect(effects).toContain("deny");
    expect(effects).toContain("ask");
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

describe("circuit breaker", () => {
  const ctx = createMockTurnContext();

  const makeToolRequest = (toolId: string): ToolRequest => ({
    toolId,
    input: {},
  });

  const cbConfig = {
    failureThreshold: 2,
    cooldownMs: 1000,
    failureWindowMs: 5000,
    failureStatusCodes: [],
  } as const;

  test("denies after threshold failures", async () => {
    let callCount = 0;
    const failingBackend: PermissionBackend = {
      check: () => {
        callCount++;
        throw new Error("backend down");
      },
    };
    const mw = createPermissionsMiddleware({
      backend: failingBackend,
      circuitBreaker: cbConfig,
    });
    const spy = createSpyToolHandler();

    // First 2 calls fail (reaching threshold)
    for (let i = 0; i < 2; i++) {
      try {
        await mw.wrapToolCall?.(ctx, makeToolRequest("calc"), spy.handler);
      } catch (_e) {
        // expected
      }
    }
    expect(callCount).toBe(2);

    // 3rd call — circuit is open, backend NOT called
    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("calc"), spy.handler);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as KoiError;
      expect(err.code).toBe("PERMISSION");
      expect(err.message).toContain("circuit open");
    }
    expect(callCount).toBe(2); // backend not called again
  });

  test("recovers after cooldown", async () => {
    let now = 1000;
    let shouldFail = true;
    const mockBackend: PermissionBackend = {
      check: () => {
        if (shouldFail) throw new Error("down");
        return { effect: "allow" as const };
      },
    };
    const mw = createPermissionsMiddleware({
      backend: mockBackend,
      circuitBreaker: cbConfig,
      clock: () => now,
    });
    const spy = createSpyToolHandler();

    // Trip the circuit
    for (let i = 0; i < 2; i++) {
      try {
        await mw.wrapToolCall?.(ctx, makeToolRequest("calc"), spy.handler);
      } catch (_e) {
        // expected
      }
    }

    // Advance past cooldown, backend recovers
    now = 3000;
    shouldFail = false;
    await mw.wrapToolCall?.(ctx, makeToolRequest("calc"), spy.handler);
    expect(spy.calls).toHaveLength(1);
  });

  test("no circuitBreaker config means no wrapping", async () => {
    const failingBackend: PermissionBackend = {
      check: () => {
        throw new Error("backend down");
      },
    };
    const mw = createPermissionsMiddleware({ backend: failingBackend });
    const spy = createSpyToolHandler();

    // Without CB, every call hits the backend and throws
    for (let i = 0; i < 5; i++) {
      try {
        await mw.wrapToolCall?.(ctx, makeToolRequest("calc"), spy.handler);
      } catch (_e) {
        // expected — all 5 should throw from backend
      }
    }
    expect(spy.calls).toHaveLength(0);
  });

  test("batch denial when circuit is open", async () => {
    let callCount = 0;
    const failingBackend: PermissionBackend = {
      check: () => {
        callCount++;
        throw new Error("backend down");
      },
    };
    const mw = createPermissionsMiddleware({
      backend: failingBackend,
      circuitBreaker: cbConfig,
    });
    const spy = createSpyModelHandler();

    // Trip the circuit via individual calls
    for (let i = 0; i < 2; i++) {
      try {
        await mw.wrapToolCall?.(ctx, makeToolRequest("calc"), createSpyToolHandler().handler);
      } catch (_e) {
        // expected
      }
    }

    // Batch call with circuit open — all tools denied (filtered)
    const request: ModelRequest = {
      messages: [],
      tools: [
        { name: "calc", description: "calc", inputSchema: {} },
        { name: "search", description: "search", inputSchema: {} },
      ],
    };
    await mw.wrapModelCall?.(ctx, request, spy.handler);
    const passedTools = spy.calls[0]?.tools ?? [];
    expect(passedTools).toHaveLength(0); // all denied
    expect(callCount).toBe(2); // backend not called for batch
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  const ctx = createMockTurnContext();

  const makeToolRequest = (toolId: string): ToolRequest => ({
    toolId,
    input: {},
  });

  test("backend throws → fail closed (PERMISSION error)", async () => {
    const throwingBackend: PermissionBackend = {
      check: () => {
        throw new Error("connection refused");
      },
    };
    const mw = createPermissionsMiddleware({ backend: throwingBackend });
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("calc"), spy.handler);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as KoiError;
      expect(err.code).toBe("PERMISSION");
      expect(err.message).toContain("fail closed");
      expect(spy.calls).toHaveLength(0);
    }
  });

  test("backend returns rejecting Promise → deny with context", async () => {
    const rejectingBackend: PermissionBackend = {
      check: () => Promise.reject(new Error("policy engine down")),
    };
    const mw = createPermissionsMiddleware({ backend: rejectingBackend });
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("calc"), spy.handler);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as KoiError;
      expect(err.code).toBe("PERMISSION");
      expect(err.context).toEqual({ resource: "calc" });
    }
  });

  test("checkBatch fallback when not implemented → Promise.all", async () => {
    const checkFn = mock(
      (q: { readonly resource: string }) =>
        ({ effect: q.resource === "rm" ? "deny" : "allow" }) as PermissionDecision,
    );
    const noBatchBackend: PermissionBackend = { check: checkFn };
    const mw = createPermissionsMiddleware({ backend: noBatchBackend });
    const spy = createSpyModelHandler();

    const request: ModelRequest = {
      messages: [],
      tools: [
        { name: "calc", description: "calc", inputSchema: {} },
        { name: "rm", description: "rm", inputSchema: {} },
      ],
    };
    await mw.wrapModelCall?.(ctx, request, spy.handler);

    expect(checkFn).toHaveBeenCalledTimes(2);
    const passedTools = spy.calls[0]?.tools ?? [];
    expect(passedTools.map((t) => t.name)).toEqual(["calc"]);
  });

  test("dispose() called on session end", async () => {
    const disposeFn = mock(() => Promise.resolve());
    const disposableBackend: PermissionBackend = {
      check: () => ({ effect: "allow" }),
      dispose: disposeFn,
    };
    const mw = createPermissionsMiddleware({ backend: disposableBackend });
    const sessionCtx = ctx.session;

    await mw.onSessionEnd?.(sessionCtx);
    expect(disposeFn).toHaveBeenCalledTimes(1);

    // Idempotent — second call also works
    await mw.onSessionEnd?.(sessionCtx);
    expect(disposeFn).toHaveBeenCalledTimes(2);
  });

  test("session end with no dispose() is a no-op", async () => {
    const noDisposeBackend: PermissionBackend = {
      check: () => ({ effect: "allow" }),
    };
    const mw = createPermissionsMiddleware({ backend: noDisposeBackend });
    // Should not throw
    await mw.onSessionEnd?.(ctx.session);
  });

  test("concurrent check() calls don't share state", async () => {
    let callCount = 0;
    const asyncBackend: PermissionBackend = {
      check: async (q) => {
        callCount++;
        await new Promise((r) => setTimeout(r, 10));
        return q.resource === "rm" ? { effect: "deny", reason: "no" } : { effect: "allow" };
      },
    };
    const mw = createPermissionsMiddleware({ backend: asyncBackend });
    const spy = createSpyToolHandler();

    const [r1, r2] = await Promise.allSettled([
      mw.wrapToolCall?.(ctx, makeToolRequest("calc"), spy.handler),
      mw.wrapToolCall?.(ctx, makeToolRequest("rm"), spy.handler),
    ]);

    expect(callCount).toBe(2);
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("rejected");
  });

  describe("approval cache — key determinism and serialization", () => {
    const askBackend = createPatternPermissionBackend({
      rules: { allow: [], deny: [], ask: ["multiply", "deploy"] },
    });
    const ctx = createMockTurnContext();

    test("different property insertion order produces same cache key (sorted input)", async () => {
      const requestApproval = mock(async () => true);
      const mw = createPermissionsMiddleware({
        backend: askBackend,
        approvalHandler: { requestApproval },
        cache: true,
      });
      const spy = createSpyToolHandler();

      // Call 1: {a: 7, b: 8}
      await mw.wrapToolCall?.(ctx, { toolId: "multiply", input: { a: 7, b: 8 } }, spy.handler);
      expect(requestApproval).toHaveBeenCalledTimes(1);

      // Call 2: {b: 8, a: 7} — same logical input, different insertion order
      // Sorted serialization must produce the same key → cache hit
      await mw.wrapToolCall?.(ctx, { toolId: "multiply", input: { b: 8, a: 7 } }, spy.handler);
      expect(requestApproval).toHaveBeenCalledTimes(1); // no re-prompt
    });

    test("circular reference in input throws VALIDATION error before prompting", async () => {
      const requestApproval = mock(async () => true);
      const mw = createPermissionsMiddleware({
        backend: askBackend,
        approvalHandler: { requestApproval },
        cache: true,
      });
      const spy = createSpyToolHandler();

      // Circular reference violates JsonObject contract — only reachable via unsafe cast.
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      try {
        await mw.wrapToolCall?.(ctx, { toolId: "deploy", input: circular as never }, spy.handler);
        expect.unreachable("should have thrown");
      } catch (e) {
        const err = e as KoiError;
        expect(err.code).toBe("VALIDATION");
        expect(spy.calls).toHaveLength(0); // tool never called
        expect(requestApproval).not.toHaveBeenCalled(); // error before prompt
      }
    });
  });
});

// ---------------------------------------------------------------------------
// describeCapabilities
// ---------------------------------------------------------------------------

describe("describeCapabilities", () => {
  const ctx = createMockTurnContext();

  test("is defined on the middleware", () => {
    const mw = createPermissionsMiddleware({ backend });
    expect(mw.describeCapabilities).toBeDefined();
  });

  test("returns label 'permissions'", () => {
    const mw = createPermissionsMiddleware({ backend });
    const result = mw.describeCapabilities?.(ctx);
    expect(result?.label).toBe("permissions");
  });

  test("uses custom description when provided", () => {
    const mw = createPermissionsMiddleware({
      backend,
      description: "Custom permission policy",
    });
    const result = mw.describeCapabilities?.(ctx);
    expect(result?.description).toBe("Custom permission policy");
  });
});
