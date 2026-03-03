import { describe, expect, test } from "bun:test";
import type { ForgeStore, KoiError, Result } from "@koi/core";
import { brickId, DEFAULT_TRAIL_CONFIG, DEFAULT_TRAIL_STRENGTH } from "@koi/core";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { createDefaultForgeConfig } from "./config.js";
import { createInMemoryForgeStore } from "./memory-store.js";
import type { ToolArtifact } from "./types.js";
import type { UsageSignal } from "./usage.js";
import { recordBrickUsage } from "./usage.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createToolBrick(overrides?: Partial<ToolArtifact>): ToolArtifact {
  return {
    id: brickId("brick_test"),
    kind: "tool",
    name: "test-brick",
    description: "A test brick",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    implementation: "return 1;",
    inputSchema: { type: "object" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// recordBrickUsage
// ---------------------------------------------------------------------------

describe("recordBrickUsage", () => {
  test("increments usageCount and returns 'recorded'", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: brickId("brick_1"), usageCount: 0 }));

    const config = createDefaultForgeConfig({
      autoPromotion: {
        enabled: true,
        sandboxToVerifiedThreshold: 5,
        verifiedToPromotedThreshold: 20,
      },
    });

    const result = await recordBrickUsage(store, "brick_1", config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("recorded");
      expect(result.value.newUsageCount).toBe(1);
    }
  });

  test("returns error when brick not found", async () => {
    const store = createInMemoryForgeStore();
    const config = createDefaultForgeConfig();

    const result = await recordBrickUsage(store, "nonexistent", config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("store");
      expect(result.error.code).toBe("LOAD_FAILED");
    }
  });

  test("returns error when store update fails", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: brickId("brick_1") }));

    // Replace update to simulate failure
    const failingStore: ForgeStore = {
      ...store,
      update: async (): Promise<Result<void, KoiError>> => ({
        ok: false,
        error: { code: "INTERNAL", message: "disk full", retryable: false },
      }),
    };

    const config = createDefaultForgeConfig({
      autoPromotion: {
        enabled: true,
        sandboxToVerifiedThreshold: 5,
        verifiedToPromotedThreshold: 20,
      },
    });

    const result = await recordBrickUsage(failingStore, "brick_1", config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("store");
      expect(result.error.code).toBe("SAVE_FAILED");
    }
  });

  test("does not promote when disabled", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createToolBrick({ id: brickId("brick_1"), usageCount: 4, trustTier: "sandbox" }),
    );

    // autoPromotion disabled by default
    const config = createDefaultForgeConfig();

    const result = await recordBrickUsage(store, "brick_1", config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("recorded");
      expect(result.value.newUsageCount).toBe(5);
    }

    // Verify trust tier unchanged
    const loaded = await store.load(brickId("brick_1"));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.trustTier).toBe("sandbox");
    }
  });
});

// ---------------------------------------------------------------------------
// recordBrickUsage with UsageSignal (fitness tracking)
// ---------------------------------------------------------------------------

