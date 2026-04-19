import { describe, expect, mock, test } from "bun:test";
import { fetchAvailableModels } from "./model-list-fetch.js";

describe("fetchAvailableModels", () => {
  test("parses OpenRouter {data: [{id, context_length, pricing}]} shape", async () => {
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "anthropic/claude-opus-4-7",
                context_length: 200000,
                pricing: { prompt: "0.000015", completion: "0.000075" },
              },
              { id: "openai/gpt-5" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await fetchAvailableModels({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.models).toHaveLength(2);
    expect(result.models[0]).toEqual({
      id: "anthropic/claude-opus-4-7",
      contextLength: 200000,
      pricingIn: 0.000015,
      pricingOut: 0.000075,
    });
    expect(result.models[1]).toEqual({ id: "openai/gpt-5" });
  });

  test("returns error on non-2xx", async () => {
    const fetchMock = mock(async () => new Response("nope", { status: 401 }));
    const result = await fetchAvailableModels({
      provider: "openrouter",
      apiKey: "sk-bad",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, error: "HTTP 401: " });
  });

  test("returns error on abort/timeout", async () => {
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const result = await fetchAvailableModels({
      provider: "openrouter",
      apiKey: "sk-test",
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 20,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/abort/i);
  });

  test("returns error for unknown provider without baseUrl", async () => {
    const result = await fetchAvailableModels({
      provider: "anthropic",
      apiKey: "sk-test",
    });
    expect(result).toEqual({
      ok: false,
      error: 'No /models endpoint known for provider "anthropic"',
    });
  });

  test("skips malformed entries without failing", async () => {
    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "" }, null, { id: "good/model" }] }), {
          status: 200,
        }),
    );
    const result = await fetchAvailableModels({
      provider: "openrouter",
      apiKey: "sk-test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true, models: [{ id: "good/model" }] });
  });
});
