import { describe, expect, mock, test } from "bun:test";
import type { KoiError, ModelChunk, ModelRequest, ModelResponse, TurnContext } from "@koi/core";
import { createCircuitBreakerMiddleware } from "./circuit-breaker-middleware.js";

const STUB_CTX = {} as TurnContext;

const STUB_RESPONSE: ModelResponse = {
  content: "ok",
  model: "anthropic:claude-sonnet-4-5-20250929",
  usage: { inputTokens: 100, outputTokens: 10 },
};

function request(model?: string): ModelRequest {
  const messages = [
    { senderId: "user", content: [{ kind: "text", text: "hi" }], timestamp: Date.now() },
  ] as const;
  if (model !== undefined) return { model, messages };
  return { messages };
}

describe("createCircuitBreakerMiddleware", () => {
  describe("wrapModelCall", () => {
    test("passes requests through when circuit is closed", async () => {
      const mw = createCircuitBreakerMiddleware();
      const handler = mock(async () => STUB_RESPONSE);

      // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
      const result = await mw.wrapModelCall!(STUB_CTX, request("anthropic:claude"), handler);
      expect(result.content).toBe("ok");
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test("records success on successful call", async () => {
      const mw = createCircuitBreakerMiddleware({
        breaker: { failureThreshold: 2, cooldownMs: 100, failureWindowMs: 1000 },
      });
      const handler = mock(async () => STUB_RESPONSE);

      // Multiple successful calls should keep circuit closed
      for (let i = 0; i < 5; i++) {
        // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
        await mw.wrapModelCall!(STUB_CTX, request("anthropic:claude"), handler);
      }
      expect(handler).toHaveBeenCalledTimes(5);
    });

    test("opens circuit after failure threshold", async () => {
      const mw = createCircuitBreakerMiddleware({
        breaker: {
          failureThreshold: 2,
          cooldownMs: 60_000,
          failureWindowMs: 60_000,
          failureStatusCodes: [500],
        },
      });

      const failHandler = mock(async () => {
        const err = new Error("fail") as Error & { status: number };
        err.status = 500;
        throw err;
      });

      // Two failures should open the circuit
      await expect(
        // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
        mw.wrapModelCall!(STUB_CTX, request("anthropic:claude"), failHandler),
      ).rejects.toThrow();
      await expect(
        // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
        mw.wrapModelCall!(STUB_CTX, request("anthropic:claude"), failHandler),
      ).rejects.toThrow();

      // Third call should fail fast (circuit open)
      const okHandler = mock(async () => STUB_RESPONSE);
      await expect(
        // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
        mw.wrapModelCall!(STUB_CTX, request("anthropic:claude"), okHandler),
      ).rejects.toThrow(/Circuit breaker open/);
      expect(okHandler).not.toHaveBeenCalled();
    });

    test("fails fast when circuit is open (model-router handles failover)", async () => {
      const mw = createCircuitBreakerMiddleware({
        breaker: {
          failureThreshold: 1,
          cooldownMs: 60_000,
          failureWindowMs: 60_000,
          failureStatusCodes: [500],
        },
      });

      const failHandler = mock(async () => {
        const err = new Error("fail") as Error & { status: number };
        err.status = 500;
        throw err;
      });

      // Open the circuit
      await expect(
        // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
        mw.wrapModelCall!(STUB_CTX, request("anthropic:claude"), failHandler),
      ).rejects.toThrow();

      // Should fail fast — no fallback, router handles provider failover
      const okHandler = mock(async () => STUB_RESPONSE);
      await expect(
        // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
        mw.wrapModelCall!(STUB_CTX, request("anthropic:claude"), okHandler),
      ).rejects.toThrow(/Circuit breaker open/);
      expect(okHandler).not.toHaveBeenCalled();
    });

    test("isolates circuits per provider", async () => {
      const mw = createCircuitBreakerMiddleware({
        breaker: {
          failureThreshold: 1,
          cooldownMs: 60_000,
          failureWindowMs: 60_000,
          failureStatusCodes: [500],
        },
      });

      const failHandler = mock(async () => {
        const err = new Error("fail") as Error & { status: number };
        err.status = 500;
        throw err;
      });

      // Open anthropic circuit
      await expect(
        // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
        mw.wrapModelCall!(STUB_CTX, request("anthropic:claude"), failHandler),
      ).rejects.toThrow();

      // OpenAI should still work (different provider, separate circuit)
      const okHandler = mock(async () => STUB_RESPONSE);
      // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
      const result = await mw.wrapModelCall!(STUB_CTX, request("openai:gpt-4o"), okHandler);
      expect(result.content).toBe("ok");
    });

    test("maps KoiError codes to status codes", async () => {
      const mw = createCircuitBreakerMiddleware({
        breaker: {
          failureThreshold: 1,
          cooldownMs: 60_000,
          failureWindowMs: 60_000,
          failureStatusCodes: [429],
        },
      });

      const rateLimitHandler = mock(async () => {
        const err: KoiError = {
          code: "RATE_LIMIT",
          message: "rate limited",
          retryable: true,
        };
        throw err;
      });

      // KoiError RATE_LIMIT → status 429 → should trip breaker
      await expect(
        // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
        mw.wrapModelCall!(STUB_CTX, request("anthropic:claude"), rateLimitHandler),
      ).rejects.toThrow();

      const okHandler = mock(async () => STUB_RESPONSE);
      await expect(
        // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
        mw.wrapModelCall!(STUB_CTX, request("anthropic:claude"), okHandler),
      ).rejects.toThrow(/Circuit breaker open/);
    });

    test("handles model without provider prefix", async () => {
      const mw = createCircuitBreakerMiddleware();
      const handler = mock(async () => STUB_RESPONSE);

      // No provider prefix → uses "default" breaker key
      // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
      const result = await mw.wrapModelCall!(STUB_CTX, request("claude-sonnet"), handler);
      expect(result.content).toBe("ok");
    });
  });

  describe("wrapModelStream", () => {
    test("passes stream through when circuit is closed", async () => {
      const mw = createCircuitBreakerMiddleware();
      const chunks: ModelChunk[] = [
        { kind: "text_delta", delta: "hello" },
        { kind: "done", response: STUB_RESPONSE },
      ];
      const streamHandler = mock(() => {
        async function* gen() {
          for (const c of chunks) yield c;
        }
        return gen();
      });

      const result: ModelChunk[] = [];
      // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
      for await (const chunk of mw.wrapModelStream!(
        STUB_CTX,
        request("anthropic:claude"),
        streamHandler,
      )) {
        result.push(chunk);
      }

      expect(result).toHaveLength(2);
      expect(result[0]?.kind).toBe("text_delta");
      expect(result[1]?.kind).toBe("done");
    });

    test("yields error chunk when circuit is open (no fallback)", async () => {
      const mw = createCircuitBreakerMiddleware({
        breaker: {
          failureThreshold: 1,
          cooldownMs: 60_000,
          failureWindowMs: 60_000,
          failureStatusCodes: [500],
        },
      });

      // Open the circuit via a model call
      const failHandler = mock(async () => {
        const err = new Error("fail") as Error & { status: number };
        err.status = 500;
        throw err;
      });
      await expect(
        // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
        mw.wrapModelCall!(STUB_CTX, request("anthropic:claude"), failHandler),
      ).rejects.toThrow();

      // Stream call should yield error
      const streamHandler = mock(() => {
        async function* gen() {
          yield { kind: "text_delta" as const, delta: "nope" };
        }
        return gen();
      });

      const result: ModelChunk[] = [];
      // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
      for await (const chunk of mw.wrapModelStream!(
        STUB_CTX,
        request("anthropic:claude"),
        streamHandler,
      )) {
        result.push(chunk);
      }

      expect(result).toHaveLength(1);
      expect(result[0]?.kind).toBe("error");
      expect(streamHandler).not.toHaveBeenCalled();
    });
  });

  describe("describeCapabilities", () => {
    test("reports healthy when no circuits are open", () => {
      const mw = createCircuitBreakerMiddleware();
      const fragment = mw.describeCapabilities(STUB_CTX);
      expect(fragment).toBeDefined();
      expect(fragment?.description).toContain("healthy");
    });

    test("reports open circuits", async () => {
      const mw = createCircuitBreakerMiddleware({
        breaker: {
          failureThreshold: 1,
          cooldownMs: 60_000,
          failureWindowMs: 60_000,
          failureStatusCodes: [500],
        },
      });

      const failHandler = mock(async () => {
        const err = new Error("fail") as Error & { status: number };
        err.status = 500;
        throw err;
      });
      await expect(
        // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
        mw.wrapModelCall!(STUB_CTX, request("anthropic:claude"), failHandler),
      ).rejects.toThrow();

      const fragment = mw.describeCapabilities(STUB_CTX);
      expect(fragment?.description).toContain("anthropic");
    });
  });

  describe("concurrent half-open probing", () => {
    test("only one probe allowed in half-open state", async () => {
      const mw = createCircuitBreakerMiddleware({
        breaker: {
          failureThreshold: 1,
          cooldownMs: 0, // immediate transition to half-open
          failureWindowMs: 60_000,
          failureStatusCodes: [500],
        },
      });

      // Trip the breaker
      const failHandler = mock(async () => {
        const err = new Error("fail") as Error & { status: number };
        err.status = 500;
        throw err;
      });
      await expect(
        // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
        mw.wrapModelCall!(STUB_CTX, request("anthropic:claude"), failHandler),
      ).rejects.toThrow();

      // Wait for cooldown (0ms — should transition to half-open on next isAllowed)
      // First call: allowed (probe)
      let probeCallCount = 0;
      const slowHandler = mock(async () => {
        probeCallCount++;
        await new Promise((r) => setTimeout(r, 50));
        return STUB_RESPONSE;
      });

      // Start probe call (don't await)
      // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
      const probePromise = mw.wrapModelCall!(STUB_CTX, request("anthropic:claude"), slowHandler);

      // Second concurrent call should fail fast (probe in flight)
      const secondHandler = mock(async () => STUB_RESPONSE);
      await expect(
        // biome-ignore lint/style/noNonNullAssertion: test assertion after type-narrowing guard
        mw.wrapModelCall!(STUB_CTX, request("anthropic:claude"), secondHandler),
      ).rejects.toThrow(/Circuit breaker open/);
      expect(secondHandler).not.toHaveBeenCalled();

      // Probe should complete successfully
      const result = await probePromise;
      expect(result.content).toBe("ok");
      expect(probeCallCount).toBe(1);
    });
  });
});
