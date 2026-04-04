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
import type { RichTrajectoryStep } from "@koi/core/rich-trajectory";
import { KoiRuntimeError } from "@koi/errors";
import { createPermissionsMiddleware } from "../middleware.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTurnContext(overrides?: {
  readonly userId?: string;
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly turnIndex?: number;
  readonly turnId?: string;
  readonly metadata?: JsonObject;
  readonly requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
}): TurnContext {
  const base = {
    session: {
      agentId: overrides?.agentId ?? "agent:test",
      sessionId: (overrides?.sessionId ?? "s-1") as never,
      runId: "r-1" as never,
      userId: overrides?.userId ?? "user-1",
      metadata: {},
    },
    turnIndex: overrides?.turnIndex ?? 0,
    turnId: (overrides?.turnId ?? "t-1") as never,
    messages: [] as const,
    metadata: overrides?.metadata ?? {},
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
      const result = await mw.wrapModelCall?.(makeTurnContext(), req, noopModelHandler);
      expect(result?.content).toBe("ok");
    });

    test("keeps allowed tools", async () => {
      const mw = createPermissionsMiddleware({ backend: allowAll() });
      const handler = mock(noopModelHandler);
      await mw.wrapModelCall?.(makeTurnContext(), makeModelRequest(["a", "b"]), handler);
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
      await mw.wrapModelCall?.(makeTurnContext(), makeModelRequest(["a", "b", "c"]), handler);
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
      await mw.wrapModelCall?.(makeTurnContext(), makeModelRequest(["a", "b"]), handler);
      const passedReq = handler.mock.calls[0]?.[0] as ModelRequest;
      expect(passedReq.tools).toHaveLength(2);
    });
  });

  describe("wrapToolCall — allow", () => {
    test("calls next for allowed tools", async () => {
      const mw = createPermissionsMiddleware({ backend: allowAll() });
      const handler = mock(noopToolHandler);
      const result = await mw.wrapToolCall?.(
        makeTurnContext(),
        makeToolRequest("multiply"),
        handler,
      );
      expect(result?.output).toBe("done");
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
        mw.wrapToolCall?.(makeTurnContext(), makeToolRequest("bash"), handler),
      ).rejects.toThrow("tool is blocked");
      expect(handler).not.toHaveBeenCalled();
    });

    test("thrown error has PERMISSION code", async () => {
      const mw = createPermissionsMiddleware({ backend: denyAll("nope") });
      try {
        await mw.wrapToolCall?.(makeTurnContext(), makeToolRequest("bash"), noopToolHandler);
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

      await mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), handler);
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
        mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), noopToolHandler),
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

      await mw.wrapToolCall?.(ctx, makeToolRequest("deploy", { dangerous: true }), handler);
      const passedReq = handler.mock.calls[0]?.[0] as ToolRequest;
      expect(passedReq.input).toEqual({ safe: true });
    });

    test("throws when no approval handler configured", async () => {
      const mw = createPermissionsMiddleware({ backend: askAll() });
      const ctx = makeTurnContext();

      await expect(
        mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), noopToolHandler),
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
        mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), noopToolHandler),
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

      await mw.wrapToolCall?.(ctx, req, noopToolHandler);
      await mw.wrapToolCall?.(ctx, req, noopToolHandler);

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

      await mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), noopToolHandler);
      await mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), noopToolHandler);

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

      await mw.wrapToolCall?.(ctx, req, noopToolHandler);
      expect(checkFn).toHaveBeenCalledTimes(1);

      // Still cached
      now += 4000;
      await mw.wrapToolCall?.(ctx, req, noopToolHandler);
      expect(checkFn).toHaveBeenCalledTimes(1);

      // Expired
      now += 2000;
      await mw.wrapToolCall?.(ctx, req, noopToolHandler);
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

      await mw.wrapToolCall?.(ctx, req, noopToolHandler);
      await mw.wrapToolCall?.(ctx, req, noopToolHandler);

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

      await mw.wrapToolCall?.(
        ctx,
        makeToolRequest("deploy", { target: "staging" }),
        noopToolHandler,
      );
      await mw.wrapToolCall?.(ctx, makeToolRequest("deploy", { target: "prod" }), noopToolHandler);

      expect(approvalFn).toHaveBeenCalledTimes(2);
    });

    test("does not cache modify approvals — re-prompts every time", async () => {
      const approvalFn = mock(
        async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({
          kind: "modify",
          updatedInput: { safe: true },
        }),
      );
      const mw = createPermissionsMiddleware({
        backend: askAll(),
        approvalCache: true,
      });
      const ctx = makeTurnContext({ requestApproval: approvalFn });
      const req = makeToolRequest("deploy", { dangerous: true });

      await mw.wrapToolCall?.(ctx, req, noopToolHandler);
      await mw.wrapToolCall?.(ctx, req, noopToolHandler);

      // Must prompt both times since modify results are never cached
      expect(approvalFn).toHaveBeenCalledTimes(2);
    });

    test("different turn metadata produces different cache keys", async () => {
      const approvalFn = mock(
        async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({ kind: "allow" }),
      );
      const mw = createPermissionsMiddleware({
        backend: askAll(),
        approvalCache: true,
      });
      const req = makeToolRequest("deploy", { target: "staging" });

      // Approval in context A
      const ctxA = makeTurnContext({
        requestApproval: approvalFn,
        metadata: { tenant: "acme" },
      });
      await mw.wrapToolCall?.(ctxA, req, noopToolHandler);

      // Same tool+input but different context — must re-prompt
      const ctxB = makeTurnContext({
        requestApproval: approvalFn,
        metadata: { tenant: "globex" },
      });
      await mw.wrapToolCall?.(ctxB, req, noopToolHandler);

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

      await mw.wrapToolCall?.(makeTurnContext(), makeToolRequest("multiply"), noopToolHandler);

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
        await mw.wrapToolCall?.(makeTurnContext(), makeToolRequest("bash"), noopToolHandler);
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
      await mw.wrapToolCall?.(makeTurnContext(), makeToolRequest("multiply"), noopToolHandler);
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
          await mw.wrapToolCall?.(ctx, makeToolRequest("test"), noopToolHandler);
        } catch {
          // expected
        }
      }

      // Circuit open — should deny without calling backend
      try {
        await mw.wrapToolCall?.(ctx, makeToolRequest("test"), noopToolHandler);
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
        mw.wrapToolCall?.(makeTurnContext(), makeToolRequest("test"), noopToolHandler),
      ).rejects.toThrow("failing closed");
    });
  });

  describe("malformed backend responses (fail-closed)", () => {
    test("empty object from backend denies tool", async () => {
      const backend: PermissionBackend = {
        check: () => ({}) as PermissionDecision,
      };
      const mw = createPermissionsMiddleware({ backend });

      await expect(
        mw.wrapToolCall?.(makeTurnContext(), makeToolRequest("test"), noopToolHandler),
      ).rejects.toThrow("Malformed");
    });

    test("unknown effect from backend denies tool", async () => {
      const backend: PermissionBackend = {
        check: () => ({ effect: "bogus" }) as unknown as PermissionDecision,
      };
      const mw = createPermissionsMiddleware({ backend });

      await expect(
        mw.wrapToolCall?.(makeTurnContext(), makeToolRequest("test"), noopToolHandler),
      ).rejects.toThrow("Malformed");
    });

    test("deny without reason from backend denies with validation message", async () => {
      const backend: PermissionBackend = {
        check: () => ({ effect: "deny" }) as unknown as PermissionDecision,
      };
      const mw = createPermissionsMiddleware({ backend });

      await expect(
        mw.wrapToolCall?.(makeTurnContext(), makeToolRequest("test"), noopToolHandler),
      ).rejects.toThrow("Malformed");
    });

    test("short checkBatch response denies all uncached", async () => {
      const backend: PermissionBackend = {
        check: () => ({ effect: "allow" }),
        checkBatch: () => [{ effect: "allow" }] as readonly PermissionDecision[], // short
      };
      const mw = createPermissionsMiddleware({ backend });
      const handler = mock(noopModelHandler);

      // Request 3 tools, batch returns only 1 — should deny the missing ones
      await mw.wrapModelCall?.(makeTurnContext(), makeModelRequest(["a", "b", "c"]), handler);
      const passedReq = handler.mock.calls[0]?.[0] as ModelRequest;
      // All 3 should be denied (batch length mismatch = fail-closed for entire batch)
      expect(passedReq.tools?.length).toBe(0);
    });

    test("one malformed batch element poisons the entire batch", async () => {
      const backend: PermissionBackend = {
        check: () => ({ effect: "allow" }),
        checkBatch: () =>
          [
            { effect: "allow" },
            { effect: "bogus" }, // malformed
            { effect: "allow" },
          ] as readonly PermissionDecision[],
      };
      const mw = createPermissionsMiddleware({ backend });
      const handler = mock(noopModelHandler);

      await mw.wrapModelCall?.(makeTurnContext(), makeModelRequest(["a", "b", "c"]), handler);
      const passedReq = handler.mock.calls[0]?.[0] as ModelRequest;
      // All 3 denied — one bad element poisons entire batch
      expect(passedReq.tools?.length).toBe(0);
    });
  });

  describe("malformed approval responses (fail-closed)", () => {
    test("empty object from approval handler denies tool", async () => {
      const mw = createPermissionsMiddleware({ backend: askAll() });
      const approvalHandler = async () => ({}) as ApprovalDecision;
      const ctx = makeTurnContext({ requestApproval: approvalHandler });

      await expect(
        mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), noopToolHandler),
      ).rejects.toThrow("Malformed approval");
    });

    test("unknown kind from approval handler denies tool", async () => {
      const mw = createPermissionsMiddleware({ backend: askAll() });
      const approvalHandler = async () => ({ kind: "bogus" }) as unknown as ApprovalDecision;
      const ctx = makeTurnContext({ requestApproval: approvalHandler });

      await expect(
        mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), noopToolHandler),
      ).rejects.toThrow("Malformed approval");
    });

    test("modify without updatedInput from approval handler denies tool", async () => {
      const mw = createPermissionsMiddleware({ backend: askAll() });
      const approvalHandler = async () => ({ kind: "modify" }) as unknown as ApprovalDecision;
      const ctx = makeTurnContext({ requestApproval: approvalHandler });

      await expect(
        mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), noopToolHandler),
      ).rejects.toThrow("Malformed approval");
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
    test("onSessionEnd clears session state without disposing shared backend", async () => {
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

      await mw.onSessionEnd?.(sessionCtx);
      // Backend is shared — must NOT be disposed when a single session ends
      expect(disposeFn).not.toHaveBeenCalled();
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

      await mw.wrapModelCall?.(makeTurnContext(), makeModelRequest(["a", "b", "c"]), handler);
      expect(checkBatchFn).toHaveBeenCalledTimes(1);
      expect(checkBatchFn.mock.calls[0]?.[0]).toHaveLength(3);
    });
  });

  describe("principal scoping (tenant isolation)", () => {
    test("different users produce different cache keys", async () => {
      const checkFn = mock((_q: PermissionQuery) => ({ effect: "allow" as const }));
      const backend: PermissionBackend = { check: checkFn };
      const mw = createPermissionsMiddleware({ backend, cache: true });

      await mw.wrapToolCall?.(
        makeTurnContext({ userId: "alice" }),
        makeToolRequest("tool"),
        noopToolHandler,
      );
      await mw.wrapToolCall?.(
        makeTurnContext({ userId: "bob" }),
        makeToolRequest("tool"),
        noopToolHandler,
      );

      // Both should call backend because different users = different cache keys
      expect(checkFn).toHaveBeenCalledTimes(2);
    });

    test("different sessions produce different cache keys", async () => {
      const checkFn = mock((_q: PermissionQuery) => ({ effect: "allow" as const }));
      const backend: PermissionBackend = { check: checkFn };
      const mw = createPermissionsMiddleware({ backend, cache: true });

      await mw.wrapToolCall?.(
        makeTurnContext({ sessionId: "s-1" }),
        makeToolRequest("tool"),
        noopToolHandler,
      );
      await mw.wrapToolCall?.(
        makeTurnContext({ sessionId: "s-2" }),
        makeToolRequest("tool"),
        noopToolHandler,
      );

      expect(checkFn).toHaveBeenCalledTimes(2);
    });

    test("principal includes userId and sessionId", async () => {
      const checkFn = mock((_q: PermissionQuery) => ({ effect: "allow" as const }));
      const backend: PermissionBackend = { check: checkFn };
      const mw = createPermissionsMiddleware({ backend });

      await mw.wrapToolCall?.(
        makeTurnContext({ userId: "alice", sessionId: "s-42" }),
        makeToolRequest("tool"),
        noopToolHandler,
      );

      const query = checkFn.mock.calls[0]?.[0] as PermissionQuery;
      expect(query.principal).toContain("alice");
      expect(query.principal).toContain("s-42");
    });
  });

  describe("per-session denial tracking", () => {
    test("onSessionEnd only clears ending session tracker", async () => {
      const mw = createPermissionsMiddleware({ backend: denyAll("denied") });

      // Session 1 gets a denial
      try {
        await mw.wrapToolCall?.(
          makeTurnContext({ sessionId: "s-1" }),
          makeToolRequest("bash"),
          noopToolHandler,
        );
      } catch {
        // expected
      }

      // Session 2 gets a denial
      try {
        await mw.wrapToolCall?.(
          makeTurnContext({ sessionId: "s-2" }),
          makeToolRequest("rm"),
          noopToolHandler,
        );
      } catch {
        // expected
      }

      // End session 1 — should not clear session 2
      await mw.onSessionEnd?.({
        agentId: "agent:test",
        sessionId: "s-1" as never,
        runId: "r-1" as never,
        metadata: {},
      });

      // Session 2 should still work independently (no crash, no shared state)
      try {
        await mw.wrapToolCall?.(
          makeTurnContext({ sessionId: "s-2" }),
          makeToolRequest("bash"),
          noopToolHandler,
        );
      } catch {
        // expected — tool is denied
      }
    });
  });

  describe("denial escalation", () => {
    test("auto-denies after threshold denials without hitting backend", async () => {
      const checkFn = mock((_q: PermissionQuery) => ({
        effect: "deny" as const,
        reason: "denied",
      }));
      const backend: PermissionBackend = { check: checkFn };
      const mw = createPermissionsMiddleware({
        backend,
        denialEscalation: { threshold: 2 },
      });
      const ctx = makeTurnContext();

      // Denial 1 — backend called
      try {
        await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
      } catch {
        /* expected */
      }

      // Denial 2 — backend called
      try {
        await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
      } catch {
        /* expected */
      }

      expect(checkFn).toHaveBeenCalledTimes(2);

      // Denial 3 — escalated, backend NOT called
      try {
        await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).message).toContain("Auto-denied");
      }

      expect(checkFn).toHaveBeenCalledTimes(2); // still 2, not 3
    });

    test("below threshold still queries backend", async () => {
      const checkFn = mock((_q: PermissionQuery) => ({
        effect: "deny" as const,
        reason: "denied",
      }));
      const backend: PermissionBackend = { check: checkFn };
      const mw = createPermissionsMiddleware({
        backend,
        denialEscalation: { threshold: 5 },
      });
      const ctx = makeTurnContext();

      for (let i = 0; i < 4; i++) {
        try {
          await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
        } catch {
          /* expected */
        }
      }

      // All 4 calls below threshold — backend called each time
      expect(checkFn).toHaveBeenCalledTimes(4);
    });

    test("disabled by default (no config)", async () => {
      const checkFn = mock((_q: PermissionQuery) => ({
        effect: "deny" as const,
        reason: "denied",
      }));
      const backend: PermissionBackend = { check: checkFn };
      const mw = createPermissionsMiddleware({ backend });
      const ctx = makeTurnContext();

      for (let i = 0; i < 5; i++) {
        try {
          await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
        } catch {
          /* expected */
        }
      }

      // No escalation — backend called every time
      expect(checkFn).toHaveBeenCalledTimes(5);
    });

    test("denialEscalation: true uses default threshold (3)", async () => {
      const checkFn = mock((_q: PermissionQuery) => ({
        effect: "deny" as const,
        reason: "denied",
      }));
      const backend: PermissionBackend = { check: checkFn };
      const mw = createPermissionsMiddleware({
        backend,
        denialEscalation: true,
      });
      const ctx = makeTurnContext();

      // 3 denials hit backend
      for (let i = 0; i < 3; i++) {
        try {
          await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
        } catch {
          /* expected */
        }
      }
      expect(checkFn).toHaveBeenCalledTimes(3);

      // 4th denial — escalated
      try {
        await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
      } catch {
        /* expected */
      }
      expect(checkFn).toHaveBeenCalledTimes(3); // still 3
    });

    test("escalation is per-tool — other tools still query backend", async () => {
      const checkFn = mock((_q: PermissionQuery) => ({
        effect: "deny" as const,
        reason: "denied",
      }));
      const backend: PermissionBackend = { check: checkFn };
      const mw = createPermissionsMiddleware({
        backend,
        denialEscalation: { threshold: 2 },
      });
      const ctx = makeTurnContext();

      // Deny "bash" twice → escalated
      for (let i = 0; i < 2; i++) {
        try {
          await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
        } catch {
          /* expected */
        }
      }

      // "rm" is a different tool — should still query backend
      try {
        await mw.wrapToolCall?.(ctx, makeToolRequest("rm"), noopToolHandler);
      } catch {
        /* expected */
      }

      // 2 calls for bash + 1 for rm = 3
      expect(checkFn).toHaveBeenCalledTimes(3);
    });

    test("session isolation — escalation in session A does not affect session B", async () => {
      const checkFn = mock((_q: PermissionQuery) => ({
        effect: "deny" as const,
        reason: "denied",
      }));
      const backend: PermissionBackend = { check: checkFn };
      const mw = createPermissionsMiddleware({
        backend,
        denialEscalation: { threshold: 2 },
      });

      // Escalate in session A
      for (let i = 0; i < 3; i++) {
        try {
          await mw.wrapToolCall?.(
            makeTurnContext({ sessionId: "s-A" }),
            makeToolRequest("bash"),
            noopToolHandler,
          );
        } catch {
          /* expected */
        }
      }
      // 2 backend calls (3rd was escalated)
      expect(checkFn).toHaveBeenCalledTimes(2);

      // Session B — should still query backend
      try {
        await mw.wrapToolCall?.(
          makeTurnContext({ sessionId: "s-B" }),
          makeToolRequest("bash"),
          noopToolHandler,
        );
      } catch {
        /* expected */
      }
      expect(checkFn).toHaveBeenCalledTimes(3);
    });

    test("wrapModelCall filters escalated tools without backend query", async () => {
      const checkFn = mock((_q: PermissionQuery) => ({
        effect: "deny" as const,
        reason: "denied",
      }));
      const backend: PermissionBackend = { check: checkFn };
      const mw = createPermissionsMiddleware({
        backend,
        denialEscalation: { threshold: 2 },
      });
      const ctx = makeTurnContext();

      // Deny "bash" twice via wrapToolCall to build up tracker
      for (let i = 0; i < 2; i++) {
        try {
          await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
        } catch {
          /* expected */
        }
      }
      expect(checkFn).toHaveBeenCalledTimes(2);

      // Now wrapModelCall with bash + multiply
      const _result = await mw.wrapModelCall?.(
        ctx,
        makeModelRequest(["bash", "multiply"]),
        noopModelHandler,
      );

      // bash should be escalated (no backend call), multiply should query backend
      // Total: 2 (prior) + 1 (multiply) = 3
      expect(checkFn).toHaveBeenCalledTimes(3);
    });

    test("onSessionEnd clears escalation state", async () => {
      const checkFn = mock((_q: PermissionQuery) => ({
        effect: "deny" as const,
        reason: "denied",
      }));
      const backend: PermissionBackend = { check: checkFn };
      const mw = createPermissionsMiddleware({
        backend,
        denialEscalation: { threshold: 2 },
      });

      // Escalate in session
      for (let i = 0; i < 3; i++) {
        try {
          await mw.wrapToolCall?.(
            makeTurnContext({ sessionId: "s-1" }),
            makeToolRequest("bash"),
            noopToolHandler,
          );
        } catch {
          /* expected */
        }
      }
      // 2 backend calls (3rd escalated)
      expect(checkFn).toHaveBeenCalledTimes(2);

      // End session — clears tracker
      await mw.onSessionEnd?.({
        agentId: "agent:test",
        sessionId: "s-1" as never,
        runId: "r-1" as never,
        metadata: {},
      });

      // Same session ID after re-start — should query backend again
      try {
        await mw.wrapToolCall?.(
          makeTurnContext({ sessionId: "s-1" }),
          makeToolRequest("bash"),
          noopToolHandler,
        );
      } catch {
        /* expected */
      }
      expect(checkFn).toHaveBeenCalledTimes(3);
    });

    test("backend errors do not count toward escalation threshold", async () => {
      let callCount = 0;
      const backend: PermissionBackend = {
        check: () => {
          callCount++;
          throw new Error("backend down");
        },
      };
      const mw = createPermissionsMiddleware({
        backend,
        denialEscalation: { threshold: 2 },
      });
      const ctx = makeTurnContext();

      // 3 backend errors — all fail-closed but should NOT trigger escalation
      for (let i = 0; i < 3; i++) {
        try {
          await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
        } catch {
          /* expected */
        }
      }

      // All 3 calls hit the backend (none escalated)
      expect(callCount).toBe(3);

      // 4th call still hits backend (not escalated despite 3 denials)
      try {
        await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
      } catch {
        /* expected */
      }
      expect(callCount).toBe(4);
    });

    test("cached deny replays do not count toward escalation threshold", async () => {
      const checkFn = mock((_q: PermissionQuery) => ({
        effect: "deny" as const,
        reason: "denied",
      }));
      const backend: PermissionBackend = { check: checkFn };
      const mw = createPermissionsMiddleware({
        backend,
        cache: { maxEntries: 100, allowTtlMs: 30_000, denyTtlMs: 30_000 },
        denialEscalation: { threshold: 3 },
      });
      const ctx = makeTurnContext();

      // 1 backend deny → cached
      try {
        await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
      } catch {
        /* expected */
      }
      expect(checkFn).toHaveBeenCalledTimes(1);

      // 4 more calls — all cache hits (denyTtl: 30s)
      for (let i = 0; i < 4; i++) {
        try {
          await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
        } catch {
          /* expected */
        }
      }

      // Only 1 backend call — rest were cache hits
      expect(checkFn).toHaveBeenCalledTimes(1);

      // 6th call should NOT be escalated (only 1 policy denial, 4 cached replays)
      // If cached replays counted, we'd have 5 "policy" denials → escalation at 3
      // Instead, backend should be called again (cache hit, not escalated)
      try {
        await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
      } catch {
        /* expected */
      }
      // Still 1 — all served from cache, not escalated
      expect(checkFn).toHaveBeenCalledTimes(1);
    });

    test("approval rejections do not count toward escalation threshold", async () => {
      let backendCalls = 0;
      const backend: PermissionBackend = {
        check: () => {
          backendCalls++;
          return { effect: "ask" as const, reason: "needs approval" };
        },
      };
      const approvalFn = mock(
        async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({
          kind: "deny",
          reason: "user said no",
        }),
      );
      const mw = createPermissionsMiddleware({
        backend,
        denialEscalation: { threshold: 2 },
      });

      // 3 approval rejections
      for (let i = 0; i < 3; i++) {
        try {
          await mw.wrapToolCall?.(
            makeTurnContext({ requestApproval: approvalFn }),
            makeToolRequest("deploy"),
            noopToolHandler,
          );
        } catch {
          /* expected */
        }
      }

      // All 3 calls hit backend (approval denials don't trigger escalation)
      expect(backendCalls).toBe(3);

      // 4th call — user should still be prompted (not auto-denied)
      const approveFn = mock(
        async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({ kind: "allow" }),
      );
      await mw.wrapToolCall?.(
        makeTurnContext({ requestApproval: approveFn }),
        makeToolRequest("deploy"),
        noopToolHandler,
      );

      // Backend called, approval prompted, tool executed
      expect(backendCalls).toBe(4);
      expect(approveFn).toHaveBeenCalledTimes(1);
    });

    test("escalation expires after windowMs", async () => {
      let now = 1000;
      const checkFn = mock((_q: PermissionQuery) => ({
        effect: "deny" as const,
        reason: "denied",
      }));
      const backend: PermissionBackend = { check: checkFn };
      const mw = createPermissionsMiddleware({
        backend,
        denialEscalation: { threshold: 2, windowMs: 5000 },
        clock: () => now,
      });
      const ctx = makeTurnContext();

      // 2 denials at t=1000 → escalated
      for (let i = 0; i < 2; i++) {
        try {
          await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
        } catch {
          /* expected */
        }
      }
      expect(checkFn).toHaveBeenCalledTimes(2);

      // 3rd call at t=1000 → auto-denied (escalated)
      try {
        await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
      } catch {
        /* expected */
      }
      expect(checkFn).toHaveBeenCalledTimes(2); // still 2

      // Advance clock past window (t=7000, window=5000, cutoff=2000 > 1000)
      now = 7000;

      // 4th call — denials have aged out, backend queried again
      try {
        await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
      } catch {
        /* expected */
      }
      expect(checkFn).toHaveBeenCalledTimes(3); // backend called again
    });

    test("retries during escalation do not extend the window", async () => {
      let now = 1000;
      const checkFn = mock((_q: PermissionQuery) => ({
        effect: "deny" as const,
        reason: "denied",
      }));
      const backend: PermissionBackend = { check: checkFn };
      const mw = createPermissionsMiddleware({
        backend,
        denialEscalation: { threshold: 2, windowMs: 5000 },
        clock: () => now,
      });
      const ctx = makeTurnContext();

      // 2 policy denials at t=1000 → escalated
      for (let i = 0; i < 2; i++) {
        try {
          await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
        } catch {
          /* expected */
        }
      }
      expect(checkFn).toHaveBeenCalledTimes(2);

      // Retry at t=3000 — still within window, escalated (no backend call)
      now = 3000;
      try {
        await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
      } catch {
        /* expected */
      }
      expect(checkFn).toHaveBeenCalledTimes(2);

      // Retry at t=5000 — still within window of original denials
      now = 5000;
      try {
        await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
      } catch {
        /* expected */
      }
      expect(checkFn).toHaveBeenCalledTimes(2);

      // t=7000 — original denials (t=1000) have aged out despite retries at t=3000,5000
      // Escalation retries must NOT have refreshed the window
      now = 7000;
      try {
        await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
      } catch {
        /* expected */
      }
      expect(checkFn).toHaveBeenCalledTimes(3); // backend consulted again
    });

    test("wrapModelCall retries do not extend the escalation window", async () => {
      let now = 1000;
      const checkFn = mock((_q: PermissionQuery) => ({
        effect: "deny" as const,
        reason: "denied",
      }));
      const backend: PermissionBackend = { check: checkFn };
      const mw = createPermissionsMiddleware({
        backend,
        denialEscalation: { threshold: 2, windowMs: 5000 },
        clock: () => now,
      });
      const ctx = makeTurnContext();

      // 2 policy denials via wrapToolCall at t=1000 → escalated
      for (let i = 0; i < 2; i++) {
        try {
          await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
        } catch {
          /* expected */
        }
      }
      expect(checkFn).toHaveBeenCalledTimes(2);

      // wrapModelCall at t=3000 — escalated, bash filtered out (no backend call)
      now = 3000;
      await mw.wrapModelCall?.(ctx, makeModelRequest(["bash"]), noopModelHandler);
      expect(checkFn).toHaveBeenCalledTimes(2);

      // wrapModelCall at t=5500 — within window from retry but NOT from originals
      now = 5500;
      await mw.wrapModelCall?.(ctx, makeModelRequest(["bash"]), noopModelHandler);
      expect(checkFn).toHaveBeenCalledTimes(2);

      // t=7000 — original denials (t=1000) fully aged out, model retries must not have refreshed
      now = 7000;
      await mw.wrapModelCall?.(ctx, makeModelRequest(["bash"]), noopModelHandler);
      // bash should query backend again since escalation expired
      expect(checkFn).toHaveBeenCalledTimes(3);
    });

    test("different contexts escalate independently", async () => {
      const checkFn = mock((q: PermissionQuery) => {
        // Deny bash in context A, allow in context B
        const ctx = q.context as Record<string, unknown> | undefined;
        if (ctx?.zone === "restricted") {
          return { effect: "deny" as const, reason: "restricted zone" };
        }
        return { effect: "allow" as const };
      });
      const backend: PermissionBackend = { check: checkFn };
      const mw = createPermissionsMiddleware({
        backend,
        denialEscalation: { threshold: 2 },
      });

      // 2 denials in restricted zone
      for (let i = 0; i < 2; i++) {
        try {
          await mw.wrapToolCall?.(
            makeTurnContext({ metadata: { zone: "restricted" } }),
            makeToolRequest("bash"),
            noopToolHandler,
          );
        } catch {
          /* expected */
        }
      }

      // Same tool in unrestricted zone — should still query backend and be allowed
      const result = await mw.wrapToolCall?.(
        makeTurnContext({ metadata: { zone: "open" } }),
        makeToolRequest("bash"),
        noopToolHandler,
      );
      expect(result?.output).toBe("done");
    });
  });

  describe("cross-session isolation", () => {
    test("approval cache is scoped per session", async () => {
      const approvalFn = mock(
        async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({ kind: "allow" }),
      );
      const mw = createPermissionsMiddleware({
        backend: askAll(),
        approvalCache: true,
      });
      const req = makeToolRequest("deploy", { target: "staging" });

      // Approve in session A
      await mw.wrapToolCall?.(
        makeTurnContext({ sessionId: "s-A", requestApproval: approvalFn }),
        req,
        noopToolHandler,
      );

      // Same tool+input in session B — must re-prompt, not use session A cache
      await mw.wrapToolCall?.(
        makeTurnContext({ sessionId: "s-B", requestApproval: approvalFn }),
        req,
        noopToolHandler,
      );

      expect(approvalFn).toHaveBeenCalledTimes(2);
    });

    test("onSessionEnd does not dispose shared backend", async () => {
      const disposeFn = mock(async () => {});
      const checkFn = mock((_q: PermissionQuery) => ({ effect: "allow" as const }));
      const backend: PermissionBackend = {
        check: checkFn,
        dispose: disposeFn,
      };
      const mw = createPermissionsMiddleware({ backend });

      // End session 1
      await mw.onSessionEnd?.({
        agentId: "agent:test",
        sessionId: "s-1" as never,
        runId: "r-1" as never,
        metadata: {},
      });

      // Backend should NOT have been disposed
      expect(disposeFn).not.toHaveBeenCalled();

      // Session 2 should still work
      await mw.wrapToolCall?.(
        makeTurnContext({ sessionId: "s-2" }),
        makeToolRequest("tool"),
        noopToolHandler,
      );
      expect(checkFn).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 1: Approval audit trail
  // -------------------------------------------------------------------------

  describe("approval audit trail", () => {
    test("logs second audit entry after approval with allow decision", async () => {
      const entries: AuditEntry[] = [];
      const auditSink = {
        log: async (entry: AuditEntry) => {
          entries.push(entry);
        },
      };
      const mw = createPermissionsMiddleware({
        backend: askAll(),
        auditSink,
      });
      const approvalHandler = async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({
        kind: "allow",
      });
      const ctx = makeTurnContext({ requestApproval: approvalHandler });

      await mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), noopToolHandler);

      expect(entries).toHaveLength(2);
      // First entry: permission check (phase: execute)
      const meta0 = entries[0]?.metadata as Record<string, unknown>;
      expect(meta0.phase).toBe("execute");
      expect(meta0.effect).toBe("ask");

      // Second entry: approval outcome
      const meta1 = entries[1]?.metadata as Record<string, unknown>;
      expect(meta1.phase).toBe("approval_outcome");
      expect(meta1.approvalDecision).toBe("allow");
      expect(meta1.userId).toBe("user-1");
      expect(meta1.permissionCheck).toBe(true);
    });

    test("includes approval delta for modify decisions", async () => {
      const entries: AuditEntry[] = [];
      const auditSink = {
        log: async (entry: AuditEntry) => {
          entries.push(entry);
        },
      };
      const mw = createPermissionsMiddleware({
        backend: askAll(),
        auditSink,
      });
      const approvalHandler = async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({
        kind: "modify",
        updatedInput: { cmd: "safe-cmd" },
      });
      const ctx = makeTurnContext({ requestApproval: approvalHandler });

      await mw.wrapToolCall?.(
        ctx,
        makeToolRequest("deploy", { cmd: "dangerous-cmd" }),
        noopToolHandler,
      );

      expect(entries).toHaveLength(2);
      const meta1 = entries[1]?.metadata as Record<string, unknown>;
      expect(meta1.phase).toBe("approval_outcome");
      expect(meta1.approvalDecision).toBe("modify");
      expect(meta1.originalInput).toEqual({ cmd: "dangerous-cmd" });
      expect(meta1.modifiedInput).toEqual({ cmd: "safe-cmd" });
    });

    test("logs deny reason in second audit entry", async () => {
      const entries: AuditEntry[] = [];
      const auditSink = {
        log: async (entry: AuditEntry) => {
          entries.push(entry);
        },
      };
      const mw = createPermissionsMiddleware({
        backend: askAll(),
        auditSink,
      });
      const approvalHandler = async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({
        kind: "deny",
        reason: "too risky",
      });
      const ctx = makeTurnContext({ requestApproval: approvalHandler });

      try {
        await mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), noopToolHandler);
      } catch {
        // expected — deny throws
      }

      expect(entries).toHaveLength(2);
      const meta1 = entries[1]?.metadata as Record<string, unknown>;
      expect(meta1.phase).toBe("approval_outcome");
      expect(meta1.approvalDecision).toBe("deny");
      expect(meta1.denyReason).toBe("too risky");
      expect(meta1.userId).toBe("user-1");
    });

    test("logs always-allow scope in second audit entry", async () => {
      const entries: AuditEntry[] = [];
      const auditSink = {
        log: async (entry: AuditEntry) => {
          entries.push(entry);
        },
      };
      const mw = createPermissionsMiddleware({
        backend: askAll(),
        auditSink,
      });
      const approvalHandler = async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({
        kind: "always-allow",
        scope: "session",
      });
      const ctx = makeTurnContext({ requestApproval: approvalHandler });

      await mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), noopToolHandler);

      expect(entries).toHaveLength(2);
      const meta1 = entries[1]?.metadata as Record<string, unknown>;
      expect(meta1.phase).toBe("approval_outcome");
      expect(meta1.approvalDecision).toBe("always-allow");
      expect(meta1.scope).toBe("session");
    });

    test("threads userId into first audit entry", async () => {
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

      await mw.wrapToolCall?.(
        makeTurnContext({ userId: "alice" }),
        makeToolRequest("multiply"),
        noopToolHandler,
      );

      expect(entries).toHaveLength(1);
      const meta0 = entries[0]?.metadata as Record<string, unknown>;
      expect(meta0.userId).toBe("alice");
    });
  });

  // -------------------------------------------------------------------------
  // Phase 2: Approval trajectory steps
  // -------------------------------------------------------------------------

  describe("approval trajectory steps", () => {
    test("emits source:user trajectory step on allow", async () => {
      const steps: RichTrajectoryStep[] = [];
      const onApprovalStep = (_sid: string, step: RichTrajectoryStep): void => {
        steps.push(step);
      };
      const mw = createPermissionsMiddleware({
        backend: askAll(),
        onApprovalStep,
      });
      const approvalHandler = async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({
        kind: "allow",
      });
      const ctx = makeTurnContext({ requestApproval: approvalHandler });

      await mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), noopToolHandler);

      expect(steps).toHaveLength(1);
      const step = steps[0] as RichTrajectoryStep;
      expect(step.source).toBe("user");
      expect(step.kind).toBe("tool_call");
      expect(step.identifier).toBe("deploy");
      expect(step.outcome).toBe("success");
      const meta = step.metadata as Record<string, unknown>;
      expect(meta.approvalDecision).toBe("allow");
      expect(meta.userId).toBe("user-1");
    });

    test("emits trajectory step with delta for modify", async () => {
      const steps: RichTrajectoryStep[] = [];
      const onApprovalStep = (_sid: string, step: RichTrajectoryStep): void => {
        steps.push(step);
      };
      const mw = createPermissionsMiddleware({
        backend: askAll(),
        onApprovalStep,
      });
      const approvalHandler = async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({
        kind: "modify",
        updatedInput: { safe: true },
      });
      const ctx = makeTurnContext({ requestApproval: approvalHandler });

      await mw.wrapToolCall?.(ctx, makeToolRequest("deploy", { dangerous: true }), noopToolHandler);

      expect(steps).toHaveLength(1);
      const step = steps[0] as RichTrajectoryStep;
      expect(step.source).toBe("user");
      expect(step.outcome).toBe("success");
      const req = step.request as Record<string, unknown>;
      expect(req.data).toEqual({ dangerous: true });
      const meta = step.metadata as Record<string, unknown>;
      expect(meta.approvalDecision).toBe("modify");
      expect(meta.modifiedInput).toEqual({ safe: true });
    });

    test("emits failure trajectory step on deny", async () => {
      const steps: RichTrajectoryStep[] = [];
      const onApprovalStep = (_sid: string, step: RichTrajectoryStep): void => {
        steps.push(step);
      };
      const mw = createPermissionsMiddleware({
        backend: askAll(),
        onApprovalStep,
      });
      const approvalHandler = async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({
        kind: "deny",
        reason: "rejected",
      });
      const ctx = makeTurnContext({ requestApproval: approvalHandler });

      try {
        await mw.wrapToolCall?.(ctx, makeToolRequest("deploy"), noopToolHandler);
      } catch {
        // expected
      }

      expect(steps).toHaveLength(1);
      const step = steps[0] as RichTrajectoryStep;
      expect(step.source).toBe("user");
      expect(step.outcome).toBe("failure");
      const meta = step.metadata as Record<string, unknown>;
      expect(meta.approvalDecision).toBe("deny");
      expect(meta.denyReason).toBe("rejected");
    });
  });
});
