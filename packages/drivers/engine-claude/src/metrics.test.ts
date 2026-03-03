import { describe, expect, test } from "bun:test";
import type { SdkResultFields } from "./metrics.js";
import { mapMetrics, mapRichMetadata } from "./metrics.js";

describe("mapMetrics", () => {
  test("maps core fields correctly without cache tokens", () => {
    const result: SdkResultFields = {
      num_turns: 3,
      duration_ms: 5000,
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
      },
    };

    const metrics = mapMetrics(result);

    expect(metrics.inputTokens).toBe(1000);
    expect(metrics.outputTokens).toBe(500);
    expect(metrics.totalTokens).toBe(1500);
    expect(metrics.turns).toBe(3);
    expect(metrics.durationMs).toBe(5000);
  });

  test("includes cache_read and cache_creation in inputTokens", () => {
    const result: SdkResultFields = {
      num_turns: 2,
      duration_ms: 3000,
      usage: {
        input_tokens: 50,
        output_tokens: 200,
        cache_read_input_tokens: 10000,
        cache_creation_input_tokens: 500,
      },
    };

    const metrics = mapMetrics(result);

    // inputTokens = uncached(50) + cache_read(10000) + cache_creation(500)
    expect(metrics.inputTokens).toBe(10550);
    expect(metrics.outputTokens).toBe(200);
    expect(metrics.totalTokens).toBe(10750);
  });

  test("handles cache_read only (no cache_creation)", () => {
    const result: SdkResultFields = {
      num_turns: 1,
      duration_ms: 1000,
      usage: {
        input_tokens: 20,
        output_tokens: 100,
        cache_read_input_tokens: 30000,
      },
    };

    const metrics = mapMetrics(result);

    expect(metrics.inputTokens).toBe(30020);
    expect(metrics.totalTokens).toBe(30120);
  });

  test("handles missing optional fields with defaults", () => {
    const result: SdkResultFields = {};

    const metrics = mapMetrics(result);

    expect(metrics.inputTokens).toBe(0);
    expect(metrics.outputTokens).toBe(0);
    expect(metrics.totalTokens).toBe(0);
    expect(metrics.turns).toBe(0);
    expect(metrics.durationMs).toBe(0);
  });

  test("handles partial usage with missing fields", () => {
    const result: SdkResultFields = {
      num_turns: 1,
      usage: {
        input_tokens: 100,
      },
    };

    const metrics = mapMetrics(result);

    expect(metrics.inputTokens).toBe(100);
    expect(metrics.outputTokens).toBe(0);
    expect(metrics.totalTokens).toBe(100);
  });
});

describe("mapRichMetadata", () => {
  test("includes cost, cache, and model usage", () => {
    const result: SdkResultFields = {
      total_cost_usd: 0.05,
      duration_api_ms: 3000,
      modelUsage: { "claude-sonnet-4-5-20250929": { input_tokens: 500 } },
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 100,
      },
    };

    const metadata = mapRichMetadata(result);

    expect(metadata.totalCostUsd).toBe(0.05);
    expect(metadata.apiDurationMs).toBe(3000);
    expect(metadata.modelUsage).toEqual({ "claude-sonnet-4-5-20250929": { input_tokens: 500 } });
    expect(metadata.cacheReadTokens).toBe(200);
    expect(metadata.cacheCreationTokens).toBe(100);
  });

  test("omits undefined fields", () => {
    const result: SdkResultFields = {};

    const metadata = mapRichMetadata(result);

    expect(Object.keys(metadata)).toHaveLength(0);
  });

  test("includes only populated fields", () => {
    const result: SdkResultFields = {
      total_cost_usd: 0.01,
    };

    const metadata = mapRichMetadata(result);

    expect(metadata.totalCostUsd).toBe(0.01);
    expect(metadata.apiDurationMs).toBeUndefined();
    expect(metadata.modelUsage).toBeUndefined();
  });

  test("includes errors array when present", () => {
    const result: SdkResultFields = {
      errors: ["Runtime error occurred", "Second error"],
    };

    const metadata = mapRichMetadata(result);

    expect(metadata.errors).toEqual(["Runtime error occurred", "Second error"]);
  });

  test("includes permission_denials when present", () => {
    const result: SdkResultFields = {
      permission_denials: [
        { tool_name: "bash", tool_use_id: "call-1" },
        { tool_name: "write", tool_use_id: "call-2" },
      ],
    };

    const metadata = mapRichMetadata(result);

    expect(metadata.permissionDenials).toEqual([
      { tool_name: "bash", tool_use_id: "call-1" },
      { tool_name: "write", tool_use_id: "call-2" },
    ]);
  });

  test("omits errors when empty array", () => {
    const result: SdkResultFields = {
      errors: [],
    };

    const metadata = mapRichMetadata(result);

    expect(metadata.errors).toBeUndefined();
  });

  test("omits permission_denials when empty array", () => {
    const result: SdkResultFields = {
      permission_denials: [],
    };

    const metadata = mapRichMetadata(result);

    expect(metadata.permissionDenials).toBeUndefined();
  });
});
