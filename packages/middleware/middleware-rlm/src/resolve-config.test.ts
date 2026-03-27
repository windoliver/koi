import { describe, expect, test } from "bun:test";
import type { CostEstimator } from "./cost-tracker.js";
import { resolveConfig } from "./resolve-config.js";
import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_COMPACTION_THRESHOLD,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_DEPTH,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_PREVIEW_LENGTH,
  DEFAULT_TIME_BUDGET_MS,
} from "./types.js";

describe("resolveConfig", () => {
  test("empty config gets all defaults", () => {
    const resolved = resolveConfig({});
    expect(resolved.maxIterations).toBe(DEFAULT_MAX_ITERATIONS);
    expect(resolved.maxInputBytes).toBe(DEFAULT_MAX_INPUT_BYTES);
    expect(resolved.chunkSize).toBe(DEFAULT_CHUNK_SIZE);
    expect(resolved.previewLength).toBe(DEFAULT_PREVIEW_LENGTH);
    expect(resolved.compactionThreshold).toBe(DEFAULT_COMPACTION_THRESHOLD);
    expect(resolved.contextWindowTokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(resolved.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
    expect(resolved.depth).toBe(DEFAULT_DEPTH);
    expect(resolved.maxDepth).toBe(DEFAULT_MAX_DEPTH);
    expect(resolved.timeBudgetMs).toBe(DEFAULT_TIME_BUDGET_MS);
    expect(resolved.rootModel).toBeUndefined();
    expect(resolved.subCallModel).toBeUndefined();
    expect(resolved.spawnRlmChild).toBeUndefined();
    expect(resolved.onEvent).toBeUndefined();
    expect(resolved.scriptRunner).toBeUndefined();
    expect(resolved.maxCostUsd).toBeUndefined();
    expect(resolved.costEstimator).toBeUndefined();
    expect(resolved.parentContext).toBeUndefined();
  });

  test("explicit values override defaults", () => {
    const resolved = resolveConfig({
      maxIterations: 50,
      chunkSize: 8000,
      contextWindowTokens: 200_000,
      maxConcurrency: 10,
      depth: 2,
      maxDepth: 5,
    });
    expect(resolved.maxIterations).toBe(50);
    expect(resolved.chunkSize).toBe(8000);
    expect(resolved.contextWindowTokens).toBe(200_000);
    expect(resolved.maxConcurrency).toBe(10);
    expect(resolved.depth).toBe(2);
    expect(resolved.maxDepth).toBe(5);
    // Non-overridden fields still get defaults
    expect(resolved.maxInputBytes).toBe(DEFAULT_MAX_INPUT_BYTES);
    expect(resolved.previewLength).toBe(DEFAULT_PREVIEW_LENGTH);
    expect(resolved.compactionThreshold).toBe(DEFAULT_COMPACTION_THRESHOLD);
  });

  test("maxDepth defaults to 3", () => {
    const resolved = resolveConfig({});
    expect(resolved.maxDepth).toBe(3);
  });

  test("maxCostUsd is undefined by default", () => {
    const resolved = resolveConfig({});
    expect(resolved.maxCostUsd).toBeUndefined();
  });

  test("costEstimator is undefined by default", () => {
    const resolved = resolveConfig({});
    expect(resolved.costEstimator).toBeUndefined();
  });

  test("parentContext is undefined by default", () => {
    const resolved = resolveConfig({});
    expect(resolved.parentContext).toBeUndefined();
  });

  test("maxCostUsd passed through when set", () => {
    const resolved = resolveConfig({ maxCostUsd: 5.0 });
    expect(resolved.maxCostUsd).toBe(5.0);
  });

  test("costEstimator passed through when set", () => {
    const estimator: CostEstimator = () => 0.01;
    const resolved = resolveConfig({ costEstimator: estimator });
    expect(resolved.costEstimator).toBe(estimator);
  });

  test("parentContext passed through when set", () => {
    const resolved = resolveConfig({ parentContext: "parent summary" });
    expect(resolved.parentContext).toBe("parent summary");
  });

  test("partial config fills only missing defaults", () => {
    const resolved = resolveConfig({
      maxIterations: 15,
      rootModel: "claude-3",
    });
    expect(resolved.maxIterations).toBe(15);
    expect(resolved.rootModel).toBe("claude-3");
    // Everything else is default
    expect(resolved.maxInputBytes).toBe(DEFAULT_MAX_INPUT_BYTES);
    expect(resolved.chunkSize).toBe(DEFAULT_CHUNK_SIZE);
    expect(resolved.previewLength).toBe(DEFAULT_PREVIEW_LENGTH);
    expect(resolved.compactionThreshold).toBe(DEFAULT_COMPACTION_THRESHOLD);
    expect(resolved.contextWindowTokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(resolved.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
    expect(resolved.depth).toBe(DEFAULT_DEPTH);
    expect(resolved.maxDepth).toBe(DEFAULT_MAX_DEPTH);
    expect(resolved.timeBudgetMs).toBe(DEFAULT_TIME_BUDGET_MS);
  });
});
