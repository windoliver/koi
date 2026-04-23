import { describe, expect, it, mock } from "bun:test";
import type { JsonObject } from "@koi/core";
import { sessionId as toSessionId } from "@koi/core";
import { askId, type GovernanceVerdict } from "@koi/core/governance-backend";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ModelRequest,
  TurnContext,
} from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import type { GovernanceMiddlewareConfig } from "../config.js";
import { createGovernanceMiddleware } from "../governance-middleware.js";

function makeCtx(
  overrides: {
    readonly sessionId?: string;
    readonly requestApproval?: ApprovalHandler | undefined;
  } = {},
): TurnContext {
  const sId = overrides.sessionId ?? "sess-1";
  return {
    session: {
      agentId: "agent-1",
      sessionId: toSessionId(sId),
      runId: "run-1" as never,
      metadata: {} as JsonObject,
    },
    turnIndex: 0,
    turnId: "t-0" as never,
    messages: [],
    metadata: {} as JsonObject,
    ...(overrides.requestApproval !== undefined
      ? { requestApproval: overrides.requestApproval }
      : {}),
  } as TurnContext;
}

function makeConfig(
  overrides: Partial<GovernanceMiddlewareConfig> & {
    readonly verdict: GovernanceVerdict;
  },
): GovernanceMiddlewareConfig {
  const { verdict, ...rest } = overrides;
  return {
    backend: {
      evaluator: { evaluate: () => verdict },
    },
    controller: {
      checkAll: async () => ({ ok: true }) as never,
      record: async () => undefined,
      snapshot: () => ({}) as never,
    },
    cost: { calculate: () => 0 },
    ...rest,
  } as GovernanceMiddlewareConfig;
}

const askVerdict = (id = "ask-1"): GovernanceVerdict => ({
  ok: "ask",
  prompt: "Allow this?",
  askId: askId(id),
});

function modelReq(): ModelRequest {
  return { model: "m", messages: [] } as ModelRequest;
}

