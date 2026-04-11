import { describe, expect, test } from "bun:test";
import { resolveApiConfig } from "./env.js";

describe("resolveApiConfig", () => {
  test("returns error when no key is set", () => {
    const result = resolveApiConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("no API key");
    }
  });

  test("returns error when keys are empty strings", () => {
    const result = resolveApiConfig({ OPENROUTER_API_KEY: "", OPENAI_API_KEY: "" });
    expect(result.ok).toBe(false);
  });

  test("OPENROUTER_API_KEY → uses it, no base URL, default model", () => {
    const result = resolveApiConfig({ OPENROUTER_API_KEY: "sk-or-test" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.apiKey).toBe("sk-or-test");
      expect(result.value.baseUrl).toBeUndefined();
      expect(result.value.model).toBe("anthropic/claude-sonnet-4-6");
    }
  });

  test("OPENAI_API_KEY only → uses it, injects OpenAI base URL", () => {
    const result = resolveApiConfig({ OPENAI_API_KEY: "sk-oai-test" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.apiKey).toBe("sk-oai-test");
      expect(result.value.baseUrl).toBe("https://api.openai.com/v1");
    }
  });

  test("both keys present → OPENROUTER_API_KEY wins, no base URL", () => {
    const result = resolveApiConfig({
      OPENROUTER_API_KEY: "sk-or-test",
      OPENAI_API_KEY: "sk-oai-test",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.apiKey).toBe("sk-or-test");
      expect(result.value.baseUrl).toBeUndefined();
    }
  });

  test("KOI_MODEL → overrides default model", () => {
    const result = resolveApiConfig({
      OPENROUTER_API_KEY: "sk-or-test",
      KOI_MODEL: "anthropic/claude-3-5-sonnet",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.model).toBe("anthropic/claude-3-5-sonnet");
    }
  });

  test("KOI_MODEL whitespace → falls back to default", () => {
    const result = resolveApiConfig({
      OPENROUTER_API_KEY: "sk-or-test",
      KOI_MODEL: "   ",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.model).toBe("anthropic/claude-sonnet-4-6");
    }
  });

  test("OPENAI_BASE_URL → overrides base URL for OpenRouter key", () => {
    const result = resolveApiConfig({
      OPENROUTER_API_KEY: "sk-or-test",
      OPENAI_BASE_URL: "https://my-proxy.example.com/v1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.baseUrl).toBe("https://my-proxy.example.com/v1");
    }
  });

  test("OPENROUTER_BASE_URL → overrides base URL", () => {
    const result = resolveApiConfig({
      OPENROUTER_API_KEY: "sk-or-test",
      OPENROUTER_BASE_URL: "https://custom-router.example.com/v1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.baseUrl).toBe("https://custom-router.example.com/v1");
    }
  });

  test("KOI_FALLBACK_MODEL unset → empty fallbackModels", () => {
    const result = resolveApiConfig({ OPENROUTER_API_KEY: "sk-or-test" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fallbackModels).toEqual([]);
    }
  });

  test("KOI_FALLBACK_MODEL single → one fallback", () => {
    const result = resolveApiConfig({
      OPENROUTER_API_KEY: "sk-or-test",
      KOI_FALLBACK_MODEL: "google/gemini-2.0-flash-001",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fallbackModels).toEqual(["google/gemini-2.0-flash-001"]);
    }
  });

  test("KOI_FALLBACK_MODEL comma-separated → ordered fallback list", () => {
    const result = resolveApiConfig({
      OPENROUTER_API_KEY: "sk-or-test",
      KOI_FALLBACK_MODEL: "google/gemini-2.0-flash-001 , meta/llama-3-70b",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fallbackModels).toEqual([
        "google/gemini-2.0-flash-001",
        "meta/llama-3-70b",
      ]);
    }
  });

  test("KOI_FALLBACK_MODEL whitespace-only → empty fallbackModels", () => {
    const result = resolveApiConfig({
      OPENROUTER_API_KEY: "sk-or-test",
      KOI_FALLBACK_MODEL: "   ",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fallbackModels).toEqual([]);
    }
  });

  test("OPENAI_BASE_URL takes precedence over OPENROUTER_BASE_URL", () => {
    const result = resolveApiConfig({
      OPENROUTER_API_KEY: "sk-or-test",
      OPENAI_BASE_URL: "https://openai-proxy.example.com",
      OPENROUTER_BASE_URL: "https://or-proxy.example.com",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.baseUrl).toBe("https://openai-proxy.example.com");
    }
  });
});
