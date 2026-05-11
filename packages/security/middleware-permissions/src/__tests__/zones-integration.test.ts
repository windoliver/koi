import { describe, expect, mock, test } from "bun:test";
import {
  createDefaultRiskScorer,
  createZoneEvaluator,
  EDIT_TEST_FILES_PROFILE,
  READ_ONLY_PROFILE,
  SCRIPTED_CLEANUP_PROFILE,
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

  test("zone-auto emits a durable permission_decision audit entry via AuditSink.log()", async () => {
    const evaluator = createZoneEvaluator({
      zones: READ_ONLY_PROFILE,
      scorer,
    });
    const logged: unknown[] = [];
    const auditSink = {
      log: async (entry: unknown): Promise<void> => {
        logged.push(entry);
      },
    };
    const mw = createPermissionsMiddleware({
      backend: askBackend(),
      resolveToolPath,
      auditSink,
      zones: { evaluator },
    });
    // Supply a never-called approval handler — middleware's "no handler" guard
    // runs before zone interception in the current code path. Zones bypass
    // prompting on auto-allow, so this mock must NOT be invoked.
    const unusedHandler = mock(
      async (): Promise<ApprovalDecision> => ({ kind: "deny", reason: "unused" }),
    );
    const ctx = makeTurnContext(unusedHandler);
    await mw.wrapToolCall?.(
      ctx,
      makeToolRequest("read", { path: "/proj/readme.md" }),
      noopToolHandler,
    );
    const zoneEntry = logged.find(
      (e): e is { kind: string; metadata: { permissionEvent: string } } =>
        typeof e === "object" &&
        e !== null &&
        (e as { kind?: unknown }).kind === "permission_decision" &&
        (e as { metadata?: { permissionEvent?: unknown } }).metadata?.permissionEvent ===
          "zone-auto",
    );
    expect(zoneEntry).toBeDefined();
    expect(unusedHandler).not.toHaveBeenCalled();
  });

  test("SCRIPTED_CLEANUP_PROFILE: bash ls /tmp/work triggers sandbox-then-auto path", async () => {
    const evaluator = createZoneEvaluator({
      zones: SCRIPTED_CLEANUP_PROFILE,
      scorer,
    });
    const exec = mock(async () => ({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      oomKilled: false,
    }));
    const destroy = mock(async () => {});
    const sandboxRouter = {
      create: mock(async () => ({
        ok: true as const,
        value: {
          instance: {
            exec,
            readFile: async () => new Uint8Array(),
            writeFile: async () => {},
            destroy,
          },
          decision: { selected: { name: "default" } },
        },
      })),
      describe: () => [],
      shutdown: async () => {},
    };
    const unusedHandler = mock(
      async (): Promise<ApprovalDecision> => ({ kind: "deny", reason: "unused" }),
    );
    const mw = createPermissionsMiddleware({
      backend: askBackend(),
      resolveToolPath,
      zones: {
        evaluator,
        sandboxRouter: sandboxRouter as unknown as Parameters<
          typeof createPermissionsMiddleware
        >[0]["zones"] extends infer Z
          ? Z extends { sandboxRouter?: infer R }
            ? R
            : never
          : never,
      },
    });
    const ctx = makeTurnContext(unusedHandler);
    const result = await mw.wrapToolCall?.(
      ctx,
      makeToolRequest("bash", { command: "ls /tmp/work" }),
      noopToolHandler,
    );
    expect(result?.output).toBe("done");
    expect(exec).toHaveBeenCalled();
    expect(destroy).toHaveBeenCalled();
    expect(unusedHandler).not.toHaveBeenCalled();
  });

  test("omitting zones config leaves prompt path unchanged", async () => {
    const approvalHandler = mock(async (): Promise<ApprovalDecision> => ({ kind: "allow" }));
    const mw = createPermissionsMiddleware({ backend: askBackend() });
    const ctx = makeTurnContext(approvalHandler);
    await mw.wrapToolCall?.(ctx, makeToolRequest("read"), noopToolHandler);
    expect(approvalHandler).toHaveBeenCalled();
  });
});
