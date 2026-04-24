import { beforeAll, describe, expect, test } from "bun:test";
import { initializeBashAst } from "@koi/bash-ast";
import type { ToolRequest, TurnContext } from "@koi/core/middleware";
import type {
  PermissionBackend,
  PermissionDecision,
  PermissionQuery,
} from "@koi/core/permission-backend";
import { createPermissionsMiddleware } from "../middleware.js";

beforeAll(async () => {
  await initializeBashAst();
});

function makePrefixBackend(
  rules: Array<{
    prefix: string;
    action?: string;
    effect: "allow" | "deny" | "ask";
    reason?: string;
  }>,
): PermissionBackend {
  return {
    supportsDefaultDenyMarker: true,
    async check(q: PermissionQuery): Promise<PermissionDecision> {
      for (const rule of rules) {
        const resourceMatch =
          rule.prefix === "*" || q.resource.startsWith(rule.prefix) || q.resource === rule.prefix;
        const actionMatch = !rule.action || rule.action === "*" || q.action === rule.action;
        if (resourceMatch && actionMatch) {
          if (rule.effect === "deny") {
            return { effect: "deny", reason: rule.reason ?? "denied", disposition: "hard" };
          }
          if (rule.effect === "ask") return { effect: "ask", reason: rule.reason ?? "ask" };
          return { effect: "allow" };
        }
      }
      return {
        effect: "deny",
        reason: "default deny",
        disposition: "hard",
        default: true,
      } as PermissionDecision;
    },
  };
}

function makeTurnCtx(reported: { action?: string; toolId?: string }[] = []): TurnContext {
  return {
    session: {
      sessionId: "test-session" as ReturnType<typeof import("@koi/core").sessionId>,
      agentId: "agent:test",
      userId: undefined,
      metadata: {},
    },
    turnIndex: 0,
    metadata: {},
    reportDecision: (d: { action: string; toolId: string }) => {
      reported.push({ action: d.action, toolId: d.toolId });
    },
    dispatchPermissionDecision: async () => {},
  } as unknown as TurnContext;
}

function makeBashReq(command: string): ToolRequest {
  return {
    toolId: "bash",
    input: { command },
    metadata: {},
  } as ToolRequest;
}

describe("wrapToolCall — bash spec guard integration", () => {
  test("rm /etc/passwd denied by Write(/etc/**) rule even when bash:rm prefix allows", async () => {
    const reported: { action?: string; toolId?: string }[] = [];
    const backend = makePrefixBackend([
      { prefix: "bash:rm", effect: "allow" }, // prefix rule allows rm
      { prefix: "/etc/", action: "write", effect: "deny", reason: "no writes to /etc" },
      { prefix: "*", effect: "allow" }, // catch-all
    ]);

    const mw = createPermissionsMiddleware({
      backend,
      resolveBashCommand: (_toolId, input) => (input as Record<string, string | undefined>).command,
      enableBashSpecGuard: true,
    });

    let nextCalled = false;
    await mw
      .wrapToolCall?.(makeTurnCtx(reported), makeBashReq("rm /etc/passwd"), async () => {
        nextCalled = true;
        return { toolId: "bash", output: "" };
      })
      .catch(() => {});

    const decisions = reported.map((r) => r.action);
    expect(nextCalled).toBe(false);
    expect(decisions).toContain("deny");
  });

  test("ssh host downgraded from allow to ask by exact-argv guard", async () => {
    const backend = makePrefixBackend([
      { prefix: "bash:", effect: "allow" }, // broad bash: prefix allow
    ]);

    const mw = createPermissionsMiddleware({
      backend,
      resolveBashCommand: (_toolId, input) => (input as Record<string, string | undefined>).command,
      enableBashSpecGuard: true,
    });

    // Use a catch to handle the approval timeout (no approval handler configured)
    let decisionSeen: string | undefined;
    const ctx = makeTurnCtx([]);
    (ctx as unknown as Record<string, unknown>).reportDecision = (d: { action: string }) => {
      decisionSeen = d.action;
    };

    await mw
      .wrapToolCall?.(ctx, makeBashReq("ssh prod-host"), async () => {
        return { toolId: "bash", output: "" };
      })
      .catch(() => {});

    // ssh is refused → prefix allow is downgraded to ask
    expect(decisionSeen).toBe("ask");
  });

  test("rm /tmp/safe allowed when no deny rules", async () => {
    const reported: { action?: string }[] = [];
    const backend = makePrefixBackend([
      { prefix: "bash:rm", effect: "allow" },
      { prefix: "/tmp/", action: "write", effect: "allow" },
      { prefix: "*", effect: "allow" },
    ]);

    const mw = createPermissionsMiddleware({
      backend,
      resolveBashCommand: (_toolId, input) => (input as Record<string, string | undefined>).command,
      enableBashSpecGuard: true,
    });

    let nextCalled = false;
    await mw.wrapToolCall?.(makeTurnCtx(reported), makeBashReq("rm /tmp/safe"), async () => {
      nextCalled = true;
      return { toolId: "bash", output: "" };
    });

    expect(nextCalled).toBe(true);
  });

  test("spec guard disabled when enableBashSpecGuard: false", async () => {
    const reported: { action?: string }[] = [];
    const backend = makePrefixBackend([
      { prefix: "bash:", effect: "allow" }, // broad allow
      // No Write rule — spec guard is disabled so this won't matter
    ]);

    const mw = createPermissionsMiddleware({
      backend,
      resolveBashCommand: (_toolId, input) => (input as Record<string, string | undefined>).command,
      enableBashSpecGuard: false, // disabled
    });

    let nextCalled = false;
    await mw.wrapToolCall?.(makeTurnCtx(reported), makeBashReq("rm /etc/passwd"), async () => {
      nextCalled = true;
      return { toolId: "bash", output: "" };
    });

    // Guard disabled → existing allow flows through
    expect(nextCalled).toBe(true);
  });
});
