import { describe, expect, mock, test } from "bun:test";
import type { AuditEntry } from "@koi/core";
import type { JsonObject } from "@koi/core/common";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ModelRequest,
  ModelResponse,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import type {
  PermissionBackend,
  PermissionDecision,
  PermissionQuery,
} from "@koi/core/permission-backend";
import { KoiRuntimeError } from "@koi/errors";
import { createPermissionsMiddleware } from "../middleware.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTurnContext(overrides?: {
  readonly userId?: string;
  readonly agentId?: string;
  readonly turnIndex?: number;
  readonly requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
}): TurnContext {
  const base = {
    session: {
      agentId: overrides?.agentId ?? "agent:test",
      sessionId: "s-1" as never,
      runId: "r-1" as never,
      userId: overrides?.userId ?? "user-1",
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

function makeModelRequest(toolNames: readonly string[]): ModelRequest {
  return {
    messages: [],
    tools: toolNames.map((name) => ({
      name,
      description: `Tool ${name}`,
      inputSchema: {},
    })),
  };
}

function makeToolRequest(toolId: string, input: JsonObject = {}): ToolRequest {
  return { toolId, input };
}

const noopModelHandler = async (_req: ModelRequest): Promise<ModelResponse> => ({
  content: "ok",
  model: "test",
});

const noopToolHandler = async (_req: ToolRequest): Promise<ToolResponse> => ({
  output: "done",
});

function allowAll(): PermissionBackend {
  return { check: () => ({ effect: "allow" }) };
}

function denyAll(reason: string = "denied"): PermissionBackend {
  return { check: () => ({ effect: "deny", reason }) };
}

function askAll(reason: string = "needs approval"): PermissionBackend {
  return { check: () => ({ effect: "ask", reason }) };
}

function staticBackend(
  decisions: Readonly<Record<string, PermissionDecision>>,
  fallback: PermissionDecision = { effect: "deny", reason: "no rule" },
): PermissionBackend {
  return {
    check: (query: PermissionQuery) => decisions[query.resource] ?? fallback,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPermissionsMiddleware", () => {
  describe("wrapModelCall — tool filtering", () => {
    test("passes through when no tools", async () => {
      const mw = createPermissionsMiddleware({ backend: allowAll() });
      const req: ModelRequest = { messages: [] };
      const result = await mw.wrapModelCall!(makeTurnContext(), req, noopModelHandler);
      expect(result.content).toBe("ok");
    });

    test("keeps allowed tools", async () => {
      const mw = createPermissionsMiddleware({ backend: allowAll() });
      const handler = mock(noopModelHandler);
      await mw.wrapModelCall!(makeTurnContext(), makeModelRequest(["a", "b"]), handler);
      const passedReq = handler.mock.calls[0]?.[0] as ModelRequest;
      expect(passedReq.tools).toHaveLength(2);
    });

    test("strips denied tools", async () => {
      const backend = staticBackend({
        a: { effect: "allow" },
        b: { effect: "deny", reason: "nope" },
        c: { effect: "allow" },
      });
      const mw = createPermissionsMiddleware({ backend });
      const handler = mock(noopModelHandler);
      await mw.wrapModelCall!(makeTurnContext(), makeModelRequest(["a", "b", "c"]), handler);
      const passedReq = handler.mock.calls[0]?.[0] as ModelRequest;
      expect(passedReq.tools).toHaveLength(2);
      expect(passedReq.tools?.map((t) => t.name)).toEqual(["a", "c"]);
    });

    test("keeps ask tools (gates later at wrapToolCall)", async () => {
      const backend = staticBackend({
        a: { effect: "allow" },
        b: { effect: "ask", reason: "needs approval" },
      });
      const mw = createPermissionsMiddleware({ backend });
      const handler = mock(noopModelHandler);
      await mw.wrapModelCall!(makeTurnContext(), makeModelRequest(["a", "b"]), handler);
      const passedReq = handler.mock.calls[0]?.[0] as ModelRequest;
      expect(passedReq.tools).toHaveLength(2);
    });
  });

  describe("wrapToolCall — allow", () => {
    test("calls next for allowed tools", async () => {
      const mw = createPermissionsMiddleware({ backend: allowAll() });
      const handler = mock(noopToolHandler);
      const result = await mw.wrapToolCall!(
        makeTurnContext(),
        makeToolRequest("multiply"),
        handler,
      );
      expect(result.output).toBe("done");
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("wrapToolCall — deny", () => {
    test("throws PERMISSION error for denied tools", async () => {
      const mw = createPermissionsMiddleware({
        backend: denyAll("tool is blocked"),
      });
      const handler = mock(noopToolHandler);
      await expect(
        mw.wrapToolCall!(makeTurnContext(), makeToolRequest("bash"), handler),
      ).rejects.toThrow("tool is blocked");
      expect(handler).not.toHaveBeenCalled();
    });

    test("thrown error has PERMISSION code", async () => {
      const mw = createPermissionsMiddleware({ backend: denyAll("nope") });
      try {
        await mw.wrapToolCall!(makeTurnContext(), makeToolRequest("bash"), noopToolHandler);
        throw new Error("should not reach");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).code).toBe("PERMISSION");
        expect((e as KoiRuntimeError).retryable).toBe(false);
      }
    });
  });

  describe("wrapToolCall — ask flow", () => {
    test("calls next when approval handler returns allow", async () => {
      const mw = createPermissionsMiddleware({ backend: askAll() });
      const approvalHandler = async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({
        kind: "allow",
      });
      const ctx = makeTurnContext({ requestApproval: approvalHandler });
      const handler = mock(noopToolHandler);

      await mw.wrapToolCall!(ctx, makeToolRequest("deploy"), handler);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test("throws when approval handler returns deny", async () => {
      const mw = createPermissionsMiddleware({ backend: askAll() });
      const approvalHandler = async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({
        kind: "deny",
        reason: "user rejected",
      });
      const ctx = makeTurnContext({ requestApproval: approvalHandler });

      await expect(
        mw.wrapToolCall!(ctx, makeToolRequest("deploy"), noopToolHandler),
      ).rejects.toThrow("user rejected");
    });

    test("uses modified input when approval handler returns modify", async () => {
      const mw = createPermissionsMiddleware({ backend: askAll() });
      const approvalHandler = async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({
        kind: "modify",
        updatedInput: { safe: true },
      });
      const ctx = makeTurnContext({ requestApproval: approvalHandler });
      const handler = mock(noopToolHandler);

      await mw.wrapToolCall!(ctx, makeToolRequest("deploy", { dangerous: true }), handler);
      const passedReq = handler.mock.calls[0]?.[0] as ToolRequest;
      expect(passedReq.input).toEqual({ safe: true });
    });

    test("throws when no approval handler configured", async () => {
      const mw = createPermissionsMiddleware({ backend: askAll() });
      const ctx = makeTurnContext();

      await expect(
        mw.wrapToolCall!(ctx, makeToolRequest("deploy"), noopToolHandler),
      ).rejects.toThrow("no approval handler");
    });

    test("times out and throws TIMEOUT", async () => {
      const now = 1000;
      const mw = createPermissionsMiddleware({
        backend: askAll(),
        approvalTimeoutMs: 100,
        clock: () => now,
      });
      const approvalHandler = async (_req: ApprovalRequest): Promise<ApprovalDecision> =>
        new Promise(() => {}); // never resolves
      const ctx = makeTurnContext({ requestApproval: approvalHandler });

      await expect(
        mw.wrapToolCall!(ctx, makeToolRequest("deploy"), noopToolHandler),
      ).rejects.toThrow("timed out");
    });
  });

  describe("decision caching", () => {
    test("caches allow decisions", async () => {
      const checkFn = mock((_q: PermissionQuery) => ({ effect: "allow" as const }));
      const backend: PermissionBackend = { check: checkFn };
      const mw = createPermissionsMiddleware({ backend, cache: true });
      const ctx = makeTurnContext();
      const req = makeToolRequest("multiply");

      await mw.wrapToolCall!(ctx, req, noopToolHandler);
      await mw.wrapToolCall!(ctx, req, noopToolHandler);

      expect(checkFn).toHaveBeenCalledTimes(1);
    });

    test("does not cache ask decisions", async () => {
      const checkFn = mock(
        (_q: PermissionQuery): PermissionDecision => ({ effect: "ask", reason: "needs approval" }),
      );
      const backend: PermissionBackend = { check: checkFn };
      const mw = createPermissionsMiddleware({ backend, cache: true });
      const approvalHandler = async (): Promise<ApprovalDecision> => ({ kind: "allow" });
      const ctx = makeTurnContext({ requestApproval: approvalHandler });

      await mw.wrapToolCall!(ctx, makeToolRequest("deploy"), noopToolHandler);
      await mw.wrapToolCall!(ctx, makeToolRequest("deploy"), noopToolHandler);

      expect(checkFn).toHaveBeenCalledTimes(2);
    });

    test("expires cached decisions after TTL", async () => {
      let now = 1000;
      const checkFn = mock((_q: PermissionQuery) => ({ effect: "allow" as const }));
      const backend: PermissionBackend = { check: checkFn };
      const mw = createPermissionsMiddleware({
        backend,
        cache: { allowTtlMs: 5000 },
        clock: () => now,
      });
      const ctx = makeTurnContext();
      const req = makeToolRequest("multiply");

      await mw.wrapToolCall!(ctx, req, noopToolHandler);
      expect(checkFn).toHaveBeenCalledTimes(1);

      // Still cached
      now += 4000;
      await mw.wrapToolCall!(ctx, req, noopToolHandler);
      expect(checkFn).toHaveBeenCalledTimes(1);

      // Expired
      now += 2000;
      await mw.wrapToolCall!(ctx, req, noopToolHandler);
      expect(checkFn).toHaveBeenCalledTimes(2);
    });
  });

  describe("approval caching", () => {
    test("caches approval to skip re-prompting", async () => {
      const approvalFn = mock(
        async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({ kind: "allow" }),
      );
      const mw = createPermissionsMiddleware({
        backend: askAll(),
        approvalCache: true,
      });
      const ctx = makeTurnContext({ requestApproval: approvalFn });
      const req = makeToolRequest("deploy", { target: "staging" });

      await mw.wrapToolCall!(ctx, req, noopToolHandler);
      await mw.wrapToolCall!(ctx, req, noopToolHandler);

      expect(approvalFn).toHaveBeenCalledTimes(1);
    });

    test("different inputs produce different cache keys", async () => {
      const approvalFn = mock(
        async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({ kind: "allow" }),
      );
      const mw = createPermissionsMiddleware({
        backend: askAll(),
        approvalCache: true,
      });
      const ctx = makeTurnContext({ requestApproval: approvalFn });

      await mw.wrapToolCall!(
        ctx,
        makeToolRequest("deploy", { target: "staging" }),
        noopToolHandler,
      );
      await mw.wrapToolCall!(ctx, makeToolRequest("deploy", { target: "prod" }), noopToolHandler);

      expect(approvalFn).toHaveBeenCalledTimes(2);
    });
  });

  describe("audit logging", () => {
    test("logs decisions to audit sink", async () => {
      const entries: AuditEntry[] = [];
      const auditSink = {
        log: async (entry: AuditEntry) => {
          entries.push(entry);
        },
      };
      const mw = createPermissionsMiddleware({
        backend: allowAll(),
        auditSink,
      });

      await mw.wrapToolCall!(makeTurnContext(), makeToolRequest("multiply"), noopToolHandler);

      expect(entries).toHaveLength(1);
      expect(entries[0]?.kind).toBe("tool_call");
      expect((entries[0]?.metadata as Record<string, unknown>).permissionCheck).toBe(true);
      expect((entries[0]?.metadata as Record<string, unknown>).effect).toBe("allow");
    });

    test("includes reason for deny decisions", async () => {
      const entries: AuditEntry[] = [];
      const auditSink = {
        log: async (entry: AuditEntry) => {
          entries.push(entry);
        },
      };
      const mw = createPermissionsMiddleware({
        backend: denyAll("blocked"),
        auditSink,
      });

      try {
        await mw.wrapToolCall!(makeTurnContext(), makeToolRequest("bash"), noopToolHandler);
      } catch {
        // expected
      }

      expect(entries).toHaveLength(1);
      expect((entries[0]?.metadata as Record<string, unknown>).reason).toBe("blocked");
    });

    test("swallows audit sink errors", async () => {
      const auditSink = {
        log: async () => {
          throw new Error("sink broken");
        },
      };
      const mw = createPermissionsMiddleware({
        backend: allowAll(),
        auditSink,
      });

      // Should not throw despite broken sink
      await mw.wrapToolCall!(makeTurnContext(), makeToolRequest("multiply"), noopToolHandler);
    });
  });

  describe("circuit breaker", () => {
    test("fails closed when circuit is open", async () => {
      const now = 1000;
      const failingBackend: PermissionBackend = {
        check: () => {
          throw new Error("backend down");
        },
      };
      const mw = createPermissionsMiddleware({
        backend: failingBackend,
        circuitBreaker: {
          failureThreshold: 2,
          cooldownMs: 30_000,
          failureWindowMs: 60_000,
          failureStatusCodes: [],
        },
        clock: () => now,
      });
      const ctx = makeTurnContext();

      // First 2 failures trip the circuit
      for (let i = 0; i < 2; i++) {
        try {
          await mw.wrapToolCall!(ctx, makeToolRequest("test"), noopToolHandler);
        } catch {
          // expected
        }
      }

      // Circuit open — should deny without calling backend
      try {
        await mw.wrapToolCall!(ctx, makeToolRequest("test"), noopToolHandler);
        throw new Error("should not reach");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).message).toContain("circuit open");
      }
    });
  });

  describe("backend error handling", () => {
    test("fails closed when backend throws", async () => {
      const backend: PermissionBackend = {
        check: () => {
          throw new Error("connection refused");
        },
      };
      const mw = createPermissionsMiddleware({ backend });

      await expect(
        mw.wrapToolCall!(makeTurnContext(), makeToolRequest("test"), noopToolHandler),
      ).rejects.toThrow("failing closed");
    });
  });

  describe("middleware identity", () => {
    test("has correct name and phase", () => {
      const mw = createPermissionsMiddleware({ backend: allowAll() });
      expect(mw.name).toBe("permissions");
      expect(mw.phase).toBe("intercept");
      expect(mw.priority).toBe(100);
    });

    test("describeCapabilities returns label", () => {
      const mw = createPermissionsMiddleware({
        backend: allowAll(),
        description: "Custom description",
      });
      const cap = mw.describeCapabilities(makeTurnContext());
      expect(cap?.label).toBe("permissions");
      expect(cap?.description).toBe("Custom description");
    });
  });

  describe("session lifecycle", () => {
    test("onSessionEnd disposes backend and clears caches", async () => {
      const disposeFn = mock(async () => {});
      const backend: PermissionBackend = {
        check: () => ({ effect: "allow" }),
        dispose: disposeFn,
      };
      const mw = createPermissionsMiddleware({ backend, cache: true });
      const sessionCtx = {
        agentId: "agent:test",
        sessionId: "s-1" as never,
        runId: "r-1" as never,
        metadata: {},
      };

      await mw.onSessionEnd!(sessionCtx);
      expect(disposeFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("batch checking in wrapModelCall", () => {
    test("uses checkBatch when available", async () => {
      const checkBatchFn = mock(
        (queries: readonly PermissionQuery[]): readonly PermissionDecision[] =>
          queries.map(() => ({ effect: "allow" as const })),
      );
      const backend: PermissionBackend = {
        check: () => ({ effect: "allow" }),
        checkBatch: checkBatchFn,
      };
      const mw = createPermissionsMiddleware({ backend });
      const handler = mock(noopModelHandler);

      await mw.wrapModelCall!(makeTurnContext(), makeModelRequest(["a", "b", "c"]), handler);
      expect(checkBatchFn).toHaveBeenCalledTimes(1);
      expect(checkBatchFn.mock.calls[0]?.[0]).toHaveLength(3);
    });
  });
});
