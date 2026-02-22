import { describe, expect, test } from "bun:test";
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
