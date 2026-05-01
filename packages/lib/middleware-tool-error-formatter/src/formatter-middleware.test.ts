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

    test("default patterns redact common credential shapes", async () => {
      const wrap = getWrapToolCall();
      const cases: readonly { readonly leak: string; readonly secret: string }[] = [
        { leak: "Authorization: Basic dXNlcjpwYXNzd29yZA==", secret: "dXNlcjpwYXNzd29yZA==" },
        { leak: "Cookie: session=abc123xyz789secret", secret: "session=abc123xyz789secret" },
        {
          leak: "https://example.com/?api_key=topsecretvalue&foo=bar",
          secret: "topsecretvalue",
        },
        {
          leak: "JWT: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36",
          secret: "eyJzdWIiOiIxMjM0NSJ9",
        },
        { leak: "AWS key AKIAIOSFODNN7EXAMPLE failed", secret: "AKIAIOSFODNN7EXAMPLE" },
        { leak: "GitHub token ghp_abcdefghijklmnopqrstuvwxyz0123456789 expired", secret: "ghp_" },
        {
          leak: "DB connection postgres://admin:s3cret@host/db unreachable",
          secret: "admin:s3cret",
        },
      ];
      for (const { leak, secret } of cases) {
        const failing = createFailingToolHandler(new Error(leak));
        const response = await wrap(mockCtx, baseToolRequest, failing);
        const output = response.output;
        expect(typeof output).toBe("string");
        if (typeof output !== "string") continue;
        expect(output).not.toContain(secret);
      }
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

    test("custom patterns extend defaults — sk- and Bearer still redacted", async () => {
      const wrap = getWrapToolCall({
        secretPatterns: [/xoxb-[A-Za-z0-9-]+/g],
      });
      const failing = createFailingToolHandler(
        new Error(
          "Slack xoxb-123-456-abc and Bearer eyJhbGciOiJIUzI1NiI and key sk-abc123def456ghi789jklmnopqrst",
        ),
      );

      const response = await wrap(mockCtx, baseToolRequest, failing);

      const output = response.output;
      expect(typeof output).toBe("string");
      if (typeof output !== "string") return;
      expect(output).not.toContain("xoxb-123-456-abc");
      expect(output).not.toContain("eyJhbGciOiJIUzI1NiI");
      expect(output).not.toContain("sk-abc123def456ghi789jklmnopqrst");
    });

    test("replaceDefaultSecretPatterns: true drops MOST defaults but keeps the minimum set", async () => {
      // The full default pattern set is opt-out for tests with predictable
      // output, but a minimum set (sk-* / Bearer / connection strings) is
      // non-removable: a runtime misconfiguration cannot turn the formatter
      // into a leak surface for high-risk credential shapes.
      const wrap = getWrapToolCall({
        secretPatterns: [/xoxb-[A-Za-z0-9-]+/g],
        replaceDefaultSecretPatterns: true,
      });
      const failing = createFailingToolHandler(
        new Error(
          "custom xoxb-1-2-3 and sk-abc123def456ghi789jklmnopqrst plus AKIAIOSFODNN7EXAMPLE",
        ),
      );

      const response = await wrap(mockCtx, baseToolRequest, failing);

      const output = response.output;
      expect(typeof output).toBe("string");
      if (typeof output !== "string") return;
      // Custom pattern still applied
      expect(output).not.toContain("xoxb-1-2-3");
      // Minimum-set patterns are non-removable — sk- still redacted
      expect(output).not.toContain("sk-abc123def456ghi789jklmnopqrst");
      // But broader defaults (AWS keys, JWTs, etc.) are dropped
      expect(output).toContain("AKIAIOSFODNN7EXAMPLE");
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

    test("cyclic context does not crash; cycles become [Circular]", async () => {
      const wrap = getWrapToolCall();
      const cyclic: Record<string, unknown> = {
        name: "loop",
        token: "sk-abc123def456ghi789jklmnopqrst",
      };
      cyclic.self = cyclic;
      const koiError: KoiError = {
        code: "INTERNAL",
        message: "boom",
        retryable: false,
        context: cyclic,
      };
      const failing = createFailingToolHandler(new KoiRuntimeError(koiError));

      // Must not throw / not stack overflow
      const response = await wrap(mockCtx, baseToolRequest, failing);
      const ctx = response.metadata?.context as Record<string, unknown>;
      expect(ctx.name).toBe("loop");
      expect(ctx.token).toBe("[REDACTED]"); // sanitized before cycle hits
      expect(ctx.self).toBe("[Circular]");
    });

    test("KoiError context is recursively sanitized for secrets", async () => {
      const wrap = getWrapToolCall();
      const koiError: KoiError = {
        code: "EXTERNAL",
        message: "auth failed",
        retryable: false,
        context: {
          headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" },
          tokens: ["sk-abc123def456ghi789jklmnopqrst", "safe-value"],
          nested: { apiKey: "sk-secretsecretsecretsecretSecret" },
          numeric: 42,
        },
      };
      const failing = createFailingToolHandler(new KoiRuntimeError(koiError));

      const response = await wrap(mockCtx, baseToolRequest, failing);

      const ctx = response.metadata?.context as Record<string, unknown>;
      expect(ctx).toBeDefined();
      const headers = ctx.headers as Record<string, unknown>;
      expect(headers.authorization).toBe("[REDACTED]");
      const tokens = ctx.tokens as readonly string[];
      expect(tokens[0]).toBe("[REDACTED]");
      expect(tokens[1]).toBe("safe-value");
      const nested = ctx.nested as Record<string, unknown>;
      expect(nested.apiKey).toBe("[REDACTED]");
      expect(ctx.numeric).toBe(42); // non-strings preserved
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

    test("KoiRuntimeError preserves stack alongside KoiError fields", async () => {
      const wrap = getWrapToolCall();
      const koiError: KoiError = {
        code: "EXTERNAL",
        message: "remote api failed",
        retryable: true,
      };
      const failing = createFailingToolHandler(new KoiRuntimeError(koiError));

      const response = await wrap(mockCtx, baseToolRequest, failing);

      // KoiError fields preserved
      expect(response.metadata?.code).toBe("EXTERNAL");
      expect(response.metadata?.retryable).toBe(true);
      // Error fields ALSO preserved (stack)
      expect(typeof response.metadata?.stack).toBe("string");
      const stack = response.metadata?.stack;
      if (typeof stack === "string") expect(stack.length).toBeGreaterThan(0);
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

  describe("recursion depth safety", () => {
    test("deeply nested context does NOT crash the formatter (depth-bounded sanitize)", async () => {
      // Regression: a tool that throws a KoiError with extremely deep
      // context must not stack-overflow the sanitizer and abort the turn.
      const wrap = getWrapToolCall();
      // Build a 5000-deep nested object
      const root: { next?: unknown; leak?: string } = {};
      let cursor: { next?: unknown; leak?: string } = root;
      for (let i = 0; i < 5000; i++) {
        const child: { next?: unknown; leak?: string } = {};
        cursor.next = child;
        cursor = child;
      }
      cursor.leak = "sk-shouldbe-redactedifreached12345";

      const err = {
        name: "KoiRuntimeError",
        code: "EXTERNAL",
        message: "deep payload",
        retryable: false,
        context: root as unknown as Record<string, unknown>,
      };
      const failing = createFailingToolHandler(err);

      // Must return a ToolResponse (not throw) and include error metadata
      const response = await wrap(mockCtx, baseToolRequest, failing);
      expect(response.metadata?.error).toBe(true);
      // Serialization must succeed
      expect(() => JSON.stringify(response.metadata)).not.toThrow();
      // Truncation marker present somewhere in the serialized form
      const serialized = JSON.stringify(response.metadata);
      expect(serialized).toContain("[TruncatedDepth]");
    });
  });

  describe("metadata JSON-safety", () => {
    test("ToolResponse.metadata survives JSON.stringify with bigint/Date/function context", async () => {
      // Regression: KoiError.context with non-JSON-safe values (bigint, Date,
      // function, symbol) must be coerced before reaching metadata.context.
      // Otherwise a downstream serializer (audit, transcript) would throw and
      // turn a handled tool failure into a turn-level crash.
      const wrap = getWrapToolCall();
      const err = {
        name: "KoiRuntimeError",
        code: "EXTERNAL",
        message: "downstream failed",
        retryable: true,
        context: {
          big: 12345678901234567890n,
          when: new Date("2026-01-01T00:00:00Z"),
          handler: () => "should not be serialized",
          marker: Symbol("test"),
          regular: "ok",
        },
      };
      const failing = createFailingToolHandler(err);
      const response = await wrap(mockCtx, baseToolRequest, failing);

      expect(response.metadata?.error).toBe(true);
      // Must not throw.
      const serialized = JSON.stringify(response.metadata);
      expect(typeof serialized).toBe("string");
      const parsed = JSON.parse(serialized) as {
        context?: { big?: unknown; when?: unknown; handler?: unknown; marker?: unknown };
      };
      expect(parsed.context?.big).toBe("12345678901234567890n");
      expect(parsed.context?.when).toBe("2026-01-01T00:00:00.000Z");
      expect(parsed.context?.handler).toBe("[function]");
      expect(parsed.context?.marker).toBe("[symbol]");
    });
  });

  describe("guardrail provenance propagation", () => {
    test("error with guardrail:true is re-thrown without explicit passthroughCodes", async () => {
      // Regression: defense-in-depth — guardrail errors propagate regardless
      // of priority ordering or passthroughCodes config.
      const wrap = getWrapToolCall();
      const err = Object.assign(new Error("permission denied"), { guardrail: true });
      const failing = createFailingToolHandler(err);

      let thrown: unknown;
      try {
        await wrap(mockCtx, baseToolRequest, failing);
      } catch (e: unknown) {
        thrown = e;
      }
      expect(thrown).toBe(err);
    });

    test("KoiError with context.guardrail:true is re-thrown", async () => {
      const wrap = getWrapToolCall();
      const err = {
        name: "KoiRuntimeError",
        code: "PERMISSION",
        message: "blocked by policy",
        retryable: false,
        context: { guardrail: true },
      };
      const failing = createFailingToolHandler(err);

      let thrown: unknown;
      try {
        await wrap(mockCtx, baseToolRequest, failing);
      } catch (e: unknown) {
        thrown = e;
      }
      expect(thrown).toBe(err);
    });
  });

  describe("post-commit failure propagation", () => {
    test("error with committed:true is re-thrown (no retryable-looking ToolResponse)", async () => {
      // Regression: the tool already executed and side effects landed.
      // Surfacing a ToolResponse here would invite the model to retry a
      // non-idempotent tool and duplicate the side effect.
      const wrap = getWrapToolCall();
      const err = Object.assign(new Error("audit write failed after commit"), {
        committed: true,
      });
      const failing = createFailingToolHandler(err);

      let thrown: unknown;
      try {
        await wrap(mockCtx, baseToolRequest, failing);
      } catch (e: unknown) {
        thrown = e;
      }
      expect(thrown).toBe(err);
    });

    test("KoiError with context.committed:true is re-thrown", async () => {
      const wrap = getWrapToolCall();
      const err = {
        name: "KoiRuntimeError",
        code: "EXTERNAL",
        message: "post-commit logging failed",
        retryable: false,
        context: { committed: true },
      };
      const failing = createFailingToolHandler(err);

      let thrown: unknown;
      try {
        await wrap(mockCtx, baseToolRequest, failing);
      } catch (e: unknown) {
        thrown = e;
      }
      expect(thrown).toBe(err);
    });

    test("error without committed flag is formatted as ordinary tool failure", async () => {
      const wrap = getWrapToolCall();
      const err = new Error("network blip");
      const failing = createFailingToolHandler(err);

      const response = await wrap(mockCtx, baseToolRequest, failing);
      expect(response.metadata?.error).toBe(true);
      expect(typeof response.output).toBe("string");
    });
  });

  describe("guardrail passthrough", () => {
    test("default has empty passthroughCodes — tool-originated errors are formatted", async () => {
      // Tool wrapping a SaaS SDK throws RATE_LIMIT — this is a tool failure,
      // not a guardrail abort. Must format as model-visible recovery feedback.
      const wrap = getWrapToolCall();
      const koiError: KoiError = {
        code: "RATE_LIMIT",
        message: "Stripe quota exhausted",
        retryable: true,
      };
      const failing = createFailingToolHandler(new KoiRuntimeError(koiError));

      const response = await wrap(mockCtx, baseToolRequest, failing);
      expect(typeof response.output).toBe("string");
      expect(response.metadata?.error).toBe(true);
      expect(response.metadata?.code).toBe("RATE_LIMIT");
    });

    test("explicit passthroughCodes opt-in re-throws (call-limits-inside-formatter wiring)", async () => {
      // Stack with call-limits at priority 175 (inside formatter at 170) must
      // opt in to passthrough RATE_LIMIT.
      const wrap = getWrapToolCall({ passthroughCodes: ["RATE_LIMIT"] });
      const koiError: KoiError = {
        code: "RATE_LIMIT",
        message: "call-limits hard stop",
        retryable: true,
      };
      const failing = createFailingToolHandler(new KoiRuntimeError(koiError));

      let thrown: unknown;
      try {
        await wrap(mockCtx, baseToolRequest, failing);
      } catch (e: unknown) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(KoiRuntimeError);
    });

    test("custom passthroughCodes scoped to caller's intent (only the listed codes throw)", async () => {
      const wrap = getWrapToolCall({ passthroughCodes: ["TIMEOUT"] });

      const tErr: KoiError = { code: "TIMEOUT", message: "op timed out", retryable: true };
      const failing2 = createFailingToolHandler(new KoiRuntimeError(tErr));
      let tThrown: unknown;
      try {
        await wrap(mockCtx, baseToolRequest, failing2);
      } catch (e: unknown) {
        tThrown = e;
      }
      expect(tThrown).toBeInstanceOf(KoiRuntimeError);

      // RATE_LIMIT not in caller's list → still formatted
      const rErr: KoiError = { code: "RATE_LIMIT", message: "tool quota", retryable: true };
      const failing1 = createFailingToolHandler(new KoiRuntimeError(rErr));
      const response = await wrap(mockCtx, baseToolRequest, failing1);
      expect(typeof response.output).toBe("string");
      expect(response.metadata?.error).toBe(true);
    });

    test("passthroughPredicate can re-throw codes outside the default set", async () => {
      const wrap = getWrapToolCall({
        passthroughPredicate: (e: unknown): boolean => {
          if (e === null || typeof e !== "object") return false;
          const ctx = (e as { context?: { kind?: unknown } }).context;
          return ctx?.kind === "tool"; // governance approval marker
        },
      });
      const koiError: KoiError = {
        code: "TIMEOUT",
        message: "approval timed out",
        retryable: false,
        context: { kind: "tool", askId: "abc" },
      };
      const failing = createFailingToolHandler(new KoiRuntimeError(koiError));

      let thrown: unknown;
      try {
        await wrap(mockCtx, baseToolRequest, failing);
      } catch (e: unknown) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(KoiRuntimeError);
    });

    test("passthroughPredicate that throws falls back to formatting", async () => {
      const wrap = getWrapToolCall({
        passthroughPredicate: () => {
          throw new Error("predicate broken");
        },
      });
      const failing = createFailingToolHandler(new Error("tool boom"));

      const response = await wrap(mockCtx, baseToolRequest, failing);
      expect(response.metadata?.error).toBe(true);
    });

    test("non-passthrough KoiError codes are still formatted", async () => {
      const wrap = getWrapToolCall();
      const koiError: KoiError = {
        code: "EXTERNAL",
        message: "api fail",
        retryable: false,
      };
      const failing = createFailingToolHandler(new KoiRuntimeError(koiError));

      const response = await wrap(mockCtx, baseToolRequest, failing);
      expect(typeof response.output).toBe("string");
      expect(response.metadata?.error).toBe(true);
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
