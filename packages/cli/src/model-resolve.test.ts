/**
 * Tests for model-resolve — shared model resolution logic.
 *
 * Uses dependency injection (factoryOverrides) instead of mock.module()
 * to avoid global mock bleeding across test files during parallel runs.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AgentManifest } from "@koi/core";
import type { AdapterFactory } from "./model-resolve.js";
import { parseModelName, resolveModelCall } from "./model-resolve.js";

// ---------------------------------------------------------------------------
// Mock adapter (injected via DI, not mock.module)
// ---------------------------------------------------------------------------

const mockComplete = mock(async () => ({
  content: "[mock] response",
  model: "mock-model",
  usage: { inputTokens: 10, outputTokens: 10 },
}));

const mockAdapter = {
  id: "mock",
  complete: mockComplete,
  stream: async function* () {},
};

const mockFactories: Readonly<Record<string, AdapterFactory>> = {
  anthropic: () => mockAdapter,
  openai: () => mockAdapter,
  openrouter: () => mockAdapter,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(modelName: string): AgentManifest {
  return {
    name: "test-agent",
    version: "0.1.0",
    model: { name: modelName },
  };
}

const envBackup: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in envBackup)) {
    envBackup[key] = process.env[key];
  }
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

afterEach(() => {
  // Restore env
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  // Clear backup
  for (const key of Object.keys(envBackup)) {
    delete envBackup[key];
  }
  mockComplete.mockClear();
});

// ---------------------------------------------------------------------------
// parseModelName
// ---------------------------------------------------------------------------

describe("parseModelName", () => {
  test("parses anthropic:claude-sonnet-4-5-20250929", () => {
    const result = parseModelName("anthropic:claude-sonnet-4-5-20250929");
    expect(result).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5-20250929" });
  });

  test("parses openai:gpt-4o", () => {
    const result = parseModelName("openai:gpt-4o");
    expect(result).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  test("parses openrouter:anthropic/claude-3.5-sonnet", () => {
    const result = parseModelName("openrouter:anthropic/claude-3.5-sonnet");
    expect(result).toEqual({ provider: "openrouter", model: "anthropic/claude-3.5-sonnet" });
  });

  test("throws on missing colon", () => {
    expect(() => parseModelName("claude-sonnet")).toThrow(/Expected format "provider:model"/);
  });

  test("throws on empty provider", () => {
    expect(() => parseModelName(":gpt-4o")).toThrow(/Both provider and model must be non-empty/);
  });

  test("throws on empty model", () => {
    expect(() => parseModelName("openai:")).toThrow(/Both provider and model must be non-empty/);
  });
});

// ---------------------------------------------------------------------------
// resolveModelCall
// ---------------------------------------------------------------------------

describe("resolveModelCall", () => {
  test("throws on unknown provider", () => {
    setEnv("FAKE_API_KEY", "sk-test");
    expect(() => resolveModelCall(makeManifest("fake:some-model"), mockFactories)).toThrow(
      /Unknown model provider "fake".*Supported providers/,
    );
  });

  test("throws when API key is missing", () => {
    setEnv("ANTHROPIC_API_KEY", undefined);
    expect(() =>
      resolveModelCall(makeManifest("anthropic:claude-sonnet-4-5-20250929"), mockFactories),
    ).toThrow(/Missing API key.*ANTHROPIC_API_KEY/);
  });

  test("throws when API key is empty string", () => {
    setEnv("OPENAI_API_KEY", "");
    expect(() => resolveModelCall(makeManifest("openai:gpt-4o"), mockFactories)).toThrow(
      /Missing API key.*OPENAI_API_KEY/,
    );
  });

  test("returns a ModelHandler when API key is set", () => {
    setEnv("ANTHROPIC_API_KEY", "sk-test-key");
    const handler = resolveModelCall(
      makeManifest("anthropic:claude-sonnet-4-5-20250929"),
      mockFactories,
    );
    expect(typeof handler).toBe("function");
  });

  test("returned ModelHandler calls adapter.complete with correct model", async () => {
    setEnv("OPENAI_API_KEY", "sk-test-key");
    const handler = resolveModelCall(makeManifest("openai:gpt-4o"), mockFactories);

    const request = {
      messages: [
        {
          content: [{ kind: "text" as const, text: "hello" }],
          senderId: "test-user",
          timestamp: Date.now(),
        },
      ],
    };

    const response = await handler(request);
    expect(response.content).toBe("[mock] response");
    expect(mockComplete).toHaveBeenCalledTimes(1);

    // Verify the model name was injected into the request
    const calledWith = mockComplete.mock.calls[0] as unknown[];
    expect(calledWith[0]).toMatchObject({ model: "gpt-4o" });
  });
});
