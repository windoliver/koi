import { describe, expect, mock, test } from "bun:test";
import type { KoiError } from "@koi/core/errors";
import type { ToolRequest } from "@koi/core/middleware";
import {
  createMockSessionContext,
  createMockTurnContext,
  createSpyToolHandler,
} from "@koi/test-utils";
import { createExecApprovalsMiddleware } from "./middleware.js";
import { createInMemoryRulesStore } from "./store.js";
import type { ExecApprovalRequest, ExecRulesStore, ProgressiveDecision } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const makeToolRequest = (toolId: string, command?: string): ToolRequest => ({
  toolId,
  input: command !== undefined ? { command } : {},
});

/** Creates a mock onAsk that always returns the given decision. */
function makeOnAsk(
  decision: ProgressiveDecision,
): (req: ExecApprovalRequest) => Promise<ProgressiveDecision> {
  return async (_req) => decision;
}

/** Creates a session context + turn context pair sharing the same sessionId. */
function makeSession(sessionId = "session-1") {
  const session = createMockSessionContext({
    sessionId: sessionId as ReturnType<typeof createMockSessionContext>["sessionId"],
  });
  const ctx = createMockTurnContext({ session });
  return { session, ctx };
}

// ---------------------------------------------------------------------------
// Basic allow / deny / default-deny
// ---------------------------------------------------------------------------

