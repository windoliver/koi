import { describe, expect, mock, test } from "bun:test";
import type { JsonObject } from "@koi/core/common";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import type {
  PermissionBackend,
  PermissionDecision,
  PermissionQuery,
} from "@koi/core/permission-backend";
import { createPermissionsMiddleware } from "../middleware.js";

// ---------------------------------------------------------------------------
// Test helpers (minimal — mirrors middleware.test.ts)
// ---------------------------------------------------------------------------

function makeTurnContext(overrides?: {
  readonly sessionId?: string;
  readonly turnIndex?: number;
  readonly requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
}): TurnContext {
  const base = {
    session: {
      agentId: "agent:test",
      sessionId: (overrides?.sessionId ?? "s-1") as never,
      runId: "r-1" as never,
      userId: "user-1",
      metadata: {},
    },
    turnIndex: overrides?.turnIndex ?? 0,
    turnId: "t-1" as never,
    messages: [] as const,
    metadata: {},
  };
  if (overrides?.requestApproval !== undefined) {
    return { ...base, requestApproval: overrides.requestApproval };
  }
  return base;
}

function makeToolRequest(toolId: string, input: JsonObject = {}): ToolRequest {
  return { toolId, input };
}

const noopHandler = async (_req: ToolRequest): Promise<ToolResponse> => ({ output: "ok" });

function recordingBackend(): { backend: PermissionBackend; seen: string[] } {
  const seen: string[] = [];
  const backend: PermissionBackend = {
    check(q: PermissionQuery): PermissionDecision {
      seen.push(q.resource);
      return { effect: "allow" };
    },
  };
  return { backend, seen };
}

