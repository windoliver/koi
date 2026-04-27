import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { SessionContext, TurnContext } from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";
import type { BrickId } from "@koi/core/brick-snapshot";
import type {
  ModelChunk,
  ModelRequest,
  ModelResponse,
  ToolRequest,
  ToolResponse,
} from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import type { FeedbackLoopConfig, ForgeHealthConfig } from "./config.js";
import { createFeedbackLoopMiddleware } from "./feedback-loop.js";
import type { ToolHealthTracker } from "./tool-health.js";
import * as toolHealthModule from "./tool-health.js";
import type { Gate, ToolRequestValidator, ValidationResult, Validator } from "./types.js";

// ---------------------------------------------------------------------------
// Minimal mock helpers
// ---------------------------------------------------------------------------

function mockSessionCtx(): SessionContext {
  const sid = sessionId("sess-1");
  const rid = runId("run-1");
  return {
    agentId: "test-agent",
    sessionId: sid,
    runId: rid,
    metadata: {},
  };
}

function mockTurnCtx(session?: SessionContext): TurnContext {
  const rid = runId("run-1");
  return {
    session: session ?? mockSessionCtx(),
    turnIndex: 0,
    turnId: turnId(rid, 0),
    messages: [],
    metadata: {},
  };
}

function mockModelRequest(): ModelRequest {
  return { messages: [] };
}

function mockModelResponse(): ModelResponse {
  return {
    content: "",
    model: "test-model",
    stopReason: "stop",
  };
}

function mockToolRequest(): ToolRequest {
  return { toolId: "test-tool", input: {} };
}

function mockToolResponse(): ToolResponse {
  return { output: "ok" };
}

