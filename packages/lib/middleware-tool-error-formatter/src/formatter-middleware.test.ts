import { describe, expect, test } from "bun:test";
import type { KoiError, ToolRequest, ToolResponse, TurnContext } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import { createMockTurnContext, createSpyToolHandler } from "@koi/test";
import { createToolErrorFormatterMiddleware } from "./formatter-middleware.js";
import type { ToolErrorFormatterConfig } from "./types.js";

const mockCtx: TurnContext = createMockTurnContext();

const baseToolRequest: ToolRequest = {
  toolId: "test-tool",
  input: { key: "value" },
};

function getWrapToolCall(
  config?: ToolErrorFormatterConfig,
): (
  ctx: TurnContext,
  request: ToolRequest,
  next: (req: ToolRequest) => Promise<ToolResponse>,
) => Promise<ToolResponse> {
  const handle = createToolErrorFormatterMiddleware(config);
  const wrap = handle.middleware.wrapToolCall;
  if (!wrap) throw new Error("wrapToolCall is not defined");
  return wrap;
}

function createFailingToolHandler(error: unknown): (req: ToolRequest) => Promise<ToolResponse> {
  return async (_req: ToolRequest): Promise<ToolResponse> => {
    throw error;
  };
}

describe("createToolErrorFormatterMiddleware", () => {
  test("has correct middleware name", () => {
    const handle = createToolErrorFormatterMiddleware();
    expect(handle.middleware.name).toBe("tool-error-formatter");
  });

  test("has correct middleware priority", () => {
    const handle = createToolErrorFormatterMiddleware();
    expect(handle.middleware.priority).toBe(170);
  });

  test("describeCapabilities returns correct label", () => {
    const handle = createToolErrorFormatterMiddleware();
    const result = handle.middleware.describeCapabilities?.(mockCtx);
    expect(result?.label).toBe("tool-error-formatter");
    expect(result?.description).toContain("tool errors");
  });

  describe("success path", () => {
    test("passes through without modification (zero overhead)", async () => {
      const wrap = getWrapToolCall();
      const spy = createSpyToolHandler({ output: { result: "ok" } });

      const response = await wrap(mockCtx, baseToolRequest, spy.handler);

      expect(response.output).toEqual({ result: "ok" });
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]).toBe(baseToolRequest);
    });
  });

  describe("error formatting", () => {
    test("KoiError thrown returns formatted ToolResponse with error message", async () => {
      const wrap = getWrapToolCall();
      const koiError: KoiError = {
        code: "EXTERNAL",
        message: "API rate limit exceeded",
        retryable: false,
      };
      const failing = createFailingToolHandler(new KoiRuntimeError(koiError));

      const response = await wrap(mockCtx, baseToolRequest, failing);

      expect(typeof response.output).toBe("string");
      expect(response.output).toContain("test-tool");
      expect(response.output).toContain("API rate limit exceeded");
      expect(response.metadata?.error).toBe(true);
      expect(response.metadata?.toolId).toBe("test-tool");
      expect(response.metadata?.code).toBe("EXTERNAL");
      expect(response.metadata?.retryable).toBe(false);
    });

    test("generic Error thrown returns formatted ToolResponse", async () => {
      const wrap = getWrapToolCall();
      const failing = createFailingToolHandler(new Error("connection refused"));

      const response = await wrap(mockCtx, baseToolRequest, failing);

      expect(typeof response.output).toBe("string");
      expect(response.output).toContain("connection refused");
      expect(response.metadata?.error).toBe(true);
    });

    test("non-Error thrown (string) returns formatted ToolResponse", async () => {
      const wrap = getWrapToolCall();
      const failing = createFailingToolHandler("something went wrong");

      const response = await wrap(mockCtx, baseToolRequest, failing);

      expect(typeof response.output).toBe("string");
      expect(response.output).toContain("something went wrong");
      expect(response.metadata?.error).toBe(true);
    });

    test("null thrown is handled gracefully", async () => {
      const wrap = getWrapToolCall();
      const failing = createFailingToolHandler(null);

      const response = await wrap(mockCtx, baseToolRequest, failing);

      expect(typeof response.output).toBe("string");
      expect(response.metadata?.error).toBe(true);
    });

    test("undefined thrown is handled gracefully", async () => {
      const wrap = getWrapToolCall();
      const failing = createFailingToolHandler(undefined);

      const response = await wrap(mockCtx, baseToolRequest, failing);

      expect(typeof response.output).toBe("string");
      expect(response.metadata?.error).toBe(true);
    });
  });

  describe("custom formatter", () => {
    test("custom formatter is used when provided", async () => {
      const wrap = getWrapToolCall({
        formatter: (error, toolId, _input) => `Custom: ${toolId} failed with ${error.code}`,
      });
      const koiError: KoiError = {
        code: "TIMEOUT",
        message: "timed out",
        retryable: true,
      };
      const failing = createFailingToolHandler(new KoiRuntimeError(koiError));

      const response = await wrap(mockCtx, baseToolRequest, failing);

      expect(response.output).toContain("Custom: test-tool failed with TIMEOUT");
    });

    test("custom formatter that throws falls back to default formatter", async () => {
      const wrap = getWrapToolCall({
        formatter: () => {
          throw new Error("formatter crashed");
        },
      });
      const failing = createFailingToolHandler(new Error("original error"));

      const response = await wrap(mockCtx, baseToolRequest, failing);

      expect(typeof response.output).toBe("string");
      expect(response.output).toContain("original error");
      expect(response.output).toContain("test-tool");
      expect(response.metadata?.error).toBe(true);
    });

    test("custom formatter that returns non-string falls back to default", async () => {
      const wrap = getWrapToolCall({
        // @ts-expect-error — deliberately returning number to test fallback
        formatter: () => 42,
      });
      const failing = createFailingToolHandler(new Error("fallback test"));

      const response = await wrap(mockCtx, baseToolRequest, failing);

      expect(typeof response.output).toBe("string");
      expect(response.output).toContain("fallback test");
      expect(response.output).toContain("test-tool");
    });

    test("async custom formatter is awaited", async () => {
      const wrap = getWrapToolCall({
        formatter: async (error, toolId, _input) => `Async: ${toolId} - ${error.message}`,
      });
      const failing = createFailingToolHandler(new Error("async error"));

      const response = await wrap(mockCtx, baseToolRequest, failing);

      expect(response.output).toContain("Async: test-tool - async error");
    });

    test("custom formatter receives original input", async () => {
      const seen: { toolId?: string; input?: unknown } = {};
      const wrap = getWrapToolCall({
        formatter: (_error, toolId, input) => {
          seen.toolId = toolId;
          seen.input = input;
          return "ok";
        },
      });
      const request: ToolRequest = { toolId: "tool-x", input: { a: 1, b: "two" } };
      const failing = createFailingToolHandler(new Error("boom"));

      await wrap(mockCtx, request, failing);

      expect(seen.toolId).toBe("tool-x");
      expect(seen.input).toEqual({ a: 1, b: "two" });
    });
  });

  describe("secret sanitization", () => {
    test("error message containing sk- pattern is sanitized to [REDACTED]", async () => {
      const wrap = getWrapToolCall();
      const failing = createFailingToolHandler(
        new Error("Auth failed with key sk-abc123def456ghi789jklmnopqrst"),
      );

      const response = await wrap(mockCtx, baseToolRequest, failing);

      const output = response.output;
      expect(typeof output).toBe("string");
      if (typeof output !== "string") return;
      expect(output).not.toContain("sk-abc123def456ghi789jklmnopqrst");
      expect(output).toContain("[REDACTED]");
    });

    test("error message containing Bearer token is sanitized", async () => {
      const wrap = getWrapToolCall();
      const failing = createFailingToolHandler(
        new Error("Request failed with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"),
      );

      const response = await wrap(mockCtx, baseToolRequest, failing);

      const output = response.output;
      expect(typeof output).toBe("string");
      if (typeof output !== "string") return;
      expect(output).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
      expect(output).toContain("[REDACTED]");
    });

    test("custom secret patterns are applied", async () => {
      const wrap = getWrapToolCall({
        secretPatterns: [/xoxb-[A-Za-z0-9-]+/g],
      });
      const failing = createFailingToolHandler(new Error("Slack token xoxb-123-456-abc leaked"));

      const response = await wrap(mockCtx, baseToolRequest, failing);

      const output = response.output;
      expect(typeof output).toBe("string");
      if (typeof output !== "string") return;
      expect(output).not.toContain("xoxb-123-456-abc");
      expect(output).toContain("[REDACTED]");
    });
  });

  describe("truncation", () => {
    test("error message exceeding maxMessageLength is truncated", async () => {
      const wrap = getWrapToolCall({ maxMessageLength: 50 });
      const longMessage = "A".repeat(200);
      const failing = createFailingToolHandler(new Error(longMessage));

      const response = await wrap(mockCtx, baseToolRequest, failing);

      const output = response.output;
      expect(typeof output).toBe("string");
      if (typeof output !== "string") return;
      expect(output.length).toBeLessThanOrEqual(50);
      expect(output).toContain("... (truncated)");
    });

    test("error message within maxMessageLength is not truncated", async () => {
      const wrap = getWrapToolCall({ maxMessageLength: 1000 });
      const failing = createFailingToolHandler(new Error("short error"));

      const response = await wrap(mockCtx, baseToolRequest, failing);

      const output = response.output;
      expect(typeof output).toBe("string");
      if (typeof output !== "string") return;
      expect(output).not.toContain("... (truncated)");
    });
  });

  describe("structured failure metadata", () => {
    test("KoiError context is preserved in metadata", async () => {
      const wrap = getWrapToolCall();
      const koiError: KoiError = {
        code: "EXTERNAL",
        message: "rate limited",
        retryable: true,
        context: { resourceId: "/api/v1/foo", limit: 100 },
        retryAfterMs: 5000,
      };
      const failing = createFailingToolHandler(new KoiRuntimeError(koiError));

      const response = await wrap(mockCtx, baseToolRequest, failing);

      expect(response.metadata?.context).toEqual({ resourceId: "/api/v1/foo", limit: 100 });
      expect(response.metadata?.retryAfterMs).toBe(5000);
      expect(response.metadata?.originalMessage).toBe("rate limited");
    });

    test("KoiError cause is captured (sanitized)", async () => {
      const wrap = getWrapToolCall();
      const koiError: KoiError = {
        code: "INTERNAL",
        message: "wrapped",
        retryable: false,
        cause: new Error("inner sk-abc123def456ghi789jklmnopqrst leaked"),
      };
      const failing = createFailingToolHandler(new KoiRuntimeError(koiError));

      const response = await wrap(mockCtx, baseToolRequest, failing);

      const cause = response.metadata?.cause;
      expect(typeof cause).toBe("string");
      if (typeof cause === "string") {
        expect(cause).toContain("[REDACTED]");
        expect(cause).not.toContain("sk-abc123def456ghi789jklmnopqrst");
      }
    });

    test("generic Error stack is preserved (sanitized)", async () => {
      const wrap = getWrapToolCall();
      const failing = createFailingToolHandler(new Error("boom"));

      const response = await wrap(mockCtx, baseToolRequest, failing);

      expect(typeof response.metadata?.stack).toBe("string");
      expect(response.metadata?.originalMessage).toBe("boom");
    });

    test("originalMessage is sanitized but not truncated like the output", async () => {
      const wrap = getWrapToolCall({ maxMessageLength: 50 });
      const longMsg = `${"X".repeat(200)} sk-abc123def456ghi789jklmnopqrst`;
      const failing = createFailingToolHandler(new Error(longMsg));

      const response = await wrap(mockCtx, baseToolRequest, failing);

      const orig = response.metadata?.originalMessage;
      expect(typeof orig).toBe("string");
      if (typeof orig === "string") {
        expect(orig.length).toBeGreaterThan(100); // not truncated
        expect(orig).toContain("[REDACTED]"); // sanitized
        expect(orig).not.toContain("sk-abc123def456ghi789jklmnopqrst");
      }
    });

    test("non-Error throw produces originalMessage", async () => {
      const wrap = getWrapToolCall();
      const failing = createFailingToolHandler("plain string failure");

      const response = await wrap(mockCtx, baseToolRequest, failing);

      expect(response.metadata?.originalMessage).toBe("plain string failure");
    });
  });

  describe("cancellation propagation", () => {
    test("AbortError is re-thrown, not converted to ToolResponse", async () => {
      const wrap = getWrapToolCall();
      const abortError = new Error("aborted");
      abortError.name = "AbortError";
      const failing = createFailingToolHandler(abortError);

      let thrown: unknown;
      try {
        await wrap(mockCtx, baseToolRequest, failing);
      } catch (e: unknown) {
        thrown = e;
      }
      expect(thrown).toBe(abortError);
    });

    test("Error with code ABORT_ERR is re-thrown", async () => {
      const wrap = getWrapToolCall();
      const err = Object.assign(new Error("aborted"), { code: "ABORT_ERR" });
      const failing = createFailingToolHandler(err);

      let thrown: unknown;
      try {
        await wrap(mockCtx, baseToolRequest, failing);
      } catch (e: unknown) {
        thrown = e;
      }
      expect(thrown).toBe(err);
    });

    test("aborted signal on request: throw is re-thrown even if not an AbortError", async () => {
      const wrap = getWrapToolCall();
      const controller = new AbortController();
      controller.abort();
      const request: ToolRequest = {
        toolId: "test-tool",
        input: { key: "value" },
        signal: controller.signal,
      };
      const generic = new Error("io interrupted");
      const failing = createFailingToolHandler(generic);

      let thrown: unknown;
      try {
        await wrap(mockCtx, request, failing);
      } catch (e: unknown) {
        thrown = e;
      }
      expect(thrown).toBe(generic);
    });
  });

  describe("immutability", () => {
    test("original request is not mutated", async () => {
      const wrap = getWrapToolCall();
      const request: ToolRequest = {
        toolId: "test-tool",
        input: { key: "value" },
      };
      const requestCopy = JSON.parse(JSON.stringify(request)) as ToolRequest;
      const failing = createFailingToolHandler(new Error("boom"));

      await wrap(mockCtx, request, failing);

      expect(request).toEqual(requestCopy);
    });
  });
});