describe("createExecApprovalsMiddleware — static rules", () => {
  test("allow pattern: calls next() without prompting", async () => {
    const { session, ctx } = makeSession();
    const mw = createExecApprovalsMiddleware({
      rules: { allow: ["bash"], deny: [], ask: [] },
      onAsk: makeOnAsk({ kind: "allow_once" }),
    });
    await mw.onSessionStart?.(session);
    const spy = createSpyToolHandler();
    const response = await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), spy.handler);
    expect(spy.calls).toHaveLength(1);
    expect(response?.output).toEqual({ result: "mock" });
  });

  test("deny pattern: throws PERMISSION without prompting", async () => {
    const { session, ctx } = makeSession();
    const onAsk = mock(makeOnAsk({ kind: "allow_once" }));
    const mw = createExecApprovalsMiddleware({
      rules: { allow: [], deny: ["bash"], ask: [] },
      onAsk,
    });
    await mw.onSessionStart?.(session);
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), spy.handler);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as KoiError;
      expect(err.code).toBe("PERMISSION");
      expect(spy.calls).toHaveLength(0);
      expect(onAsk).not.toHaveBeenCalled();
    }
  });

  test("default deny blocks unmatched tools", async () => {
    const { session, ctx } = makeSession();
    const mw = createExecApprovalsMiddleware({
      rules: { allow: [], deny: [], ask: [] },
      onAsk: makeOnAsk({ kind: "allow_once" }),
    });
    await mw.onSessionStart?.(session);
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("unknown-tool"), spy.handler);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as KoiError;
      expect(err.code).toBe("PERMISSION");
      expect(err.message).toContain("default deny");
    }
  });

  test("wildcard allow '*' passes all tools", async () => {
    const { session, ctx } = makeSession();
    const mw = createExecApprovalsMiddleware({
      rules: { allow: ["*"], deny: [], ask: [] },
      onAsk: makeOnAsk({ kind: "allow_once" }),
    });
    await mw.onSessionStart?.(session);
    const spy = createSpyToolHandler();
    await mw.wrapToolCall?.(ctx, makeToolRequest("anything"), spy.handler);
    expect(spy.calls).toHaveLength(1);
  });

  test("onAsk is NOT called for allow patterns", async () => {
    const { session, ctx } = makeSession();
    const onAsk = mock(makeOnAsk({ kind: "allow_once" }));
    const mw = createExecApprovalsMiddleware({
      rules: { allow: ["bash"], deny: [], ask: [] },
      onAsk,
    });
    await mw.onSessionStart?.(session);
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), createSpyToolHandler().handler);
    expect(onAsk).not.toHaveBeenCalled();
  });

  test("onAsk is NOT called for deny patterns", async () => {
    const { session, ctx } = makeSession();
    const onAsk = mock(makeOnAsk({ kind: "allow_once" }));
    const mw = createExecApprovalsMiddleware({
      rules: { allow: [], deny: ["bash"], ask: [] },
      onAsk,
    });
    await mw.onSessionStart?.(session);
    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), createSpyToolHandler().handler);
    } catch {
      // expected
    }
    expect(onAsk).not.toHaveBeenCalled();
  });

  test("has name 'exec-approvals'", () => {
    const mw = createExecApprovalsMiddleware({
      rules: { allow: ["*"], deny: [], ask: [] },
      onAsk: makeOnAsk({ kind: "allow_once" }),
    });
    expect(mw.name).toBe("exec-approvals");
  });

  test("has priority 100", () => {
    const mw = createExecApprovalsMiddleware({
      rules: { allow: ["*"], deny: [], ask: [] },
      onAsk: makeOnAsk({ kind: "allow_once" }),
    });
    expect(mw.priority).toBe(100);
  });

  test("wrapModelCall is undefined", () => {
    const mw = createExecApprovalsMiddleware({
      rules: { allow: ["*"], deny: [], ask: [] },
      onAsk: makeOnAsk({ kind: "allow_once" }),
    });
    expect(mw.wrapModelCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Ask flow — ProgressiveDecision variants
// ---------------------------------------------------------------------------

describe("createExecApprovalsMiddleware — ask flow", () => {
  test("ask + allow_once: calls next(), does NOT cache for next call", async () => {
    const { session, ctx } = makeSession();
    const onAsk = mock(makeOnAsk({ kind: "allow_once" }));
    const mw = createExecApprovalsMiddleware({
      rules: { allow: [], deny: [], ask: ["bash"] },
      onAsk,
    });
    await mw.onSessionStart?.(session);
    const spy = createSpyToolHandler();
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), spy.handler);
    expect(spy.calls).toHaveLength(1);
    expect(onAsk).toHaveBeenCalledTimes(1);
    // Second call — should prompt again
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), spy.handler);
    expect(onAsk).toHaveBeenCalledTimes(2);
  });

  test("ask + allow_session: calls next() and skips prompt on repeat", async () => {
    const { session, ctx } = makeSession();
    const onAsk = mock(
      async (_req: ExecApprovalRequest): Promise<ProgressiveDecision> => ({
        kind: "allow_session",
        pattern: "bash",
      }),
    );
    const mw = createExecApprovalsMiddleware({
      rules: { allow: [], deny: [], ask: ["bash"] },
      onAsk,
    });
    await mw.onSessionStart?.(session);
    const spy = createSpyToolHandler();
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), spy.handler);
    expect(onAsk).toHaveBeenCalledTimes(1);
    // Second call — cached in session, no prompt
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), spy.handler);
    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(spy.calls).toHaveLength(2);
  });

  test("ask + allow_always: calls next() and store.save() is called", async () => {
    const { session, ctx } = makeSession();
    const store = createInMemoryRulesStore();
    const saveSpy = mock(store.save.bind(store));
    const mockStore: ExecRulesStore = { load: store.load.bind(store), save: saveSpy };
    const onAsk = mock(
      async (_req: ExecApprovalRequest): Promise<ProgressiveDecision> => ({
        kind: "allow_always",
        pattern: "bash",
      }),
    );
    const mw = createExecApprovalsMiddleware({
      rules: { allow: [], deny: [], ask: ["bash"] },
      onAsk,
      store: mockStore,
    });
    await mw.onSessionStart?.(session);
    const spy = createSpyToolHandler();
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), spy.handler);
    expect(spy.calls).toHaveLength(1);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    // Second call — pattern is now in session allow list
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), spy.handler);
    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(spy.calls).toHaveLength(2);
  });

  test("ask + deny_once: throws PERMISSION, no state change", async () => {
    const { session, ctx } = makeSession();
    const onAsk = mock(
      async (_req: ExecApprovalRequest): Promise<ProgressiveDecision> => ({
        kind: "deny_once",
        reason: "Denied for now",
      }),
    );
    const mw = createExecApprovalsMiddleware({
      rules: { allow: [], deny: [], ask: ["bash"] },
      onAsk,
    });
    await mw.onSessionStart?.(session);
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), spy.handler);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as KoiError;
      expect(err.code).toBe("PERMISSION");
      expect(err.message).toContain("Denied for now");
      expect(spy.calls).toHaveLength(0);
    }
    // Second call should prompt again (deny_once does not persist)
    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), spy.handler);
    } catch {
      // expected
    }
    expect(onAsk).toHaveBeenCalledTimes(2);
  });

  test("ask + deny_always: throws PERMISSION and store.save() is called", async () => {
    const { session, ctx } = makeSession();
    const store = createInMemoryRulesStore();
    const saveSpy = mock(store.save.bind(store));
    const mockStore: ExecRulesStore = { load: store.load.bind(store), save: saveSpy };
    const onAsk = mock(
      async (_req: ExecApprovalRequest): Promise<ProgressiveDecision> => ({
        kind: "deny_always",
        pattern: "bash",
        reason: "Never allowed",
      }),
    );
    const mw = createExecApprovalsMiddleware({
      rules: { allow: [], deny: [], ask: ["bash"] },
      onAsk,
      store: mockStore,
    });
    await mw.onSessionStart?.(session);
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), spy.handler);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as KoiError;
      expect(err.code).toBe("PERMISSION");
      expect(err.message).toContain("Never allowed");
    }
    expect(spy.calls).toHaveLength(0);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  test("ask timeout throws TIMEOUT error (retryable: true)", async () => {
    const { session, ctx } = makeSession();
    const onAsk = async (_req: ExecApprovalRequest): Promise<ProgressiveDecision> =>
      new Promise((resolve) => setTimeout(() => resolve({ kind: "allow_once" }), 5000));
    const mw = createExecApprovalsMiddleware({
      rules: { allow: [], deny: [], ask: ["bash"] },
      onAsk,
      approvalTimeoutMs: 50,
    });
    await mw.onSessionStart?.(session);
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), spy.handler);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as KoiError;
      expect(err.code).toBe("TIMEOUT");
      expect(err.retryable).toBe(true);
      expect(spy.calls).toHaveLength(0);
    }
  });

  test("onAsk receives the matched pattern in ExecApprovalRequest", async () => {
    const { session, ctx } = makeSession();
    const captured: ExecApprovalRequest[] = [];
    const onAsk = async (req: ExecApprovalRequest): Promise<ProgressiveDecision> => {
      captured.push(req);
      return { kind: "allow_once" };
    };
    const mw = createExecApprovalsMiddleware({
      rules: { allow: [], deny: [], ask: ["bash:git push*"] },
      onAsk,
    });
    await mw.onSessionStart?.(session);
    await mw.wrapToolCall?.(
      ctx,
      makeToolRequest("bash", "git push origin"),
      createSpyToolHandler().handler,
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]?.matchedPattern).toBe("bash:git push*");
    expect(captured[0]?.toolId).toBe("bash");
  });
});

