import { describe, expect, test } from "bun:test";

import type { ThreadStore } from "@koi/core";
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

  test("personalizationEnabled defaults to false", () => {
    const resolved = resolveContextArenaConfig(baseConfig());
    expect(resolved.personalizationEnabled).toBe(false);
  });

  test("personalizationEnabled true when personalization.enabled is true", () => {
    const resolved = resolveContextArenaConfig(baseConfig({ personalization: { enabled: true } }));
    expect(resolved.personalizationEnabled).toBe(true);
  });

  test("personalization defaults resolve correctly", () => {
    const resolved = resolveContextArenaConfig(baseConfig());
    expect(resolved.personalizationRelevanceThreshold).toBe(0.7);
    expect(resolved.personalizationMaxPreferenceTokens).toBe(500);
  });

  test("personalization overrides apply", () => {
    const resolved = resolveContextArenaConfig(
      baseConfig({
        personalization: {
          enabled: true,
          relevanceThreshold: 0.5,
          maxPreferenceTokens: 200,
        },
      }),
    );
    expect(resolved.personalizationRelevanceThreshold).toBe(0.5);
    expect(resolved.personalizationMaxPreferenceTokens).toBe(200);
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

  test("conventions strings mapped to CapabilityFragment[]", () => {
    const resolved = resolveContextArenaConfig(
      baseConfig({ conventions: ["ESM-only", "No mutation"] }),
    );
    expect(resolved.conventions).toHaveLength(2);
    expect(resolved.conventions[0]?.label).toBe("convention");
    expect(resolved.conventions[0]?.description).toBe("ESM-only");
    expect(resolved.conventions[1]?.description).toBe("No mutation");
  });

  test("empty conventions produces empty array", () => {
    const resolved = resolveContextArenaConfig(baseConfig({ conventions: [] }));
    expect(resolved.conventions).toHaveLength(0);
  });

  test("undefined conventions produces empty array", () => {
    const resolved = resolveContextArenaConfig(baseConfig());
    expect(resolved.conventions).toHaveLength(0);
  });

  test("hotMemoryEnabled is true when memoryFs present and not disabled", () => {
    const resolved = resolveContextArenaConfig(
      baseConfig({ memoryFs: { config: { baseDir: "/tmp/test" } } }),
    );
    expect(resolved.hotMemoryEnabled).toBe(true);
  });

  test("hotMemoryEnabled is false when memoryFs absent", () => {
    const resolved = resolveContextArenaConfig(baseConfig());
    expect(resolved.hotMemoryEnabled).toBe(false);
  });

  test("hotMemoryEnabled is false when explicitly disabled", () => {
    const resolved = resolveContextArenaConfig(
      baseConfig({
        memoryFs: { config: { baseDir: "/tmp/test" } },
        hotMemory: { disabled: true },
      }),
    );
    expect(resolved.hotMemoryEnabled).toBe(false);
  });

  test("hotMemory overrides take precedence over preset", () => {
    const resolved = resolveContextArenaConfig(
      baseConfig({
        memoryFs: { config: { baseDir: "/tmp/test" } },
        hotMemory: { maxTokens: 8000, refreshInterval: 2 },
      }),
    );
    expect(resolved.hotMemoryMaxTokens).toBe(8000);
    expect(resolved.hotMemoryRefreshInterval).toBe(2);
  });

  // --- Conversation ---

  test("conversationEnabled is false by default (no threadStore)", () => {
    const resolved = resolveContextArenaConfig(baseConfig());
    expect(resolved.conversationEnabled).toBe(false);
  });

  test("conversationEnabled is true when threadStore provided", () => {
    const resolved = resolveContextArenaConfig(baseConfig({ threadStore: stubThreadStore() }));
    expect(resolved.conversationEnabled).toBe(true);
  });

  test("conversationEnabled is false when disabled even with threadStore", () => {
    const resolved = resolveContextArenaConfig(
      baseConfig({
        threadStore: stubThreadStore(),
        conversation: { disabled: true },
      }),
    );
    expect(resolved.conversationEnabled).toBe(false);
  });

  test("conversation token budget uses preset when no override", () => {
    const resolved = resolveContextArenaConfig(baseConfig({ threadStore: stubThreadStore() }));
    // balanced preset at 200K: 200_000 * 0.03 = 6_000
    expect(resolved.conversationMaxHistoryTokens).toBe(6_000);
  });

  test("conversation user overrides take precedence", () => {
    const resolved = resolveContextArenaConfig(
      baseConfig({
        threadStore: stubThreadStore(),
        conversation: { maxHistoryTokens: 10_000, maxMessages: 50 },
      }),
    );
    expect(resolved.conversationMaxHistoryTokens).toBe(10_000);
    expect(resolved.conversationMaxMessages).toBe(50);
  });

  test("conversationMaxMessages defaults to 200", () => {
    const resolved = resolveContextArenaConfig(baseConfig({ threadStore: stubThreadStore() }));
    expect(resolved.conversationMaxMessages).toBe(200);
  });
});

/** Minimal stub ThreadStore — never called during config resolution. */
function stubThreadStore(): ThreadStore {
  return {
    appendAndCheckpoint: () => {
      throw new Error("stub");
    },
    loadThread: () => {
      throw new Error("stub");
    },
    listMessages: () => {
      throw new Error("stub");
    },
    close: () => {},
  };
}
