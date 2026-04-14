import { describe, expect, test } from "bun:test";
import { parseModelsDevJson } from "./models-dev.js";

describe("parseModelsDevJson", () => {
  test("converts $/million to $/token", () => {
    const providers = [
      {
        id: "anthropic",
        models: {
          "claude-sonnet-test": {
            id: "claude-sonnet-test",
            cost: { input: 3, output: 15 },
          },
        },
      },
    ];

    const table = parseModelsDevJson(providers);
    const pricing = table["claude-sonnet-test"];
    expect(pricing).toBeDefined();
    expect(pricing?.input).toBe(3e-6);
    expect(pricing?.output).toBe(15e-6);
  });

  test("merges cache overrides for known models", () => {
    const providers = [
      {
        id: "anthropic",
        models: {
          "claude-sonnet-4-6": {
            id: "claude-sonnet-4-6",
            cost: { input: 3, output: 15 },
          },
        },
      },
    ];

    const table = parseModelsDevJson(providers);
    const pricing = table["claude-sonnet-4-6"];
    expect(pricing?.cachedInput).toBe(0.3e-6);
    expect(pricing?.cacheCreation).toBe(3.75e-6);
  });

  test("uses models.dev cache pricing when no override exists", () => {
    const providers = [
      {
        id: "custom",
        models: {
          "custom-model": {
            id: "custom-model",
            cost: { input: 1, output: 5, cache_read: 0.5, cache_write: 2 },
          },
        },
      },
    ];

    const table = parseModelsDevJson(providers);
    const pricing = table["custom-model"];
    expect(pricing?.input).toBe(1e-6);
    expect(pricing?.cachedInput).toBe(0.5e-6);
    expect(pricing?.cacheCreation).toBe(2e-6);
  });

  test("skips models with no cost data", () => {
    const providers = [
      {
        id: "test",
        models: {
          "no-cost": { id: "no-cost" },
          "zero-cost": { id: "zero-cost", cost: { input: 0, output: 0 } },
        },
      },
    ];

    const table = parseModelsDevJson(providers);
    expect(table["no-cost"]).toBeUndefined();
    expect(table["zero-cost"]).toBeUndefined();
  });

  test("skips providers with no models", () => {
    const providers = [{ id: "empty" }];
    const table = parseModelsDevJson(providers);
    expect(Object.keys(table)).toHaveLength(0);
  });

  test("first provider wins for duplicate model IDs", () => {
    const providers = [
      {
        id: "provider-a",
        models: {
          "shared-model": { id: "shared-model", cost: { input: 1, output: 5 } },
        },
      },
      {
        id: "provider-b",
        models: {
          "shared-model": { id: "shared-model", cost: { input: 10, output: 50 } },
        },
      },
    ];

    const table = parseModelsDevJson(providers);
    expect(table["shared-model"]?.input).toBe(1e-6);
  });
});