// ---------------------------------------------------------------------------
// Security invariants
// ---------------------------------------------------------------------------

describe("security invariants", () => {
  test("base deny overrides session allow (base deny is absolute)", async () => {
    const { session, ctx } = makeSession();
    // Simulate: a prior session has an allow_always for "bash"
    // But base deny has "bash" too — base deny must win
    const store = createInMemoryRulesStore();
    // Pre-seed store with an allow for bash
    await store.save({ allow: ["bash"], deny: [] });
    const mw = createExecApprovalsMiddleware({
      rules: { allow: [], deny: ["bash"], ask: [] },
      onAsk: makeOnAsk({ kind: "allow_once" }),
      store,
    });
    await mw.onSessionStart?.(session);
    const spy = createSpyToolHandler();
    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), spy.handler);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as KoiError;
      expect(err.code).toBe("PERMISSION");
      expect(spy.calls).toHaveLength(0);
    }
  });

  test("deny_once does NOT add to session deny list", async () => {
    const { session, ctx } = makeSession();
    const onAsk = mock(
      async (): Promise<ProgressiveDecision> => ({
        kind: "deny_once",
        reason: "test",
      }),
    );
    const mw = createExecApprovalsMiddleware({
      rules: { allow: [], deny: [], ask: ["bash"] },
      onAsk,
    });
    await mw.onSessionStart?.(session);
    // After deny_once, the next call still goes through ask (not pre-denied by session)
    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), createSpyToolHandler().handler);
    } catch {
      /* expected */
    }
    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), createSpyToolHandler().handler);
    } catch {
      /* expected */
    }
    expect(onAsk).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Session isolation
// ---------------------------------------------------------------------------

