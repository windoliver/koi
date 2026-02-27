import { describe, expect, mock, test } from "bun:test";
import type { KoiError } from "@koi/core/errors";
import type { ToolRequest } from "@koi/core/middleware";
import { createMockTurnContext, createSpyToolHandler } from "@koi/test-utils";
import type { ApprovalHandler } from "./engine.js";
import { createAutoApprovalHandler, createPatternPermissionEngine } from "./engine.js";
import { createPermissionsMiddleware } from "./permissions.js";

describe("createPermissionsMiddleware", () => {
  const engine = createPatternPermissionEngine();
  const ctx = createMockTurnContext();

  const makeRequest = (toolId: string): ToolRequest => ({
    toolId,
    input: {},
  });

  test("has name 'permissions'", () => {
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: ["*"], deny: [], ask: [] },
    });
    expect(mw.name).toBe("permissions");
  });

  test("has priority 100", () => {
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: ["*"], deny: [], ask: [] },
    });
    expect(mw.priority).toBe(100);
  });

  test("allowed tool calls next()", async () => {
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: ["calc"], deny: [], ask: [] },
    });
    const spy = createSpyToolHandler();
    const response = await mw.wrapToolCall?.(ctx, makeRequest("calc"), spy.handler);
    expect(spy.calls).toHaveLength(1);
    expect(response?.output).toEqual({ result: "mock" });
  });

  test("denied tool does NOT call next()", async () => {
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: [], deny: ["rm"], ask: [] },
    });
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, makeRequest("rm"), spy.handler);
      expect.unreachable("should have thrown");
    } catch (_e) {
      expect(spy.calls).toHaveLength(0);
    }
  });

  test("denied tool throws PERMISSION error", async () => {
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: [], deny: ["rm"], ask: [] },
    });
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, makeRequest("rm"), spy.handler);
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
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: [], deny: [], ask: ["deploy"] },
      approvalHandler,
    });
    const spy = createSpyToolHandler();
    const response = await mw.wrapToolCall?.(ctx, makeRequest("deploy"), spy.handler);
    expect(spy.calls).toHaveLength(1);
    expect(response?.output).toEqual({ result: "mock" });
  });

  test("ask flow with denial throws PERMISSION", async () => {
    const denyHandler: ApprovalHandler = {
      requestApproval: async () => false,
    };
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: [], deny: [], ask: ["deploy"] },
      approvalHandler: denyHandler,
    });
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, makeRequest("deploy"), spy.handler);
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
      engine,
      rules: { allow: [], deny: [], ask: ["deploy"] },
      approvalHandler: slowHandler,
      approvalTimeoutMs: 50,
    });
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, makeRequest("deploy"), spy.handler);
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
      engine,
      rules: { allow: [], deny: [], ask: ["deploy"] },
      approvalHandler: fastHandler,
      approvalTimeoutMs: 60_000, // very long — would hang if not cleaned up
    });
    const spy = createSpyToolHandler();
    const response = await mw.wrapToolCall?.(ctx, makeRequest("deploy"), spy.handler);
    expect(spy.calls).toHaveLength(1);
    expect(response?.output).toEqual({ result: "mock" });
  });

  test("defaultDeny blocks unmatched tools", async () => {
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: [], deny: [], ask: [] },
      defaultDeny: true,
    });
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, makeRequest("unknown"), spy.handler);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as KoiError;
      expect(err.code).toBe("PERMISSION");
    }
  });

  test("model calls pass through (no wrapModelCall)", () => {
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: ["*"], deny: [], ask: [] },
    });
    // permissions middleware does not define wrapModelCall
    expect(mw.wrapModelCall).toBeUndefined();
  });

  test("wildcard allow passes all tools", async () => {
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: ["*"], deny: [], ask: [] },
    });
    const spy = createSpyToolHandler();
    await mw.wrapToolCall?.(ctx, makeRequest("anything"), spy.handler);
    expect(spy.calls).toHaveLength(1);
  });

  test("prefix wildcard in deny blocks matching tools", async () => {
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: ["*"], deny: ["fs:*"], ask: [] },
    });
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, makeRequest("fs:delete"), spy.handler);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as KoiError;
      expect(err.code).toBe("PERMISSION");
    }
  });

  test("ask without approvalHandler throws PERMISSION", async () => {
    const askEngine = createPatternPermissionEngine();
    const mw = createPermissionsMiddleware({
      engine: askEngine,
      rules: { allow: [], deny: [], ask: ["deploy"] },
      // no approvalHandler
    });
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, makeRequest("deploy"), spy.handler);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as KoiError;
      expect(err.code).toBe("PERMISSION");
      expect(err.message).toContain("No approval handler");
    }
  });

  test("passes original request to next()", async () => {
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: ["calc"], deny: [], ask: [] },
    });
    const spy = createSpyToolHandler();
    const request = makeRequest("calc");
    await mw.wrapToolCall?.(ctx, request, spy.handler);
    expect(spy.calls[0]).toBe(request);
  });
});

// ---------------------------------------------------------------------------
// Approval Cache
// ---------------------------------------------------------------------------