describe("gate() — ask verdict", () => {
  it("resolves when handler returns ApprovalDecision.allow", async () => {
    const handler = mock<ApprovalHandler>(async () => ({ kind: "allow" }) as ApprovalDecision);
    const mw = createGovernanceMiddleware(makeConfig({ verdict: askVerdict() }));
    const ctx = makeCtx({ requestApproval: handler });
    const next = async (): Promise<never> => ({ content: "ok" }) as never;
    if (mw.wrapModelCall === undefined) throw new Error("wrapModelCall missing");

    await expect(mw.wrapModelCall(ctx, modelReq(), next)).resolves.toBeDefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // --- Task 8: deny + modify + empty-reason fallback ---

  it("throws PERMISSION with the decision reason on ApprovalDecision.deny", async () => {
    const handler = mock<ApprovalHandler>(
      async () => ({ kind: "deny", reason: "user rejected" }) as ApprovalDecision,
    );
    const mw = createGovernanceMiddleware(makeConfig({ verdict: askVerdict() }));
    const ctx = makeCtx({ requestApproval: handler });
    const next = async () => ({ content: "x" }) as never;

    try {
      if (mw.wrapModelCall === undefined) throw new Error("expected wrapModelCall");
      await mw.wrapModelCall(ctx, modelReq(), next);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      expect((e as KoiRuntimeError).code).toBe("PERMISSION");
      expect((e as KoiRuntimeError).message).toBe("user rejected");
    }
  });

  it("throws PERMISSION with 'modification not supported' on ApprovalDecision.modify", async () => {
    const handler = mock<ApprovalHandler>(
      async () => ({ kind: "modify", updatedInput: {} }) as ApprovalDecision,
    );
    const mw = createGovernanceMiddleware(makeConfig({ verdict: askVerdict() }));
    const ctx = makeCtx({ requestApproval: handler });
    const next = async () => ({ content: "x" }) as never;

    try {
      if (mw.wrapModelCall === undefined) throw new Error("expected wrapModelCall");
      await mw.wrapModelCall(ctx, modelReq(), next);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      expect((e as KoiRuntimeError).code).toBe("PERMISSION");
      expect((e as KoiRuntimeError).message).toMatch(/do not support input modification/i);
    }
  });

  it("throws PERMISSION with the prompt when decision.reason is empty", async () => {
    const handler = mock<ApprovalHandler>(
      async () => ({ kind: "deny", reason: "" }) as ApprovalDecision,
    );
    const mw = createGovernanceMiddleware(makeConfig({ verdict: askVerdict() }));
    const ctx = makeCtx({ requestApproval: handler });
    const next = async () => ({ content: "x" }) as never;

    try {
      if (mw.wrapModelCall === undefined) throw new Error("expected wrapModelCall");
      await mw.wrapModelCall(ctx, modelReq(), next);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as KoiRuntimeError).message).toBe("Allow this?");
    }
  });

  // --- Task 9: fail-closed when no handler ---

  it("throws PERMISSION when ctx.requestApproval is undefined", async () => {
    const mw = createGovernanceMiddleware(makeConfig({ verdict: askVerdict() }));
    const ctx = makeCtx(); // no handler
    const next = async () => ({ content: "x" }) as never;

    try {
      if (mw.wrapModelCall === undefined) throw new Error("expected wrapModelCall");
      await mw.wrapModelCall(ctx, modelReq(), next);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      expect((e as KoiRuntimeError).code).toBe("PERMISSION");
      expect((e as KoiRuntimeError).message).toMatch(/no handler is configured/);
    }
  });

  // --- Task 10: always-allow (session) fast-path ---

  it("always-allow session: second identical call skips the handler", async () => {
    const handler = mock<ApprovalHandler>(
      async () => ({ kind: "always-allow", scope: "session" }) as ApprovalDecision,
    );
    const onApprovalPersist = mock(() => undefined);
    const mw = createGovernanceMiddleware(makeConfig({ verdict: askVerdict(), onApprovalPersist }));
    const ctx = makeCtx({ requestApproval: handler });
    const next = async () => ({ content: "x" }) as never;

    if (mw.wrapModelCall === undefined) throw new Error("expected wrapModelCall");
    await mw.wrapModelCall(ctx, modelReq(), next);
    await mw.wrapModelCall(ctx, modelReq(), next);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(onApprovalPersist).not.toHaveBeenCalled();
  });

  // --- Task 11: always-allow (always) fires onApprovalPersist ---

  it("always-allow scope=always: fires onApprovalPersist with PersistentGrant", async () => {
    const handler = mock<ApprovalHandler>(
      async () => ({ kind: "always-allow", scope: "always" }) as ApprovalDecision,
    );
    const grants: unknown[] = [];
    const onApprovalPersist = (g: unknown): void => {
      grants.push(g);
    };

    const mw = createGovernanceMiddleware(
      makeConfig({ verdict: askVerdict(), onApprovalPersist: onApprovalPersist as never }),
    );
    const ctx = makeCtx({ requestApproval: handler });
    const next = async () => ({ content: "x" }) as never;

    if (mw.wrapModelCall === undefined) throw new Error("expected wrapModelCall");
    await mw.wrapModelCall(ctx, modelReq(), next);

    expect(grants).toHaveLength(1);
    const g = grants[0] as Record<string, unknown>;
    expect(g.kind).toBe("model_call");
    expect(g.agentId).toBe("agent-1");
    expect(g.sessionId).toBe("sess-1");
    expect(typeof g.grantKey).toBe("string");
    expect(g.grantKey as string).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof g.grantedAt).toBe("number");
  });

  it("always-allow scope=always also populates session grant (no re-ask on second call)", async () => {
    const handler = mock<ApprovalHandler>(
      async () => ({ kind: "always-allow", scope: "always" }) as ApprovalDecision,
    );
    const mw = createGovernanceMiddleware(
      makeConfig({ verdict: askVerdict(), onApprovalPersist: () => undefined }),
    );
    const ctx = makeCtx({ requestApproval: handler });
    const next = async () => ({ content: "x" }) as never;

    if (mw.wrapModelCall === undefined) throw new Error("expected wrapModelCall");
    await mw.wrapModelCall(ctx, modelReq(), next);
    await mw.wrapModelCall(ctx, modelReq(), next);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  // --- Task 12: timeout ---

  it("throws TIMEOUT when handler does not resolve within approvalTimeoutMs", async () => {
    const handler = mock<ApprovalHandler>(() => new Promise(() => {}));
    const mw = createGovernanceMiddleware(
      makeConfig({ verdict: askVerdict(), approvalTimeoutMs: 20 }),
    );
    const ctx = makeCtx({ requestApproval: handler });
    const next = async () => ({ content: "x" }) as never;

    try {
      if (mw.wrapModelCall === undefined) throw new Error("expected wrapModelCall");
      await mw.wrapModelCall(ctx, modelReq(), next);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      expect((e as KoiRuntimeError).code).toBe("TIMEOUT");
    }
  });

  // --- Task 13: inflight coalescing ---

  it("coalesces two concurrent asks with the same askId into one handler call", async () => {
    let resolveApproval: (d: ApprovalDecision) => void = () => {};
    let handlerInvoked: () => void = () => {};
    const handlerReady = new Promise<void>((r) => {
      handlerInvoked = r;
    });
    const handler = mock<ApprovalHandler>(
      () =>
        new Promise<ApprovalDecision>((res) => {
          resolveApproval = res;
          handlerInvoked();
        }),
    );

    const mw = createGovernanceMiddleware(makeConfig({ verdict: askVerdict("shared-id") }));
    const ctx = makeCtx({ requestApproval: handler });
    const next = async () => ({ content: "x" }) as never;

    if (mw.wrapModelCall === undefined) throw new Error("expected wrapModelCall");
    const p1 = mw.wrapModelCall(ctx, modelReq(), next);
    const p2 = mw.wrapModelCall(ctx, modelReq(), next);

    // Wait for the handler to be invoked (after p1 reaches the coalescing point
    // and p2 attaches to the shared pending promise).
    await handlerReady;
    resolveApproval({ kind: "allow" });

    await expect(p1).resolves.toBeDefined();
    await expect(p2).resolves.toBeDefined();

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