function ruleBackend(allow: readonly string[]): PermissionBackend {
  return {
    check(q: PermissionQuery): PermissionDecision {
      for (const pattern of allow) {
        if (pattern === "*") return { effect: "allow" };
        if (pattern.endsWith("*")) {
          if (q.resource.startsWith(pattern.slice(0, -1))) return { effect: "allow" };
        } else if (q.resource === pattern) {
          return { effect: "allow" };
        }
      }
      return { effect: "deny", reason: `no rule for ${q.resource}` };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bash prefix resource enrichment", () => {
  test("without resolveBashCommand, resource is the tool name only", async () => {
    const { backend, seen } = recordingBackend();
    const mw = createPermissionsMiddleware({ backend });
    await mw.wrapToolCall?.(
      makeTurnContext(),
      makeToolRequest("bash", { command: "git push origin main" }),
      noopHandler,
    );
    expect(seen).toEqual(["bash"]);
  });

  test("with resolveBashCommand, resource is enriched to `<toolId>:<prefix>`", async () => {
    const { backend, seen } = recordingBackend();
    const mw = createPermissionsMiddleware({
      backend,
      resolveBashCommand: (_toolId, input) =>
        typeof input.command === "string" ? (input.command as string) : undefined,
    });
    await mw.wrapToolCall?.(
      makeTurnContext(),
      makeToolRequest("bash", { command: "git push origin main" }),
      noopHandler,
    );
    expect(seen).toEqual(["bash:git push"]);
  });

  test("npm run subcommand uses arity 3", async () => {
    const { backend, seen } = recordingBackend();
    const mw = createPermissionsMiddleware({
      backend,
      resolveBashCommand: (_toolId, input) => input.cmd as string,
    });
    await mw.wrapToolCall?.(
      makeTurnContext(),
      makeToolRequest("shell", { cmd: "npm run build -- --watch" }),
      noopHandler,
    );
    expect(seen).toEqual(["shell:npm run build"]);
  });

  test("resolver returning undefined falls back to the plain tool name", async () => {
    const { backend, seen } = recordingBackend();
    const mw = createPermissionsMiddleware({
      backend,
      resolveBashCommand: () => undefined,
    });
    await mw.wrapToolCall?.(makeTurnContext(), makeToolRequest("bash", {}), noopHandler);
    expect(seen).toEqual(["bash"]);
  });

  test("resolver returning empty string falls back to the plain tool name", async () => {
    const { backend, seen } = recordingBackend();
    const mw = createPermissionsMiddleware({
      backend,
      resolveBashCommand: () => "   ",
    });
    await mw.wrapToolCall?.(makeTurnContext(), makeToolRequest("bash", {}), noopHandler);
    expect(seen).toEqual(["bash"]);
  });

  test("rule `bash:git push` allows git push but not git status", async () => {
    const backend = ruleBackend(["bash:git push"]);
    const mw = createPermissionsMiddleware({
      backend,
      resolveBashCommand: (_toolId, input) => input.command as string,
    });

    // allowed
    await mw.wrapToolCall?.(
      makeTurnContext(),
      makeToolRequest("bash", { command: "git push origin main" }),
      noopHandler,
    );

    // denied (different prefix)
    await expect(
      mw.wrapToolCall?.(
        makeTurnContext(),
        makeToolRequest("bash", { command: "git status" }),
        noopHandler,
      ),
    ).rejects.toThrow();
  });

  test("rule `bash:git *` (prefix wildcard) allows all git subcommands", async () => {
    const backend = ruleBackend(["bash:git *"]);
    const mw = createPermissionsMiddleware({
      backend,
      resolveBashCommand: (_toolId, input) => input.command as string,
    });

    for (const cmd of ["git push origin main", "git status", "git log --oneline"]) {
      await mw.wrapToolCall?.(
        makeTurnContext(),
        makeToolRequest("bash", { command: cmd }),
        noopHandler,
      );
    }
  });

  test("resolver is never called for non-bash tools (caller decides)", async () => {
    let called = false;
    const { backend, seen } = recordingBackend();
    const mw = createPermissionsMiddleware({
      backend,
      resolveBashCommand: (toolId, _input) => {
        called = true;
        // Caller scopes by toolId — return undefined for non-bash tools
        return toolId === "bash" ? "git status" : undefined;
      },
    });

    await mw.wrapToolCall?.(
      makeTurnContext(),
      makeToolRequest("fs_read", { path: "/tmp/x" }),
      noopHandler,
    );
    expect(called).toBe(true); // invoked, but returned undefined
    expect(seen).toEqual(["fs_read"]); // not enriched
  });

  test("empty tokens produce no colon suffix (prefix fallback to tool name)", async () => {
    const { backend, seen } = recordingBackend();
    const mw = createPermissionsMiddleware({
      backend,
      resolveBashCommand: () => "",
    });
    await mw.wrapToolCall?.(makeTurnContext(), makeToolRequest("bash", {}), noopHandler);
    expect(seen).toEqual(["bash"]);
  });
});

// ---------------------------------------------------------------------------
// Regression tests for approval + denial tracking scoping (PR review)
// ---------------------------------------------------------------------------

describe("bash prefix — denial + approval tracking is scoped per prefix", () => {
  test("denial escalation triggers per-prefix, not across prefixes", async () => {
    // Escalation: after 2 denies of the same resource, the tracker auto-denies
    // even without backend consultation. We deny `bash:rm` twice, then check
    // that `bash:ls` is still allowed (separate escalation bucket).
    const backend: PermissionBackend = {
      check(q: PermissionQuery): PermissionDecision {
        if (q.resource === "bash:rm") return { effect: "deny", reason: "nope" };
        return { effect: "allow" };
      },
    };
    const mw = createPermissionsMiddleware({
      backend,
      denialEscalation: { threshold: 2, windowMs: 60_000 },
      resolveBashCommand: (_toolId, input) => input.command as string,
    });
    const ctx = makeTurnContext({ sessionId: "s-escalation" });

    // Two denied `bash:rm` calls
    await expect(
      mw.wrapToolCall?.(ctx, makeToolRequest("bash", { command: "rm foo" }), noopHandler),
    ).rejects.toThrow();
    await expect(
      mw.wrapToolCall?.(ctx, makeToolRequest("bash", { command: "rm bar" }), noopHandler),
    ).rejects.toThrow();

    // `bash:ls` must still be allowed — escalation bucket is per resource.
    // If escalation leaked across prefixes, this would throw.
    const result = await mw.wrapToolCall?.(
      ctx,
      makeToolRequest("bash", { command: "ls -la" }),
      noopHandler,
    );
    expect(result?.output).toBe("ok");
  });

  test("always-allow on one prefix does not auto-approve other prefixes", async () => {
    // Backend returns ask for everything → forces the approval flow.
    const backend: PermissionBackend = {
      check: () => ({ effect: "ask", reason: "review" }),
    };

    // Approval handler grants always-allow for the FIRST call only. If the
    // grant leaks across prefixes, the second call (different prefix) should
    // bypass this handler. Track invocations to detect leakage.
    const approvals: string[] = [];
    const approvalHandler = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
      approvals.push(req.toolId);
      // First call: grant always-allow. Subsequent calls: deny.
      if (approvals.length === 1) {
        return { kind: "always-allow", scope: "session" };
      }
      return { kind: "deny", reason: "not approved" };
    };

    const mw = createPermissionsMiddleware({
      backend,
      resolveBashCommand: (_toolId, input) => input.command as string,
    });

    const ctx = makeTurnContext({
      sessionId: "s-grant",
      requestApproval: approvalHandler,
    });

    // 1st call: approve `bash:git status` with always-allow session
    const r1 = await mw.wrapToolCall?.(
      ctx,
      makeToolRequest("bash", { command: "git status" }),
      noopHandler,
    );
    expect(r1?.output).toBe("ok");

    // 2nd call: repeat `bash:git status` → session grant auto-approves (handler NOT called)
    await mw.wrapToolCall?.(
      ctx,
      makeToolRequest("bash", { command: "git status --short" }),
      noopHandler,
    );
    expect(approvals).toHaveLength(1); // still just the first

    // 3rd call: DIFFERENT prefix `bash:rm` → handler must be consulted again.
    // If the grant leaked, approvalHandler would not be called and the tool
    // would auto-execute — bypassing human review for an unrelated command.
    await expect(
      mw.wrapToolCall?.(ctx, makeToolRequest("bash", { command: "rm -rf /tmp" }), noopHandler),
    ).rejects.toThrow("not approved");
    expect(approvals).toHaveLength(2); // handler WAS consulted for rm
  });

  test("persistent always-allow grant is keyed on enriched resource", async () => {
    // Simulate a persistent store that only knows one grant: `bash:git status`
    const grants = new Set<string>();
    const persistentApprovals = {
      has: mock((_u: string, _a: string, toolId: string) => grants.has(toolId)),
      grant: mock((_u: string, _a: string, toolId: string, _t: number) => {
        grants.add(toolId);
      }),
      revoke: mock(() => true),
      revokeAll: mock(() => {
        grants.clear();
      }),
      list: mock(() => []),
      close: mock(() => {}),
    };

    // Pre-seed a grant for the enriched resource
    grants.add("bash:git status");

    const backend: PermissionBackend = {
      check: () => ({ effect: "ask", reason: "review" }),
    };

    const approvalHandler = mock(
      async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({ kind: "deny", reason: "x" }),
    );

    const mw = createPermissionsMiddleware({
      backend,
      persistentApprovals,
      resolveBashCommand: (_toolId, input) => input.command as string,
    });

    const ctx = makeTurnContext({ requestApproval: approvalHandler });

    // `bash:git status` → persistent grant hit, auto-approved without prompting
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash", { command: "git status" }), noopHandler);
    expect(approvalHandler).not.toHaveBeenCalled();

    // `bash:rm` → NOT granted, must prompt (handler returns deny)
    await expect(
      mw.wrapToolCall?.(ctx, makeToolRequest("bash", { command: "rm foo" }), noopHandler),
    ).rejects.toThrow();
    expect(approvalHandler).toHaveBeenCalledTimes(1);

    // Persistent store was queried with the enriched resource
    expect(persistentApprovals.has).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "bash:git status",
    );
    expect(persistentApprovals.has).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "bash:rm",
    );
  });
});
