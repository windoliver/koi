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

function mockTurnCtx(): TurnContext {
  const rid = runId("run-1");
  return {
    session: mockSessionCtx(),
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
        const result = await mw.wrapToolCall?.(mockTurnCtx(), mockToolRequest(), next);

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
        const result = await mw2.wrapToolCall?.(mockTurnCtx(), mockToolRequest(), next);

        expect(next).not.toHaveBeenCalled();
        expect((result?.output as { kind: string }).kind).toBe("forge_tool_quarantined");
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

        await expect(mw.wrapToolCall?.(mockTurnCtx(), mockToolRequest(), next)).rejects.toBe(
          toolError,
        );

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
  });
});
