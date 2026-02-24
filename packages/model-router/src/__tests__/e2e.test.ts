/**
 * End-to-end tests for model-router with real LLM API calls.
 *
 * Gated on environment variables — tests are skipped when the corresponding
 * API key is not set. Each provider block is independent so partial key sets
 * still run available tests.
 *
 * Environment variables:
 *   OPENAI_API_KEY      — enables OpenAI tests
 *   ANTHROPIC_API_KEY   — enables Anthropic tests
 *   OPENROUTER_API_KEY  — enables OpenRouter tests
 *
 * Run: OPENAI_API_KEY=... ANTHROPIC_API_KEY=... OPENROUTER_API_KEY=... bun test src/__tests__/e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { ModelRequest } from "@koi/core";
import { createAnthropicAdapter } from "../adapters/anthropic.js";
import { createOpenAIAdapter } from "../adapters/openai.js";
import { createOpenRouterAdapter } from "../adapters/openrouter.js";
import { validateRouterConfig } from "../config.js";
import type { ProviderAdapter, StreamChunk } from "../provider-adapter.js";
import { createModelRouter } from "../router.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";

const HAS_OPENAI = OPENAI_KEY.length > 0;
const HAS_ANTHROPIC = ANTHROPIC_KEY.length > 0;
const HAS_OPENROUTER = OPENROUTER_KEY.length > 0;
const HAS_ALL = HAS_OPENAI && HAS_ANTHROPIC && HAS_OPENROUTER;

const TIMEOUT_MS = 30_000;

function makeRequest(text = "Reply with exactly one word: hello"): ModelRequest {
  return {
    messages: [
      {
        content: [{ kind: "text" as const, text }],
        senderId: "e2e-test",
        timestamp: Date.now(),
      },
    ],
    maxTokens: 10,
    temperature: 0,
  };
}

async function collectStream(
  adapter: ProviderAdapter,
  request: ModelRequest,
): Promise<{
  readonly chunks: readonly StreamChunk[];
  readonly textDeltas: readonly string[];
  readonly hasFinish: boolean;
  readonly errors: readonly StreamChunk[];
}> {
  const chunks: StreamChunk[] = [];
  const textDeltas: string[] = [];
  let hasFinish = false;
  const errors: StreamChunk[] = [];

  for await (const chunk of adapter.stream(request)) {
    chunks.push(chunk);
    if (chunk.kind === "text_delta") {
      textDeltas.push(chunk.text);
    } else if (chunk.kind === "finish") {
      hasFinish = true;
    } else if (chunk.kind === "error") {
      errors.push(chunk);
    }
  }

  return { chunks, textDeltas, hasFinish, errors };
}

// ---------------------------------------------------------------------------
// Block 1: Individual adapters
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_OPENAI)("e2e: OpenAI adapter", () => {
  const adapter = createOpenAIAdapter({ apiKey: OPENAI_KEY });

  test(
    "complete returns non-empty response",
    async () => {
      const request: ModelRequest = { ...makeRequest(), model: "gpt-4o-mini" };
      const response = await adapter.complete(request);

      expect(typeof response.content).toBe("string");
      expect(response.content.length).toBeGreaterThan(0);
      expect(typeof response.model).toBe("string");
    },
    TIMEOUT_MS,
  );

  test(
    "stream yields text_delta and finish chunks",
    async () => {
      const request: ModelRequest = { ...makeRequest(), model: "gpt-4o-mini" };
      const result = await collectStream(adapter, request);

      expect(result.textDeltas.length).toBeGreaterThan(0);
      expect(result.hasFinish).toBe(true);
      expect(result.errors).toHaveLength(0);
    },
    TIMEOUT_MS,
  );
});

describe.skipIf(!HAS_ANTHROPIC)("e2e: Anthropic adapter", () => {
  const adapter = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });

  test(
    "complete returns non-empty response",
    async () => {
      const request: ModelRequest = {
        ...makeRequest(),
        model: "claude-haiku-3-5-20241022",
      };
      const response = await adapter.complete(request);

      expect(typeof response.content).toBe("string");
      expect(response.content.length).toBeGreaterThan(0);
      expect(typeof response.model).toBe("string");
      expect(response.usage).toBeDefined();
      expect(response.usage?.inputTokens).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  test(
    "stream yields text_delta and finish chunks",
    async () => {
      const request: ModelRequest = {
        ...makeRequest(),
        model: "claude-haiku-3-5-20241022",
      };
      const result = await collectStream(adapter, request);

      expect(result.textDeltas.length).toBeGreaterThan(0);
      expect(result.hasFinish).toBe(true);
      expect(result.errors).toHaveLength(0);
    },
    TIMEOUT_MS,
  );
});

describe.skipIf(!HAS_OPENROUTER)("e2e: OpenRouter adapter", () => {
  const adapter = createOpenRouterAdapter({
    apiKey: OPENROUTER_KEY,
    appName: "koi-e2e-test",
  });

  test(
    "complete returns non-empty response (OpenAI model via OpenRouter)",
    async () => {
      const request: ModelRequest = {
        ...makeRequest(),
        model: "openai/gpt-4o-mini",
      };
      const response = await adapter.complete(request);

      expect(typeof response.content).toBe("string");
      expect(response.content.length).toBeGreaterThan(0);
      expect(typeof response.model).toBe("string");
    },
    TIMEOUT_MS,
  );

  test(
    "stream yields text_delta and finish chunks",
    async () => {
      const request: ModelRequest = {
        ...makeRequest(),
        model: "openai/gpt-4o-mini",
      };
      const result = await collectStream(adapter, request);

      expect(result.textDeltas.length).toBeGreaterThan(0);
      expect(result.hasFinish).toBe(true);
      expect(result.errors).toHaveLength(0);
    },
    TIMEOUT_MS,
  );

  test(
    "cross-provider: Anthropic model via OpenRouter",
    async () => {
      const request: ModelRequest = {
        ...makeRequest(),
        model: "anthropic/claude-haiku-3-5-20241022",
      };
      const response = await adapter.complete(request);

      expect(typeof response.content).toBe("string");
      expect(response.content.length).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Block 2: Full router pipeline (needs all 3 keys)
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_ALL)("e2e: router pipeline", () => {
  test(
    "primary target succeeds on first try",
    async () => {
      const configResult = validateRouterConfig({
        targets: [
          {
            provider: "openai",
            model: "gpt-4o-mini",
            adapterConfig: { apiKey: OPENAI_KEY },
          },
          {
            provider: "anthropic",
            model: "claude-haiku-3-5-20241022",
            adapterConfig: { apiKey: ANTHROPIC_KEY },
          },
        ],
        strategy: "fallback",
        retry: { maxRetries: 0 },
      });

      expect(configResult.ok).toBe(true);
      if (!configResult.ok) throw new Error("Config validation failed");

      const adapters = new Map<string, ProviderAdapter>([
        ["openai", createOpenAIAdapter({ apiKey: OPENAI_KEY })],
        ["anthropic", createAnthropicAdapter({ apiKey: ANTHROPIC_KEY })],
      ]);

      const router = createModelRouter(configResult.value, adapters);
      const result = await router.route(makeRequest());

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Route failed");
      expect(result.value.content.length).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  test(
    "fallback: bad primary key triggers fallback to secondary",
    async () => {
      const configResult = validateRouterConfig({
        targets: [
          {
            provider: "openai",
            model: "gpt-4o-mini",
            adapterConfig: { apiKey: "sk-invalid-key-for-e2e-test" },
          },
          {
            provider: "anthropic",
            model: "claude-haiku-3-5-20241022",
            adapterConfig: { apiKey: ANTHROPIC_KEY },
          },
        ],
        strategy: "fallback",
        retry: { maxRetries: 0 },
      });

      expect(configResult.ok).toBe(true);
      if (!configResult.ok) throw new Error("Config validation failed");

      const adapters = new Map<string, ProviderAdapter>([
        ["openai", createOpenAIAdapter({ apiKey: "sk-invalid-key-for-e2e-test" })],
        ["anthropic", createAnthropicAdapter({ apiKey: ANTHROPIC_KEY })],
      ]);

      const router = createModelRouter(configResult.value, adapters);
      const result = await router.route(makeRequest());

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Fallback failed");
      expect(result.value.content.length).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  test(
    "streaming through routeStream with real provider",
    async () => {
      const configResult = validateRouterConfig({
        targets: [
          {
            provider: "openrouter",
            model: "openai/gpt-4o-mini",
            adapterConfig: { apiKey: OPENROUTER_KEY },
          },
        ],
        strategy: "fallback",
      });

      expect(configResult.ok).toBe(true);
      if (!configResult.ok) throw new Error("Config validation failed");

      const adapters = new Map<string, ProviderAdapter>([
        [
          "openrouter",
          createOpenRouterAdapter({ apiKey: OPENROUTER_KEY, appName: "koi-e2e-test" }),
        ],
      ]);

      const router = createModelRouter(configResult.value, adapters);

      const chunks: StreamChunk[] = [];
      for await (const chunk of router.routeStream(makeRequest())) {
        chunks.push(chunk);
      }

      const textDeltas = chunks.filter((c) => c.kind === "text_delta");
      const finishChunks = chunks.filter((c) => c.kind === "finish");
      const errorChunks = chunks.filter((c) => c.kind === "error");

      expect(textDeltas.length).toBeGreaterThan(0);
      expect(finishChunks.length).toBeGreaterThan(0);
      expect(errorChunks).toHaveLength(0);
    },
    TIMEOUT_MS,
  );
});