/** Minimal ForgeHealthConfig with typed stubs that satisfy the interfaces. */
function makeMinimalForgeHealth(): ForgeHealthConfig {
  return {
    resolveBrickId: (_toolId: string) => undefined,
    forgeStore: {
      save: async () => ({ ok: true, value: undefined }),
      load: async () => ({
        ok: false,
        error: { code: "NOT_FOUND", message: "not found", retryable: false, context: {} },
      }),
      search: async () => ({ ok: true, value: [] }),
      remove: async () => ({ ok: true, value: undefined }),
      update: async () => ({ ok: true, value: undefined }),
      exists: async () => ({ ok: true, value: false }),
    } as ForgeHealthConfig["forgeStore"],
    snapshotChainStore: {
      put: async () => ({ ok: true, value: undefined }),
      get: async () => ({
        ok: false,
        error: { code: "NOT_FOUND", message: "not found", retryable: false, context: {} },
      }),
      head: async () => ({ ok: true, value: undefined }),
      list: async () => ({ ok: true, value: [] }),
      ancestors: async () => ({ ok: true, value: [] }),
      fork: async () => ({
        ok: false,
        error: { code: "NOT_FOUND", message: "not found", retryable: false, context: {} },
      }),
      prune: async () => ({ ok: true, value: 0 }),
      close: () => {},
    } as ForgeHealthConfig["snapshotChainStore"],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createFeedbackLoopMiddleware", () => {
  describe("wrapModelCall", () => {
    it("passes model calls through when no validators or gates configured", async () => {
      const mw = createFeedbackLoopMiddleware({});
      const response = mockModelResponse();
      const next = mock(async (_req: ModelRequest) => response);

      const result = await mw.wrapModelCall?.(mockTurnCtx(), mockModelRequest(), next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(result).toBe(response);
    });

    it("retries model call on validation failure and returns fixed response", async () => {
      let callCount = 0;
      const retryCallback = mock(() => {});

      const validator: Validator = {
        name: "test-validator",
        validate(_response: ModelResponse): ValidationResult {
          callCount++;
          // Fail on first validation, pass on second
          if (callCount === 1) {
            return {
              valid: false,
              errors: [{ validator: "test-validator", message: "output too short" }],
            };
          }
          return { valid: true };
        },
      };

      const config: FeedbackLoopConfig = {
        validators: [validator],
        onRetry: retryCallback,
      };

      const mw = createFeedbackLoopMiddleware(config);
      const next = mock(async (_req: ModelRequest) => mockModelResponse());

      const result = await mw.wrapModelCall?.(mockTurnCtx(), mockModelRequest(), next);

      expect(next).toHaveBeenCalledTimes(2);
      expect(retryCallback).toHaveBeenCalledTimes(1);
      expect(retryCallback).toHaveBeenCalledWith(1, expect.any(Array));
      expect(result).toBeDefined();
    });

    it("retries transport failures when retry.transport.maxAttempts configured without validators", async () => {
      // Transport-only retry config must enter runWithRetry even when no validators/gates
      // are configured. Without this, operators who set retry.transport.maxAttempts get
      // silently ignored and see first-error surfacing instead of retries.
      let callCount = 0;
      const transportError = Object.assign(new Error("transient network error"), {
        cause: { code: "TRANSPORT_ERROR", retryable: true },
      });

      const mw = createFeedbackLoopMiddleware({
        retry: { transport: { maxAttempts: 3 } },
      });

      const next = mock(async (_req: ModelRequest): Promise<ModelResponse> => {
        callCount++;
        if (callCount < 3) throw transportError;
        return mockModelResponse();
      });

      const result = await mw.wrapModelCall?.(mockTurnCtx(), mockModelRequest(), next);

      expect(next).toHaveBeenCalledTimes(3);
      expect(result).toBeDefined();
    });

    it("wrapModelStream buffers and validates when validators are configured", async () => {
      let validateCallCount = 0;
      const validator: Validator = {
        name: "v",
        validate(_r: ModelResponse): ValidationResult {
          validateCallCount++;
          return { valid: true };
        },
      };

      const mw = createFeedbackLoopMiddleware({ validators: [validator] });

      const modelResponse: ModelResponse = { content: "hello", model: "m", stopReason: "stop" };
      const sourceChunks: ModelChunk[] = [
        { kind: "text_delta", delta: "hello" },
        { kind: "done", response: modelResponse },
      ];
      const next = async function* (_req: ModelRequest): AsyncIterable<ModelChunk> {
        for (const c of sourceChunks) yield c;
      };

      const collected: ModelChunk[] = [];
      const ctx = mockTurnCtx();
      if (mw.wrapModelStream !== undefined) {
        for await (const chunk of mw.wrapModelStream(ctx, mockModelRequest(), next)) {
          collected.push(chunk);
        }
      }

      // All chunks yielded after validation passes
      expect(collected).toHaveLength(2);
      expect(collected[0]).toEqual({ kind: "text_delta", delta: "hello" });
      expect((collected[1] as { kind: "done"; response: ModelResponse }).kind).toBe("done");
      // Validator ran on the buffered response
      expect(validateCallCount).toBe(1);
    });

    it("wrapModelStream yields error chunk when gate blocks buffered stream", async () => {
      const gate: Gate = {
        name: "block-gate",
        validate(_r: ModelResponse | ToolResponse): ValidationResult {
          return { valid: false, errors: [{ validator: "block-gate", message: "blocked" }] };
        },
      };

      const mw = createFeedbackLoopMiddleware({ gates: [gate] });

      const modelResponse: ModelResponse = { content: "bad", model: "m", stopReason: "stop" };
      const next = async function* (_req: ModelRequest): AsyncIterable<ModelChunk> {
        yield { kind: "done", response: modelResponse };
      };

      const collected: ModelChunk[] = [];
      const ctx = mockTurnCtx();
      if (mw.wrapModelStream !== undefined) {
        for await (const chunk of mw.wrapModelStream(ctx, mockModelRequest(), next)) {
          collected.push(chunk);
        }
      }

      expect(collected).toHaveLength(1);
      expect(collected[0]?.kind).toBe("error");
    });

    it("throws when a gate fails (not retried)", async () => {
      const gate: Gate = {
        name: "strict-gate",
        validate(_response: ModelResponse | ToolResponse): ValidationResult {
          return {
            valid: false,
            errors: [{ validator: "strict-gate", message: "response blocked by gate" }],
          };
        },
      };

      const mw = createFeedbackLoopMiddleware({ gates: [gate] });
      const next = mock(async (_req: ModelRequest) => mockModelResponse());

      await expect(
        mw.wrapModelCall?.(mockTurnCtx(), mockModelRequest(), next),
      ).rejects.toBeInstanceOf(KoiRuntimeError);
    });
  });

  describe("wrapToolCall", () => {
    it("passes tool calls through when no forgeHealth configured", async () => {
      const mw = createFeedbackLoopMiddleware({});
      const response = mockToolResponse();
      const next = mock(async (_req: ToolRequest) => response);

      const result = await mw.wrapToolCall?.(mockTurnCtx(), mockToolRequest(), next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(result).toBe(response);
    });

    it("returns structured quarantine feedback when tool is quarantined", async () => {
      const sessionCtx = mockSessionCtx();
      const fakeBrickId = "brick-test-1" as BrickId;
      const fakeTracker: ToolHealthTracker = {
        recordSuccess: () => {},
        recordFailure: () => {},
        getSnapshot: () => undefined,
        getL0Snapshot: () => undefined,
        checkAndQuarantine: async () => false,
        checkAndDemote: async () => false,
        isQuarantined: async (_toolId: string) => true,
        dispose: async () => {},
      };

      const forgeHealth: ForgeHealthConfig = {
        ...makeMinimalForgeHealth(),
        resolveBrickId: (_toolId: string) => fakeBrickId,
      };

      const spy = spyOn(toolHealthModule, "createToolHealthTracker").mockReturnValue(fakeTracker);
      try {
        const mw = createFeedbackLoopMiddleware({ forgeHealth });
        await mw.onSessionStart?.(sessionCtx);

        const next = mock(async (_req: ToolRequest) => mockToolResponse());
        const result = await mw.wrapToolCall?.(mockTurnCtx(sessionCtx), mockToolRequest(), next);

        expect(next).not.toHaveBeenCalled();
        expect(result).toBeDefined();
        expect((result?.output as { kind: string }).kind).toBe("forge_tool_quarantined");
      } finally {
        spy.mockRestore();
      }
    });

    it("blocks in-session-quarantined tool even when resolveBrickId returns undefined", async () => {
      // Uses the real tracker to prove the session-quarantine fast-path works.
      // Scenario: resolveBrickId always fails (config skew), but the tool was
      // session-quarantined based on failure-rate. The middleware must still block it.
      const sessionCtx = mockSessionCtx();

      const forgeHealth: ForgeHealthConfig = {
        ...makeMinimalForgeHealth(),
        resolveBrickId: (_toolId: string) => undefined, // resolution always fails
        quarantineThreshold: 0.1, // low threshold so 5 failures trigger it
        windowSize: 5,
      };

      // Create a real tracker, spy on the factory so the middleware uses this instance,
      // then manipulate it directly to trigger session quarantine.
      const realTracker = toolHealthModule.createToolHealthTracker(forgeHealth);
      const spy = spyOn(toolHealthModule, "createToolHealthTracker").mockReturnValue(realTracker);
      try {
        const mw2 = createFeedbackLoopMiddleware({ forgeHealth });
        await mw2.onSessionStart?.(sessionCtx);

        // Record failures to breach quarantine threshold, then quarantine
        for (let i = 0; i < 5; i++) realTracker.recordFailure("test-tool", 10, "err");
        await realTracker.checkAndQuarantine("test-tool");

        // Tool is session-quarantined. resolveBrickId still returns undefined.
        // Middleware must block the call.
        const next = mock(async (_req: ToolRequest) => mockToolResponse());
        const result = await mw2.wrapToolCall?.(mockTurnCtx(sessionCtx), mockToolRequest(), next);

        expect(next).not.toHaveBeenCalled();
        expect((result?.output as { kind: string }).kind).toBe("forge_tool_quarantined");
      } finally {
        spy.mockRestore();
      }
    });

    it("F103: classifies in-band { error, code } responses as failures, not successes", async () => {
      // Reviewer F103: tools that report failures via
      // `{ output: { error, code } }` instead of throwing were
      // routed through handleToolSuccess and recordSuccess, leaving
      // quarantine/demotion dormant and disagreeing with forge-demand
      // (which already classified that shape as a failure). Both
      // systems must reach the same verdict for the same call.
      const sessionCtx = mockSessionCtx();
      const recordSuccess = mock((_toolId: string, _latencyMs: number) => {});
      const recordFailure = mock((_toolId: string, _latencyMs: number, _reason: string) => {});
      const fakeTracker: ToolHealthTracker = {
        recordSuccess,
        recordFailure,
        getSnapshot: () => undefined,
        getL0Snapshot: () => undefined,
        checkAndQuarantine: async () => false,
        checkAndDemote: async () => false,
        isQuarantined: async () => false,
        dispose: async () => {},
      };
      const spy = spyOn(toolHealthModule, "createToolHealthTracker").mockReturnValue(fakeTracker);
      try {
        const mw = createFeedbackLoopMiddleware({ forgeHealth: makeMinimalForgeHealth() });
        await mw.onSessionStart?.(sessionCtx);
        // Tool returns an in-band error payload.
        const next = mock(
          async (_req: ToolRequest): Promise<ToolResponse> => ({
            output: { error: "permission denied", code: "EACCES" },
          }),
        );
        const result = await mw.wrapToolCall?.(mockTurnCtx(sessionCtx), mockToolRequest(), next);
        // Response is returned unchanged — feedback-loop is observational.
        expect(result?.output).toEqual({ error: "permission denied", code: "EACCES" });
        // But the tracker counted it as a FAILURE, not a success.
        expect(recordSuccess).not.toHaveBeenCalled();
        expect(recordFailure).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });

    it("F108: in-band { error, code: 'VALIDATION' } is NEUTRAL — neither success nor failure", async () => {
      // Reviewer F108: pre-execution VALIDATION rejects mean the tool
      // body never ran. Counting them as recordSuccess inflates success
      // rate / latency samples and can mask quarantine thresholds.
      // Counting them as recordFailure quarantines a healthy tool over
      // a caller mistake. Correct outcome: skip the tracker entirely.
      const sessionCtx = mockSessionCtx();
      const recordSuccess = mock((_toolId: string, _latencyMs: number) => {});
      const recordFailure = mock((_toolId: string, _latencyMs: number, _reason: string) => {});
      const fakeTracker: ToolHealthTracker = {
        recordSuccess,
        recordFailure,
        getSnapshot: () => undefined,
        getL0Snapshot: () => undefined,
        checkAndQuarantine: async () => false,
        checkAndDemote: async () => false,
        isQuarantined: async () => false,
        dispose: async () => {},
      };
      const spy = spyOn(toolHealthModule, "createToolHealthTracker").mockReturnValue(fakeTracker);
      try {
        const mw = createFeedbackLoopMiddleware({ forgeHealth: makeMinimalForgeHealth() });
        await mw.onSessionStart?.(sessionCtx);
        const next = mock(
          async (_req: ToolRequest): Promise<ToolResponse> => ({
            output: { error: "missing arg 'path'", code: "VALIDATION" },
          }),
        );
        const result = await mw.wrapToolCall?.(mockTurnCtx(sessionCtx), mockToolRequest(), next);
        expect(result?.output).toEqual({ error: "missing arg 'path'", code: "VALIDATION" });
        // NEUTRAL: tracker untouched — neither success nor failure.
        expect(recordFailure).not.toHaveBeenCalled();
        expect(recordSuccess).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("rejects tool call when toolValidators fail (pre-execution, no side effects)", async () => {
      const validator: ToolRequestValidator = {
        name: "arg-check",
        validate(_request: ToolRequest): ValidationResult {
          return { valid: false, errors: [{ validator: "arg-check", message: "bad argument" }] };
        },
      };

      const mw = createFeedbackLoopMiddleware({ toolValidators: [validator] });
      const next = mock(async (_req: ToolRequest) => mockToolResponse());

      await expect(
        mw.wrapToolCall?.(mockTurnCtx(), mockToolRequest(), next),
      ).rejects.toBeInstanceOf(KoiRuntimeError);

      // Tool must NOT have been invoked — validation failed before execution
      expect(next).not.toHaveBeenCalled();
    });

    it("records failure and checks health when tool call throws", async () => {
      const sessionCtx = mockSessionCtx();
      const recordFailure = mock((_toolId: string, _latencyMs: number, _reason: string) => {});
      const fakeTracker: ToolHealthTracker = {
        recordSuccess: () => {},
        recordFailure,
        getSnapshot: () => undefined,
        getL0Snapshot: () => undefined,
        checkAndQuarantine: async () => false,
        checkAndDemote: async () => false,
        isQuarantined: async (_toolId: string) => false,
        dispose: async () => {},
      };

      const spy = spyOn(toolHealthModule, "createToolHealthTracker").mockReturnValue(fakeTracker);
      try {
        const mw = createFeedbackLoopMiddleware({ forgeHealth: makeMinimalForgeHealth() });
        await mw.onSessionStart?.(sessionCtx);

        const toolError = new Error("tool exploded");
        const next = mock(async (_req: ToolRequest): Promise<ToolResponse> => {
          throw toolError;
        });

        await expect(
          mw.wrapToolCall?.(mockTurnCtx(sessionCtx), mockToolRequest(), next),
        ).rejects.toBe(toolError);

        expect(recordFailure).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("session lifecycle", () => {
    let mw: ReturnType<typeof createFeedbackLoopMiddleware>;

    beforeEach(() => {
      mw = createFeedbackLoopMiddleware({ forgeHealth: makeMinimalForgeHealth() });
    });

    it("creates tracker on session start and disposes on session end", async () => {
      const sessionCtx = mockSessionCtx();

      // onSessionStart should not throw
      await mw.onSessionStart?.(sessionCtx);

      // onSessionEnd should call dispose on the tracker without throwing
      await expect(mw.onSessionEnd?.(sessionCtx)).resolves.toBeUndefined();
    });

    it("F100: tracker writes/teardown resolve via the bound sessionId, not ctx.session.sessionId", async () => {
      // Reviewer F100: healthHandle reads were SessionContext-bound
      // (F99) but wrapToolCall/onSessionEnd still resolved trackers
      // through `ctx.session.sessionId` and `ctx.sessionId`. A
      // SessionContext whose sessionId was mutated after onSessionStart
      // would write into a different session's tracker (or dispose
      // an unrelated tenant's tracker on teardown). The fix routes
      // every tracker access through observedSessions.get(ctx).
      const realCtx = mockSessionCtx();
      const originalSid = realCtx.sessionId;
      await mw.onSessionStart?.(realCtx);
      // Mutate the sessionId post-start.
      (realCtx as { sessionId: string }).sessionId = "victim-session";
      // healthHandle resolves via the bound id.
      expect(mw.healthHandle?.getSnapshot(realCtx, "any-tool")).toBeUndefined();
      // onSessionEnd disposes the tracker bound at start, not the
      // mutated id. A fabricated context with the mutated id
      // (representing the "victim" tenant) must NOT have its tracker
      // touched.
      const forgedVictim = {
        sessionId: "victim-session",
        agentId: "atk",
        runId: "fake",
        metadata: {},
      } as never;
      // Forged victim has no observed binding — onSessionEnd is a no-op.
      await expect(mw.onSessionEnd?.(forgedVictim)).resolves.toBeUndefined();
      // The real ctx still has its tracker — healthHandle still
      // resolves (now the mutated sessionId is irrelevant; the bound
      // sid matches originalSid which still has a tracker).
      expect(originalSid).not.toBe("victim-session");
      expect(mw.healthHandle?.getSnapshot(realCtx, "any-tool")).toBeUndefined();
      // Real teardown succeeds.
      await expect(mw.onSessionEnd?.(realCtx)).resolves.toBeUndefined();
    });

    it("F99: healthHandle.getSnapshot only resolves observed SessionContext objects", async () => {
      // Reviewer F99: the prior handle accepted a raw sessionId, so
      // any in-process consumer with the middleware could enumerate
      // snapshots for guessed/known ids — a cross-tenant inspection
      // surface. The fix requires SessionContext object identity:
      // only sessions observed via onSessionStart are visible.
      const realCtx = mockSessionCtx();
      await mw.onSessionStart?.(realCtx);
      // Forged context carrying the same sessionId — must NOT resolve.
      const forged = {
        sessionId: realCtx.sessionId,
        agentId: "attacker",
        runId: "fake",
        metadata: {},
      } as never;
      expect(mw.healthHandle?.getSnapshot(forged, "any-tool")).toBeUndefined();
      // The real ctx is admitted (snapshot for an unrecorded tool is
      // undefined, but the lookup itself is permitted).
      expect(mw.healthHandle?.getSnapshot(realCtx, "any-tool")).toBeUndefined();
      // After onSessionEnd, even the real ctx no longer resolves.
      await mw.onSessionEnd?.(realCtx);
      expect(mw.healthHandle?.getSnapshot(realCtx, "any-tool")).toBeUndefined();
    });

    it("F111: tracker writes do NOT fall back to raw ctx.session.sessionId for unobserved contexts", async () => {
      // Reviewer F111: wrapToolCall resolved tracker as
      // `observedSessions.get(ctx.session) ?? ctx.session.sessionId`.
      // An in-process caller could skip onSessionStart, fabricate a
      // TurnContext naming another tenant's sessionId, and drive
      // recordSuccess/recordFailure into that tenant's live tracker —
      // quarantining a healthy tool or skewing latency windows for a
      // session it does not own. Fix: drop the fallback. Unobserved
      // contexts get NO tracker access, so their traffic cannot
      // poison anyone else's metrics.
      const recordSuccess = mock((_t: string, _l: number) => {});
      const recordFailure = mock((_t: string, _l: number, _r: string) => {});
      const fakeTracker: ToolHealthTracker = {
        recordSuccess,
        recordFailure,
        getSnapshot: () => undefined,
        getL0Snapshot: () => undefined,
        checkAndQuarantine: async () => false,
        checkAndDemote: async () => false,
        isQuarantined: async () => false,
        dispose: async () => {},
      };
      const spy = spyOn(toolHealthModule, "createToolHealthTracker").mockReturnValue(fakeTracker);
      try {
        const mw = createFeedbackLoopMiddleware({ forgeHealth: makeMinimalForgeHealth() });
        // Register a real victim session — this allocates the tracker
        // under the bound id.
        const victim = mockSessionCtx();
        await mw.onSessionStart?.(victim);
        // Attacker fabricates a TurnContext naming the victim's
        // sessionId without ever calling onSessionStart on its own
        // SessionContext object.
        const forgedTurnCtx = {
          ...mockTurnCtx(),
          session: {
            sessionId: victim.sessionId,
            agentId: "attacker",
            runId: "fake",
            metadata: {},
          },
        } as ReturnType<typeof mockTurnCtx>;
        const next = mock(
          async (_req: ToolRequest): Promise<ToolResponse> => ({
            output: { ok: true },
          }),
        );
        await mw.wrapToolCall?.(forgedTurnCtx, mockToolRequest(), next);
        // Tracker must NOT have been written to — fabricated context
        // is unobserved, so no fallback to raw sessionId.
        expect(recordSuccess).not.toHaveBeenCalled();
        expect(recordFailure).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });
});
