import { describe, expect, test } from "bun:test";
import type { JsonObject } from "@koi/core/common";
import type { ToolRequest, ToolResponse, TurnContext } from "@koi/core/middleware";
import type {
  PermissionBackend,
  PermissionDecision,
  PermissionQuery,
} from "@koi/core/permission-backend";
import { createPermissionsMiddleware } from "../middleware.js";

// ---------------------------------------------------------------------------
// Test helpers (minimal — mirrors middleware.test.ts)
// ---------------------------------------------------------------------------

function makeTurnContext(): TurnContext {
  return {
    session: {
      agentId: "agent:test",
      sessionId: "s-1" as never,
      runId: "r-1" as never,
      userId: "user-1",
      metadata: {},
    },
    turnIndex: 0,
    turnId: "t-1" as never,
    messages: [],
    metadata: {},
  };
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
