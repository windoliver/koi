import { describe, expect, test } from "bun:test";
import type { ForgeStore, KoiError, Result } from "@koi/core";
import { brickId } from "@koi/core";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { createDefaultForgeConfig } from "./config.js";
import { createInMemoryForgeStore } from "./memory-store.js";
import type { ToolArtifact } from "./types.js";
import type { UsageSignal } from "./usage.js";
import { computeAutoPromotion, recordBrickUsage } from "./usage.js";

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

const ENABLED_CONFIG = {
  enabled: true,
  sandboxToVerifiedThreshold: 5,
  verifiedToPromotedThreshold: 20,
} as const;

const DISABLED_CONFIG = {
  enabled: false,
  sandboxToVerifiedThreshold: 5,
  verifiedToPromotedThreshold: 20,
} as const;

// ---------------------------------------------------------------------------
// computeAutoPromotion
// ---------------------------------------------------------------------------

describe("computeAutoPromotion", () => {
  test("returns undefined when disabled", () => {
    expect(computeAutoPromotion("sandbox", 100, DISABLED_CONFIG)).toBeUndefined();
  });

  test("returns undefined below sandbox→verified threshold", () => {
    expect(computeAutoPromotion("sandbox", 4, ENABLED_CONFIG)).toBeUndefined();
  });

  test("returns 'verified' at exactly the sandbox→verified threshold", () => {
    expect(computeAutoPromotion("sandbox", 5, ENABLED_CONFIG)).toBe("verified");
  });

  test("returns 'verified' above sandbox→verified threshold", () => {
    expect(computeAutoPromotion("sandbox", 10, ENABLED_CONFIG)).toBe("verified");
  });

  test("returns undefined for verified below verified→promoted threshold", () => {
    expect(computeAutoPromotion("verified", 19, ENABLED_CONFIG)).toBeUndefined();
  });

  test("returns 'promoted' at exactly the verified→promoted threshold", () => {
    expect(computeAutoPromotion("verified", 20, ENABLED_CONFIG)).toBe("promoted");
  });

  test("returns 'promoted' above verified→promoted threshold", () => {
    expect(computeAutoPromotion("verified", 50, ENABLED_CONFIG)).toBe("promoted");
  });

  test("returns undefined when already promoted", () => {
    expect(computeAutoPromotion("promoted", 100, ENABLED_CONFIG)).toBeUndefined();
  });
});

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

  test("promotes sandbox→verified when threshold crossed", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createToolBrick({ id: brickId("brick_1"), usageCount: 4, trustTier: "sandbox" }),
    );

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
      expect(result.value.kind).toBe("promoted");
      if (result.value.kind === "promoted") {
        expect(result.value.previousTier).toBe("sandbox");
        expect(result.value.newTier).toBe("verified");
        expect(result.value.newUsageCount).toBe(5);
      }
    }
  });

  test("promotes verified→promoted when threshold crossed", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createToolBrick({ id: brickId("brick_1"), usageCount: 19, trustTier: "verified" }),
    );

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
      expect(result.value.kind).toBe("promoted");
      if (result.value.kind === "promoted") {
        expect(result.value.previousTier).toBe("verified");
        expect(result.value.newTier).toBe("promoted");
        expect(result.value.newUsageCount).toBe(20);
      }
    }
  });

  test("persists both usageCount and trustTier to store", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createToolBrick({ id: brickId("brick_1"), usageCount: 4, trustTier: "sandbox" }),
    );

    const config = createDefaultForgeConfig({
      autoPromotion: {
        enabled: true,
        sandboxToVerifiedThreshold: 5,
        verifiedToPromotedThreshold: 20,
      },
    });

    await recordBrickUsage(store, "brick_1", config);

    const loaded = await store.load(brickId("brick_1"));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.usageCount).toBe(5);
      expect(loaded.value.trustTier).toBe("verified");
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
