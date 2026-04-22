import { describe, expect, it, mock } from "bun:test";
import type { SessionContext, TurnContext } from "@koi/core";
import type { ModelRequest, ModelResponse, ToolRequest, ToolResponse } from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import type { FeedbackLoopConfig, ForgeHealthConfig } from "./config.js";
import { createFeedbackLoopMiddleware } from "./feedback-loop.js";
import type { Gate, ValidationError, ValidationResult, Validator } from "./types.js";

// ---------------------------------------------------------------------------
// Minimal mock helpers
// ---------------------------------------------------------------------------

function mockSessionCtx(): SessionContext {
  return {
    agentId: "test-agent",
    sessionId: "sess-1" as unknown as SessionContext["sessionId"],
    runId: "run-1" as unknown as SessionContext["runId"],
    metadata: {},
  };
}

function mockTurnCtx(): TurnContext {
  return {
    session: mockSessionCtx(),
    turnIndex: 0,
    turnId: "turn-1" as unknown as TurnContext["turnId"],
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
      const retryCallback = mock((_attempt: number, _errors: readonly ValidationError[]) => {});

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
      let nextCallCount = 0;
      const next = mock(async (_req: ModelRequest) => {
        nextCallCount++;
        return nextCallCount === 1 ? mockModelResponse() : mockModelResponse();
      });

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
  });

  describe("session lifecycle", () => {
    it("creates tracker on session start and disposes on session end", async () => {
      // Minimal ForgeHealthConfig with stub implementations
      const minimalForgeHealth: ForgeHealthConfig = {
        resolveBrickId: (_toolId: string) => undefined,
        forgeStore: {
          getFitness: async () => undefined,
          setFitness: async () => {},
          deleteFitness: async () => {},
        } as unknown as ForgeHealthConfig["forgeStore"],
        snapshotChainStore: {
          append: async () => {},
          getChain: async () => [],
          getLatest: async () => undefined,
          subscribe: () => () => {},
        } as unknown as ForgeHealthConfig["snapshotChainStore"],
      };

      const mw = createFeedbackLoopMiddleware({ forgeHealth: minimalForgeHealth });
      const sessionCtx = mockSessionCtx();

      // onSessionStart should not throw
      await mw.onSessionStart?.(sessionCtx);

      // onSessionEnd should call dispose on the tracker without throwing
      await expect(mw.onSessionEnd?.(sessionCtx)).resolves.toBeUndefined();
    });
  });
});
