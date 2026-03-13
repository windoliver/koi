import { describe, expect, mock, test } from "bun:test";
import type { InboundMessage, ModelRequest, ModelResponse, TurnContext } from "@koi/core";
import { createPromptCacheMiddleware, PROMPT_CACHE_HINTS } from "./prompt-cache.js";

function msg(senderId: string, text: string): InboundMessage {
  return {
    senderId,
    content: [{ kind: "text", text }],
    timestamp: Date.now(),
  };
}

const STUB_CTX = {} as TurnContext;

const STUB_RESPONSE: ModelResponse = {
  content: "ok",
  model: "anthropic:claude-sonnet-4-5-20250929",
  usage: { inputTokens: 100, outputTokens: 10 },
};

function createLargeSystemPrompt(tokens: number): string {
  // ~4 chars per token
  return "x".repeat(tokens * 4);
}

describe("createPromptCacheMiddleware", () => {
  describe("wrapModelCall", () => {
    test("reorders messages — system before user", async () => {
      const middleware = createPromptCacheMiddleware();
      const handler = mock(async (_req: ModelRequest) => STUB_RESPONSE);

      const request: ModelRequest = {
        model: "anthropic:claude-sonnet-4-5-20250929",
        messages: [msg("user", "hello"), msg("system", createLargeSystemPrompt(2000))],
      };

      // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
      await middleware.wrapModelCall!(STUB_CTX, request, handler);

      const passedReq = handler.mock.calls[0]?.[0];
      expect(passedReq).toBeDefined();
      expect(passedReq?.messages[0]?.senderId).toBe("system");
      expect(passedReq?.messages[1]?.senderId).toBe("user");
    });

    test("attaches CacheHints via side-channel", async () => {
      const middleware = createPromptCacheMiddleware();
      let capturedRequest: ModelRequest | undefined;
      const handler = mock(async (req: ModelRequest) => {
        capturedRequest = req;
        return STUB_RESPONSE;
      });

      const request: ModelRequest = {
        model: "anthropic:claude-sonnet-4-5-20250929",
        messages: [msg("system", createLargeSystemPrompt(2000)), msg("user", "hello")],
      };

      // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
      await middleware.wrapModelCall!(STUB_CTX, request, handler);

      expect(capturedRequest).toBeDefined();
      const hints = PROMPT_CACHE_HINTS.get(capturedRequest as ModelRequest);
      expect(hints).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: narrowed by prior toBeDefined() assertion
      expect(hints!.provider).toBe("anthropic");
      // biome-ignore lint/style/noNonNullAssertion: narrowed by prior toBeDefined() assertion
      expect(hints!.lastStableIndex).toBe(0);
      // biome-ignore lint/style/noNonNullAssertion: narrowed by prior toBeDefined() assertion
      expect(hints!.staticPrefixTokens).toBeGreaterThanOrEqual(1024);
    });

    test("skips reordering when disabled", async () => {
      const middleware = createPromptCacheMiddleware({ enabled: false });
      const handler = mock(async (_req: ModelRequest) => STUB_RESPONSE);

      const request: ModelRequest = {
        model: "anthropic:claude-sonnet-4-5-20250929",
        messages: [msg("user", "first"), msg("system", createLargeSystemPrompt(2000))],
      };

      // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
      await middleware.wrapModelCall!(STUB_CTX, request, handler);

      // Original order preserved (not reordered)
      const passedReq = handler.mock.calls[0]?.[0];
      expect(passedReq?.messages[0]?.senderId).toBe("user");
    });

    test("skips non-configured providers", async () => {
      const middleware = createPromptCacheMiddleware({ providers: ["openai"] });
      const handler = mock(async (_req: ModelRequest) => STUB_RESPONSE);

      const request: ModelRequest = {
        model: "anthropic:claude-sonnet-4-5-20250929",
        messages: [msg("user", "first"), msg("system", createLargeSystemPrompt(2000))],
      };

      // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
      await middleware.wrapModelCall!(STUB_CTX, request, handler);

      // Original order preserved (Anthropic not in configured providers)
      const passedReq = handler.mock.calls[0]?.[0];
      expect(passedReq?.messages[0]?.senderId).toBe("user");
    });

    test("skips when static prefix is below threshold", async () => {
      const middleware = createPromptCacheMiddleware({ staticPrefixMinTokens: 5000 });
      const handler = mock(async (_req: ModelRequest) => STUB_RESPONSE);

      const request: ModelRequest = {
        model: "anthropic:claude-sonnet-4-5-20250929",
        messages: [msg("user", "hello"), msg("system", createLargeSystemPrompt(1000))],
      };

      // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
      await middleware.wrapModelCall!(STUB_CTX, request, handler);

      const passedReq = handler.mock.calls[0]?.[0];
      // Still user first — threshold not met, no reordering
      expect(passedReq?.messages[0]?.senderId).toBe("user");
    });

    test("handles model without provider prefix", async () => {
      const middleware = createPromptCacheMiddleware();
      let capturedRequest: ModelRequest | undefined;
      const handler = mock(async (req: ModelRequest) => {
        capturedRequest = req;
        return STUB_RESPONSE;
      });

      const request: ModelRequest = {
        model: "claude-sonnet-4-5-20250929",
        messages: [msg("system", createLargeSystemPrompt(2000)), msg("user", "hello")],
      };

      // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
      await middleware.wrapModelCall!(STUB_CTX, request, handler);

      // No provider prefix → still processes (provider check skipped for empty prefix)
      const hints = PROMPT_CACHE_HINTS.get(capturedRequest as ModelRequest);
      expect(hints).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: narrowed by prior toBeDefined() assertion
      expect(hints!.provider).toBe("unknown");
    });

    test("handles undefined model", async () => {
      const middleware = createPromptCacheMiddleware();
      let capturedRequest: ModelRequest | undefined;
      const handler = mock(async (req: ModelRequest) => {
        capturedRequest = req;
        return STUB_RESPONSE;
      });

      const request: ModelRequest = {
        messages: [msg("system", createLargeSystemPrompt(2000)), msg("user", "hello")],
      };

      // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
      await middleware.wrapModelCall!(STUB_CTX, request, handler);

      const hints = PROMPT_CACHE_HINTS.get(capturedRequest as ModelRequest);
      expect(hints).toBeDefined();
    });

    test("no hints when all messages are dynamic", async () => {
      const middleware = createPromptCacheMiddleware();
      let capturedRequest: ModelRequest | undefined;
      const handler = mock(async (req: ModelRequest) => {
        capturedRequest = req;
        return STUB_RESPONSE;
      });

      const request: ModelRequest = {
        model: "anthropic:claude-sonnet-4-5-20250929",
        messages: [msg("user", "hello"), msg("tool", "result")],
      };

      // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
      await middleware.wrapModelCall!(STUB_CTX, request, handler);

      // No static messages → no hints
      const hints = PROMPT_CACHE_HINTS.get(capturedRequest as ModelRequest);
      expect(hints).toBeUndefined();
    });
  });

  describe("wrapModelStream", () => {
    test("reorders messages for stream calls", () => {
      const middleware = createPromptCacheMiddleware();
      const streamHandler = mock((_req: ModelRequest) => {
        async function* gen() {
          yield { kind: "text_delta" as const, delta: "ok" };
        }
        return gen();
      });

      const request: ModelRequest = {
        model: "anthropic:claude-sonnet-4-5-20250929",
        messages: [msg("user", "hello"), msg("system", createLargeSystemPrompt(2000))],
      };

      // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
      middleware.wrapModelStream!(STUB_CTX, request, streamHandler);

      const passedReq = streamHandler.mock.calls[0]?.[0];
      expect(passedReq?.messages[0]?.senderId).toBe("system");
    });
  });

  describe("describeCapabilities", () => {
    test("returns description when enabled", () => {
      const middleware = createPromptCacheMiddleware();
      const fragment = middleware.describeCapabilities(STUB_CTX);
      expect(fragment).toBeDefined();
      expect(fragment?.label).toBe("prompt-cache");
      expect(fragment?.description).toContain("anthropic");
    });

    test("returns undefined when disabled", () => {
      const middleware = createPromptCacheMiddleware({ enabled: false });
      const fragment = middleware.describeCapabilities(STUB_CTX);
      expect(fragment).toBeUndefined();
    });
  });
});