describe("recordBrickUsage with UsageSignal", () => {
  const NOW = 1_700_000_000_000;

  test("records success signal and updates fitness metrics", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: brickId("brick_fit"), usageCount: 0 }));

    const config = createDefaultForgeConfig();
    const signal: UsageSignal = { success: true, latencyMs: 100, timestamp: NOW };

    const result = await recordBrickUsage(store, "brick_fit", config, signal);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("recorded");
      expect(result.value.newUsageCount).toBe(1);
    }

    const loaded = await store.load(brickId("brick_fit"));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.fitness).toBeDefined();
      expect(loaded.value.fitness?.successCount).toBe(1);
      expect(loaded.value.fitness?.errorCount).toBe(0);
      expect(loaded.value.fitness?.lastUsedAt).toBe(NOW);
      expect(loaded.value.fitness?.latency.samples).toContain(100);
    }
  });

  test("records error signal and increments errorCount", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: brickId("brick_err"), usageCount: 0 }));

    const config = createDefaultForgeConfig();
    const signal: UsageSignal = { success: false, latencyMs: 500, timestamp: NOW };

    const result = await recordBrickUsage(store, "brick_err", config, signal);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.newUsageCount).toBe(1);
    }

    const loaded = await store.load(brickId("brick_err"));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.fitness?.successCount).toBe(0);
      expect(loaded.value.fitness?.errorCount).toBe(1);
    }
  });

  test("accumulates fitness over multiple signals", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: brickId("brick_acc"), usageCount: 0 }));

    const config = createDefaultForgeConfig();

    await recordBrickUsage(store, "brick_acc", config, {
      success: true,
      latencyMs: 50,
      timestamp: NOW,
    });
    await recordBrickUsage(store, "brick_acc", config, {
      success: true,
      latencyMs: 100,
      timestamp: NOW + 1000,
    });
    await recordBrickUsage(store, "brick_acc", config, {
      success: false,
      latencyMs: 200,
      timestamp: NOW + 2000,
    });

    const loaded = await store.load(brickId("brick_acc"));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.fitness?.successCount).toBe(2);
      expect(loaded.value.fitness?.errorCount).toBe(1);
      expect(loaded.value.usageCount).toBe(3);
      expect(loaded.value.fitness?.lastUsedAt).toBe(NOW + 2000);
    }
  });

  test("derives usageCount from fitness totals", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: brickId("brick_derive"), usageCount: 0 }));

    const config = createDefaultForgeConfig();
    await recordBrickUsage(store, "brick_derive", config, {
      success: true,
      latencyMs: 10,
      timestamp: NOW,
    });
    await recordBrickUsage(store, "brick_derive", config, {
      success: false,
      latencyMs: 20,
      timestamp: NOW,
    });

    const loaded = await store.load(brickId("brick_derive"));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      // usageCount = successCount + errorCount = 1 + 1 = 2
      expect(loaded.value.usageCount).toBe(2);
      expect(loaded.value.fitness?.successCount).toBe(1);
      expect(loaded.value.fitness?.errorCount).toBe(1);
    }
  });

  test("backward-compatible: no signal means no fitness update", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: brickId("brick_compat"), usageCount: 5 }));

    const config = createDefaultForgeConfig();
    const result = await recordBrickUsage(store, "brick_compat", config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.newUsageCount).toBe(6);
    }

    const loaded = await store.load(brickId("brick_compat"));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      // No fitness field set (was undefined before, stays undefined)
      expect(loaded.value.fitness).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Trail strength integration with recordBrickUsage
// ---------------------------------------------------------------------------

