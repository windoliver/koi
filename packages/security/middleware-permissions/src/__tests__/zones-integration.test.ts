import { describe, expect, mock, test } from "bun:test";
import {
  createDefaultRiskScorer,
  createZoneEvaluator,
  EDIT_TEST_FILES_PROFILE,
  READ_ONLY_PROFILE,
} from "@koi/approval-zones";
import type { JsonObject } from "@koi/core/common";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import type { PermissionBackend, PermissionDecision } from "@koi/core/permission-backend";
import { createPermissionsMiddleware } from "../middleware.js";

const IS_DEFAULT_ASK_TEST: symbol = Symbol.for("@koi/permissions/default-fallthrough-ask");

function askBackend(): PermissionBackend {
  return {
    check: (): PermissionDecision =>
      ({
        effect: "ask",
        reason: "needs approval",
        [IS_DEFAULT_ASK_TEST]: true,
      }) as PermissionDecision,
  };
}

function makeTurnContext(
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>,
): TurnContext {
  const base = {
    session: {
      agentId: "agent:test",
      sessionId: "s-1" as never,
      runId: "r-1" as never,
      userId: "user-1",
      metadata: {},
    },
    turnIndex: 0,
    turnId: "t-1" as never,
    messages: [] as const,
    metadata: {},
  };
  return requestApproval !== undefined ? { ...base, requestApproval } : base;
}

function makeToolRequest(toolId: string, input: JsonObject = {}): ToolRequest {
  return { toolId, input };
}

const noopToolHandler = async (_req: ToolRequest): Promise<ToolResponse> => ({ output: "done" });

/** Extract absolute path from tool input.path for zone risk scoring. */
function resolveToolPath(_toolId: string, input: JsonObject): string | undefined {
  return typeof input.path === "string" ? (input.path as string) : undefined;
}

const scorer = createDefaultRiskScorer({ projectRoot: "/proj" });

describe("zones integration with createPermissionsMiddleware", () => {
  test("READ_ONLY_PROFILE auto-allows read without prompting", async () => {
    const evaluator = createZoneEvaluator({
      zones: READ_ONLY_PROFILE,
      scorer,
    });
    const approvalHandler = mock(
      async (): Promise<ApprovalDecision> => ({ kind: "deny", reason: "test-deny" }),
    );
    const mw = createPermissionsMiddleware({
      backend: askBackend(),
      resolveToolPath,
      zones: { evaluator },
    });
    const ctx = makeTurnContext(approvalHandler);
    const result = await mw.wrapToolCall?.(
      ctx,
      makeToolRequest("read", { path: "/proj/readme.md" }),
      noopToolHandler,
    );
    expect(result?.output).toBe("done");
    expect(approvalHandler).not.toHaveBeenCalled();
  });

  test("EDIT_TEST_FILES_PROFILE: fall-through on non-test path prompts user", async () => {
    const evaluator = createZoneEvaluator({
      zones: EDIT_TEST_FILES_PROFILE,
      scorer,
    });
    const approvalHandler = mock(async (): Promise<ApprovalDecision> => ({ kind: "allow" }));
    const mw = createPermissionsMiddleware({
      backend: askBackend(),
      resolveToolPath,
      zones: { evaluator },
    });
    const ctx = makeTurnContext(approvalHandler);
    await mw.wrapToolCall?.(
      ctx,
      makeToolRequest("edit", { path: "/proj/src/foo.ts" }),
      noopToolHandler,
    );
    expect(approvalHandler).toHaveBeenCalled();
  });

  test("omitting zones config leaves prompt path unchanged", async () => {
    const approvalHandler = mock(async (): Promise<ApprovalDecision> => ({ kind: "allow" }));
    const mw = createPermissionsMiddleware({ backend: askBackend() });
    const ctx = makeTurnContext(approvalHandler);
    await mw.wrapToolCall?.(ctx, makeToolRequest("read"), noopToolHandler);
    expect(approvalHandler).toHaveBeenCalled();
  });
});
