import { describe, expect, test } from "bun:test";

import type { SessionId } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import type { ModelHandler } from "@koi/core/middleware";
import { HEURISTIC_ESTIMATOR } from "@koi/token-estimator";
import { resolveContextArenaConfig } from "./config-resolution.js";
import type { ContextArenaConfig } from "./types.js";

/** Minimal stub for a ModelHandler — never called in config resolution. */
const stubSummarizer: ModelHandler = () => {
  throw new Error("stub");
};

function baseConfig(overrides?: Partial<ContextArenaConfig>): ContextArenaConfig {
  return {
    summarizer: stubSummarizer,
    sessionId: "test-session" as SessionId,
    getMessages: (): readonly InboundMessage[] => [],
    ...overrides,
  };
}

describe("resolveContextArenaConfig", () => {
  test("defaults to balanced preset", () => {
    const resolved = resolveContextArenaConfig(baseConfig());
    expect(resolved.preset).toBe("balanced");
  });

  test("defaults to 200K context window", () => {
    const resolved = resolveContextArenaConfig(baseConfig());
    expect(resolved.contextWindowSize).toBe(200_000);
  });

  test("uses HEURISTIC_ESTIMATOR when no estimator provided", () => {
    const resolved = resolveContextArenaConfig(baseConfig());
    expect(resolved.tokenEstimator).toBe(HEURISTIC_ESTIMATOR);
  });

  test("creates default in-memory archiver when not provided", () => {
    const resolved = resolveContextArenaConfig(baseConfig());
    // Verify archiver is a SnapshotChainStore by checking it has the expected methods
    expect(typeof resolved.archiver.put).toBe("function");
    expect(typeof resolved.archiver.get).toBe("function");
    expect(typeof resolved.archiver.head).toBe("function");
  });

  test("user overrides take precedence over preset", () => {
    const resolved = resolveContextArenaConfig(
      baseConfig({
        compactor: { trigger: { tokenFraction: 0.8 }, preserveRecent: 10 },
        contextEditing: { triggerTokenCount: 50_000, numRecentToKeep: 7 },
        squash: { preserveRecent: 8, maxPendingSquashes: 5 },
      }),
    );

    expect(resolved.compactorTriggerFraction).toBe(0.8);
    expect(resolved.compactorPreserveRecent).toBe(10);
    expect(resolved.editingTriggerTokenCount).toBe(50_000);
    expect(resolved.editingNumRecentToKeep).toBe(7);
    expect(resolved.squashPreserveRecent).toBe(8);
    expect(resolved.squashMaxPendingSquashes).toBe(5);
  });

  test("throws on non-positive contextWindowSize", () => {
    expect(() => resolveContextArenaConfig(baseConfig({ contextWindowSize: 0 }))).toThrow(
      "contextWindowSize must be a finite positive number",
    );
    expect(() => resolveContextArenaConfig(baseConfig({ contextWindowSize: -1 }))).toThrow(
      "contextWindowSize must be a finite positive number",
    );
  });

  test("throws on NaN contextWindowSize", () => {
    expect(() => resolveContextArenaConfig(baseConfig({ contextWindowSize: Number.NaN }))).toThrow(
      "contextWindowSize must be a finite positive number",
    );
  });

  test("throws on Infinity contextWindowSize", () => {
    expect(() =>
      resolveContextArenaConfig(baseConfig({ contextWindowSize: Number.POSITIVE_INFINITY })),
    ).toThrow("contextWindowSize must be a finite positive number");
  });

  test("hydratorEnabled and memoryFsEnabled flags derived correctly", () => {
    const withoutOpts = resolveContextArenaConfig(baseConfig());
    expect(withoutOpts.hydratorEnabled).toBe(false);
    expect(withoutOpts.memoryFsEnabled).toBe(false);

    const withOpts = resolveContextArenaConfig(
      baseConfig({
        hydrator: { config: { sources: [] } },
        memoryFs: { config: { baseDir: "/tmp/test-memory" } },
      }),
    );
    expect(withOpts.hydratorEnabled).toBe(true);
    expect(withOpts.memoryFsEnabled).toBe(true);
  });
});
