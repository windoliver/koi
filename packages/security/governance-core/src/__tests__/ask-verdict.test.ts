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
});
