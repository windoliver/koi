import { describe, expect, it } from "bun:test";
import { createLatencySampler, recordLatency } from "@koi/validation";
import { computeMergedFitness, shouldFlush } from "./fitness-flush.js";
import type { FlushDeltas, ToolFlushState } from "./types.js";

const cleanState = (): ToolFlushState => ({
  dirty: false,
  flushing: false,
  invocationsSinceFlush: 0,
  errorRateSinceFlush: 0,
  lastFlushedErrorRate: 0,
});

describe("shouldFlush", () => {
  it("returns false when not dirty", () => {
    const state: ToolFlushState = { ...cleanState(), dirty: false, invocationsSinceFlush: 100 };
    expect(shouldFlush(state, 10, 0.05)).toBe(false);
  });

  it("returns false when already flushing", () => {
    const state: ToolFlushState = {
      ...cleanState(),
      dirty: true,
      flushing: true,
      invocationsSinceFlush: 100,
    };
    expect(shouldFlush(state, 10, 0.05)).toBe(false);
  });

  it("returns true when dirty and invocations >= threshold", () => {
    const state: ToolFlushState = { ...cleanState(), dirty: true, invocationsSinceFlush: 10 };
    expect(shouldFlush(state, 10, 0.05)).toBe(true);
  });

  it("returns true when dirty and error rate delta exceeds threshold", () => {
    const state: ToolFlushState = {
      ...cleanState(),
      dirty: true,
      invocationsSinceFlush: 2,
      errorRateSinceFlush: 0.4,
      lastFlushedErrorRate: 0.1,
    };
    expect(shouldFlush(state, 10, 0.05)).toBe(true);
  });

  it("returns false when dirty but below both thresholds", () => {
    const state: ToolFlushState = {
      ...cleanState(),
      dirty: true,
      invocationsSinceFlush: 3,
      errorRateSinceFlush: 0.12,
      lastFlushedErrorRate: 0.1,
    };
    expect(shouldFlush(state, 10, 0.05)).toBe(false);
  });
});

describe("computeMergedFitness", () => {
  it("creates new metrics from deltas when existing is undefined", () => {
    const sampler = recordLatency(createLatencySampler(), 100);
    const deltas: FlushDeltas = {
      successCount: 5,
      errorCount: 2,
      latencySampler: sampler,
      lastUsedAt: 1000,
    };
    const result = computeMergedFitness(deltas, undefined);
    expect(result.successCount).toBe(5);
    expect(result.errorCount).toBe(2);
    expect(result.lastUsedAt).toBe(1000);
  });

  it("adds deltas to existing counts", () => {
    const sampler = createLatencySampler();
    const existing = { successCount: 10, errorCount: 3, latency: sampler, lastUsedAt: 500 };
    const deltas: FlushDeltas = {
      successCount: 2,
      errorCount: 1,
      latencySampler: sampler,
      lastUsedAt: 1000,
    };
    const result = computeMergedFitness(deltas, existing);
    expect(result.successCount).toBe(12);
    expect(result.errorCount).toBe(4);
  });

  it("takes max of lastUsedAt", () => {
    const sampler = createLatencySampler();
    const existing = { successCount: 1, errorCount: 0, latency: sampler, lastUsedAt: 2000 };
    const deltas: FlushDeltas = {
      successCount: 1,
      errorCount: 0,
      latencySampler: sampler,
      lastUsedAt: 1000,
    };
    const result = computeMergedFitness(deltas, existing);
    expect(result.lastUsedAt).toBe(2000);
  });
});