describe("session isolation", () => {
  test("session A's allow_session does NOT affect session B", async () => {
    const sessionA = createMockSessionContext({
      sessionId: "session-a" as ReturnType<typeof createMockSessionContext>["sessionId"],
    });
    const ctxA = createMockTurnContext({ session: sessionA });
    const sessionB = createMockSessionContext({
      sessionId: "session-b" as ReturnType<typeof createMockSessionContext>["sessionId"],
    });
    const ctxB = createMockTurnContext({ session: sessionB });

    let callCount = 0;
    const onAsk = async (_req: ExecApprovalRequest): Promise<ProgressiveDecision> => {
      callCount++;
      return { kind: "allow_session", pattern: "bash" };
    };

    const mw = createExecApprovalsMiddleware({
      rules: { allow: [], deny: [], ask: ["bash"] },
      onAsk,
    });

    await mw.onSessionStart?.(sessionA);
    await mw.onSessionStart?.(sessionB);

    // A gets allow_session
    await mw.wrapToolCall?.(ctxA, makeToolRequest("bash"), createSpyToolHandler().handler);
    expect(callCount).toBe(1);

    // A's second call uses cached session allow — no prompt
    await mw.wrapToolCall?.(ctxA, makeToolRequest("bash"), createSpyToolHandler().handler);
    expect(callCount).toBe(1);

    // B must still prompt — not affected by A's session allow
    await mw.wrapToolCall?.(ctxB, makeToolRequest("bash"), createSpyToolHandler().handler);
    expect(callCount).toBe(2);
  });

  test("after onSessionEnd, re-started session does not see old state", async () => {
    const { session, ctx } = makeSession("session-cleanup");
    let callCount = 0;
    const onAsk = async (_req: ExecApprovalRequest): Promise<ProgressiveDecision> => {
      callCount++;
      return { kind: "allow_session", pattern: "bash" };
    };
    const mw = createExecApprovalsMiddleware({
      rules: { allow: [], deny: [], ask: ["bash"] },
      onAsk,
    });

    await mw.onSessionStart?.(session);
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), createSpyToolHandler().handler);
    expect(callCount).toBe(1);

    // Cached — no prompt
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), createSpyToolHandler().handler);
    expect(callCount).toBe(1);

    // End session — clears state
    await mw.onSessionEnd?.(session);

    // Re-start session — fresh state, no cache
    await mw.onSessionStart?.(session);
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), createSpyToolHandler().handler);
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Error resilience
// ---------------------------------------------------------------------------

describe("error resilience", () => {
  test("store.load() failure → onLoadError called, session starts normally", async () => {
    const { session, ctx } = makeSession();
    const loadError = new Error("disk failure");
    const badStore: ExecRulesStore = {
      load: async () => {
        throw loadError;
      },
      save: async () => {},
    };
    const loadErrors: unknown[] = [];
    const mw = createExecApprovalsMiddleware({
      rules: { allow: ["bash"], deny: [], ask: [] },
      onAsk: makeOnAsk({ kind: "allow_once" }),
      store: badStore,
      onLoadError: (e) => loadErrors.push(e),
    });
    await mw.onSessionStart?.(session);
    expect(loadErrors).toHaveLength(1);
    expect(loadErrors[0]).toBe(loadError);
    // Session started normally — allow rule works
    const spy = createSpyToolHandler();
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), spy.handler);
    expect(spy.calls).toHaveLength(1);
  });

  test("store.save() failure → onSaveError called, tool call still proceeds", async () => {
    const { session, ctx } = makeSession();
    const saveError = new Error("disk full");
    const flakyStore: ExecRulesStore = {
      load: async () => ({ allow: [], deny: [] }),
      save: async () => {
        throw saveError;
      },
    };
    const saveErrors: unknown[] = [];
    const onAsk = async (_req: ExecApprovalRequest): Promise<ProgressiveDecision> => ({
      kind: "allow_always",
      pattern: "bash",
    });
    const mw = createExecApprovalsMiddleware({
      rules: { allow: [], deny: [], ask: ["bash"] },
      onAsk,
      store: flakyStore,
      onSaveError: (e) => saveErrors.push(e),
    });
    await mw.onSessionStart?.(session);
    const spy = createSpyToolHandler();
    // Should NOT throw even though save fails
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), spy.handler);
    expect(spy.calls).toHaveLength(1);
    expect(saveErrors).toHaveLength(1);
    expect(saveErrors[0]).toBe(saveError);
  });
});

// ---------------------------------------------------------------------------
// Compound pattern integration
// ---------------------------------------------------------------------------

describe("compound pattern integration", () => {
  test("ask pattern with input matches correct commands only", async () => {
    const { session, ctx } = makeSession();
    const onAsk = mock(makeOnAsk({ kind: "allow_once" }));
    const mw = createExecApprovalsMiddleware({
      rules: { allow: ["bash:ls*"], deny: ["bash:rm*"], ask: ["bash:git push*"] },
      onAsk,
    });
    await mw.onSessionStart?.(session);

    // allow pattern
    const spy = createSpyToolHandler();
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash", "ls -la"), spy.handler);
    expect(spy.calls).toHaveLength(1);
    expect(onAsk).not.toHaveBeenCalled();

    // deny pattern
    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("bash", "rm -rf /"), spy.handler);
      expect.unreachable();
    } catch (e) {
      expect((e as KoiError).code).toBe("PERMISSION");
    }
    expect(onAsk).not.toHaveBeenCalled();

    // ask pattern
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash", "git push origin main"), spy.handler);
    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(spy.calls).toHaveLength(2);

    // unmatched → default deny
    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("bash", "cat /etc/passwd"), spy.handler);
      expect.unreachable();
    } catch (e) {
      expect((e as KoiError).code).toBe("PERMISSION");
    }
  });
});
