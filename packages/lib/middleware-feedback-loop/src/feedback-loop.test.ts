import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { SessionContext, TurnContext } from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";
import type { BrickId } from "@koi/core/brick-snapshot";
import type { ModelRequest, ModelResponse, ToolRequest, ToolResponse } from "@koi/core/middleware";
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