describe("recordBrickUsage — trail strength", () => {
  test("updates trail strength when trail config is present", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createToolBrick({ id: brickId("brick_trail"), trailStrength: DEFAULT_TRAIL_STRENGTH }),
    );

    const config = createDefaultForgeConfig({ trail: DEFAULT_TRAIL_CONFIG });
    const result = await recordBrickUsage(store, "brick_trail", config);
    expect(result.ok).toBe(true);

    const loaded = await store.load(brickId("brick_trail"));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      // Trail strength increased from 0.5 by reinforcement (0.1) → 0.6
      expect(loaded.value.trailStrength).toBeCloseTo(0.6, 5);
    }
  });

  test("trail reinforcement respects tauMax cap", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: brickId("brick_max"), trailStrength: 0.9 }));

    const config = createDefaultForgeConfig({ trail: DEFAULT_TRAIL_CONFIG });
    const result = await recordBrickUsage(store, "brick_max", config);
    expect(result.ok).toBe(true);

    const loaded = await store.load(brickId("brick_max"));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      // 0.9 + 0.1 = 1.0 → capped at tauMax (0.95)
      expect(loaded.value.trailStrength).toBe(DEFAULT_TRAIL_CONFIG.tauMax);
    }
  });

  test("trail strength from undefined defaults to DEFAULT_TRAIL_STRENGTH + reinforcement", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: brickId("brick_undef") }));

    const config = createDefaultForgeConfig({ trail: DEFAULT_TRAIL_CONFIG });
    const result = await recordBrickUsage(store, "brick_undef", config);
    expect(result.ok).toBe(true);

    const loaded = await store.load(brickId("brick_undef"));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      // DEFAULT_TRAIL_STRENGTH (0.5) + reinforcement (0.1) = 0.6
      expect(loaded.value.trailStrength).toBeCloseTo(
        DEFAULT_TRAIL_STRENGTH + DEFAULT_TRAIL_CONFIG.reinforcement,
        5,
      );
    }
  });

  test("no trail config → no trail update (backward-compatible)", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: brickId("brick_notrail"), trailStrength: 0.5 }));

    // Explicitly omit trail config to test backward-compatible path
    const base = createDefaultForgeConfig();
    const { trail: _, ...rest } = base;
    const config = rest as typeof base;
    const result = await recordBrickUsage(store, "brick_notrail", config);
    expect(result.ok).toBe(true);

    const loaded = await store.load(brickId("brick_notrail"));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      // Trail strength unchanged
      expect(loaded.value.trailStrength).toBe(0.5);
    }
  });

  test("trail reinforcement with fitness signal", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: brickId("brick_signal"), trailStrength: 0.3 }));

    const config = createDefaultForgeConfig({ trail: DEFAULT_TRAIL_CONFIG });
    const signal: UsageSignal = { success: true, latencyMs: 50, timestamp: Date.now() };
    const result = await recordBrickUsage(store, "brick_signal", config, signal);
    expect(result.ok).toBe(true);

    const loaded = await store.load(brickId("brick_signal"));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      // Both fitness and trail strength updated
      expect(loaded.value.fitness).toBeDefined();
      expect(loaded.value.trailStrength).toBeCloseTo(0.4, 5); // 0.3 + 0.1
    }
  });

  test("repeated usage drives trail strength toward tauMax", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: brickId("brick_repeat"), trailStrength: 0.1 }));

    const config = createDefaultForgeConfig({ trail: DEFAULT_TRAIL_CONFIG });

    for (let i = 0; i < 20; i++) {
      await recordBrickUsage(store, "brick_repeat", config);
    }

    const loaded = await store.load(brickId("brick_repeat"));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      // After many reinforcements, should cap at tauMax
      expect(loaded.value.trailStrength).toBe(DEFAULT_TRAIL_CONFIG.tauMax);
    }
  });

  test("custom trail config with higher reinforcement", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: brickId("brick_custom"), trailStrength: 0.3 }));

    const config = createDefaultForgeConfig({
      trail: { ...DEFAULT_TRAIL_CONFIG, reinforcement: 0.3 },
    });
    const result = await recordBrickUsage(store, "brick_custom", config);
    expect(result.ok).toBe(true);

    const loaded = await store.load(brickId("brick_custom"));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.trailStrength).toBeCloseTo(0.6, 5); // 0.3 + 0.3
    }
  });

  test("trail strength never drops below tauMin via reinforcement", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: brickId("brick_floor"), trailStrength: 0 }));

    const config = createDefaultForgeConfig({ trail: DEFAULT_TRAIL_CONFIG });
    const result = await recordBrickUsage(store, "brick_floor", config);
    expect(result.ok).toBe(true);

    const loaded = await store.load(brickId("brick_floor"));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      // 0 + 0.1 = 0.1, which is ≥ tauMin (0.01)
      expect(loaded.value.trailStrength).toBeCloseTo(0.1, 5);
      expect(loaded.value.trailStrength).toBeGreaterThanOrEqual(DEFAULT_TRAIL_CONFIG.tauMin);
    }
  });
});