describe("approval cache", () => {
  const engine = createPatternPermissionEngine();
  const ctx = createMockTurnContext();

  const makeRequest = (toolId: string, input: Record<string, unknown> = {}): ToolRequest => ({
    toolId,
    input,
  });

  test("second identical ask call skips approval when cache enabled", async () => {
    const requestApproval = mock(async () => true);
    const approvalHandler: ApprovalHandler = { requestApproval };
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: [], deny: [], ask: ["deploy"] },
      approvalHandler,
      approvalCache: true,
    });
    const spy = createSpyToolHandler();

    // First call — prompts for approval
    await mw.wrapToolCall?.(ctx, makeRequest("deploy"), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(1);

    // Second identical call — cache hit, no prompt
    await mw.wrapToolCall?.(ctx, makeRequest("deploy"), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(spy.calls).toHaveLength(2);
  });

  test("different inputs trigger separate approvals", async () => {
    const requestApproval = mock(async () => true);
    const approvalHandler: ApprovalHandler = { requestApproval };
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: [], deny: [], ask: ["deploy"] },
      approvalHandler,
      approvalCache: true,
    });
    const spy = createSpyToolHandler();

    await mw.wrapToolCall?.(ctx, makeRequest("deploy", { env: "staging" }), spy.handler);
    await mw.wrapToolCall?.(ctx, makeRequest("deploy", { env: "prod" }), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  test("denied approvals are NOT cached", async () => {
    let callCount = 0;
    const approvalHandler: ApprovalHandler = {
      requestApproval: async () => {
        callCount++;
        // First call denied, second call approved
        return callCount > 1;
      },
    };
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: [], deny: [], ask: ["deploy"] },
      approvalHandler,
      approvalCache: true,
    });
    const spy = createSpyToolHandler();

    // First call — denied
    try {
      await mw.wrapToolCall?.(ctx, makeRequest("deploy"), spy.handler);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as KoiError;
      expect(err.code).toBe("PERMISSION");
    }

    // Second identical call — should prompt again (denial was not cached)
    await mw.wrapToolCall?.(ctx, makeRequest("deploy"), spy.handler);
    expect(callCount).toBe(2);
    expect(spy.calls).toHaveLength(1);
  });

  test("cache disabled by default", async () => {
    const requestApproval = mock(async () => true);
    const approvalHandler: ApprovalHandler = { requestApproval };
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: [], deny: [], ask: ["deploy"] },
      approvalHandler,
      // no approvalCache — disabled by default
    });
    const spy = createSpyToolHandler();

    await mw.wrapToolCall?.(ctx, makeRequest("deploy"), spy.handler);
    await mw.wrapToolCall?.(ctx, makeRequest("deploy"), spy.handler);
    // Both calls should prompt
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  test("cache disabled when approvalCache is false", async () => {
    const requestApproval = mock(async () => true);
    const approvalHandler: ApprovalHandler = { requestApproval };
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: [], deny: [], ask: ["deploy"] },
      approvalHandler,
      approvalCache: false,
    });
    const spy = createSpyToolHandler();

    await mw.wrapToolCall?.(ctx, makeRequest("deploy"), spy.handler);
    await mw.wrapToolCall?.(ctx, makeRequest("deploy"), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  test("LRU eviction: oldest entry evicted when cache full, recent entries kept", async () => {
    const requestApproval = mock(async () => true);
    const approvalHandler: ApprovalHandler = { requestApproval };
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: [], deny: [], ask: ["deploy"] },
      approvalHandler,
      approvalCache: { maxEntries: 2 },
    });
    const spy = createSpyToolHandler();

    // Fill cache with 2 entries
    await mw.wrapToolCall?.(ctx, makeRequest("deploy", { a: 1 }), spy.handler); // prompt 1
    await mw.wrapToolCall?.(ctx, makeRequest("deploy", { a: 2 }), spy.handler); // prompt 2
    expect(requestApproval).toHaveBeenCalledTimes(2);

    // Third unique entry — LRU evicts oldest ({a:1}), prompts
    await mw.wrapToolCall?.(ctx, makeRequest("deploy", { a: 3 }), spy.handler); // prompt 3
    expect(requestApproval).toHaveBeenCalledTimes(3);

    // Entry {a:2} should still be cached — no new prompt
    await mw.wrapToolCall?.(ctx, makeRequest("deploy", { a: 2 }), spy.handler); // cache hit
    expect(requestApproval).toHaveBeenCalledTimes(3);

    // Entry {a:1} was evicted — should re-prompt
    await mw.wrapToolCall?.(ctx, makeRequest("deploy", { a: 1 }), spy.handler); // prompt 4
    expect(requestApproval).toHaveBeenCalledTimes(4);
  });

  test("different userId triggers separate approval", async () => {
    const requestApproval = mock(async () => true);
    const approvalHandler: ApprovalHandler = { requestApproval };
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: [], deny: [], ask: ["deploy"] },
      approvalHandler,
      approvalCache: true,
    });
    const spy = createSpyToolHandler();
    const ctxA = createMockTurnContext({ session: { userId: "user-a" } });
    const ctxB = createMockTurnContext({ session: { userId: "user-b" } });

    // Approve for user-a
    await mw.wrapToolCall?.(ctxA, makeRequest("deploy"), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(1);

    // Same tool for user-b — cache miss, prompts again
    await mw.wrapToolCall?.(ctxB, makeRequest("deploy"), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  test("anonymous userId does not leak to authenticated userId", async () => {
    const requestApproval = mock(async () => true);
    const approvalHandler: ApprovalHandler = { requestApproval };
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: [], deny: [], ask: ["deploy"] },
      approvalHandler,
      approvalCache: true,
    });
    const spy = createSpyToolHandler();
    const anonCtx = createMockTurnContext({ session: { userId: undefined } });
    const authCtx = createMockTurnContext({ session: { userId: "real-user" } });

    // Approve as anonymous
    await mw.wrapToolCall?.(anonCtx, makeRequest("deploy"), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(1);

    // Same tool with real identity — must re-prompt
    await mw.wrapToolCall?.(authCtx, makeRequest("deploy"), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  test("expired TTL causes re-prompt", async () => {
    const requestApproval = mock(async () => true);
    const approvalHandler: ApprovalHandler = { requestApproval };
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: [], deny: [], ask: ["deploy"] },
      approvalHandler,
      approvalCache: { ttlMs: 50 },
    });
    const spy = createSpyToolHandler();

    // Approve
    await mw.wrapToolCall?.(ctx, makeRequest("deploy"), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(1);

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Same call — expired, should re-prompt
    await mw.wrapToolCall?.(ctx, makeRequest("deploy"), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  test("ttlMs: 0 disables expiry", async () => {
    const requestApproval = mock(async () => true);
    const approvalHandler: ApprovalHandler = { requestApproval };
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: [], deny: [], ask: ["deploy"] },
      approvalHandler,
      approvalCache: { ttlMs: 0 },
    });
    const spy = createSpyToolHandler();

    await mw.wrapToolCall?.(ctx, makeRequest("deploy"), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(1);

    // Wait a bit — cache should still hit
    await new Promise((resolve) => setTimeout(resolve, 50));

    await mw.wrapToolCall?.(ctx, makeRequest("deploy"), spy.handler);
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  test("different rules produce independent caches", async () => {
    const requestApprovalA = mock(async () => true);
    const requestApprovalB = mock(async () => true);
    // mwA has rules { ask: ["deploy"] }, mwB has rules { ask: ["deploy", "restart"] }
    const mwA = createPermissionsMiddleware({
      engine,
      rules: { allow: [], deny: [], ask: ["deploy"] },
      approvalHandler: { requestApproval: requestApprovalA },
      approvalCache: true,
    });
    const mwB = createPermissionsMiddleware({
      engine,
      rules: { allow: [], deny: [], ask: ["deploy", "restart"] },
      approvalHandler: { requestApproval: requestApprovalB },
      approvalCache: true,
    });
    const spy = createSpyToolHandler();

    // Approve "deploy" on mwA
    await mwA.wrapToolCall?.(ctx, makeRequest("deploy"), spy.handler);
    expect(requestApprovalA).toHaveBeenCalledTimes(1);

    // Same "deploy" on mwA — cache hit
    await mwA.wrapToolCall?.(ctx, makeRequest("deploy"), spy.handler);
    expect(requestApprovalA).toHaveBeenCalledTimes(1);

    // Same "deploy" on mwB — different rules fingerprint, must prompt
    await mwB.wrapToolCall?.(ctx, makeRequest("deploy"), spy.handler);
    expect(requestApprovalB).toHaveBeenCalledTimes(1);
  });

  test("allowed tools bypass cache entirely", async () => {
    const requestApproval = mock(async () => true);
    const approvalHandler: ApprovalHandler = { requestApproval };
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: ["calc"], deny: [], ask: ["deploy"] },
      approvalHandler,
      approvalCache: true,
    });
    const spy = createSpyToolHandler();

    // Allowed tool — no approval needed, no cache involvement
    await mw.wrapToolCall?.(ctx, makeRequest("calc"), spy.handler);
    await mw.wrapToolCall?.(ctx, makeRequest("calc"), spy.handler);
    expect(requestApproval).not.toHaveBeenCalled();
    expect(spy.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// describeCapabilities
// ---------------------------------------------------------------------------

describe("describeCapabilities", () => {
  const engine = createPatternPermissionEngine();
  const ctx = createMockTurnContext();

  test("is defined on the middleware", () => {
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: ["*"], deny: [], ask: [] },
    });
    expect(mw.describeCapabilities).toBeDefined();
  });

  test("returns label 'permissions' and description containing approval info", () => {
    const mw = createPermissionsMiddleware({
      engine,
      rules: { allow: [], deny: [], ask: ["deploy"] },
      defaultDeny: true,
    });
    const result = mw.describeCapabilities?.(ctx);
    expect(result?.label).toBe("permissions");
    expect(result?.description).toContain("Default");
  });
});
