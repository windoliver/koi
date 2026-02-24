import { describe, expect, test } from "bun:test";
import type { ForgeStore, KoiError, Result } from "@koi/core";
import { createDefaultForgeConfig } from "./config.js";
import { createInMemoryForgeStore } from "./memory-store.js";
import type { ToolArtifact } from "./types.js";
import { computeAutoPromotion, recordBrickUsage } from "./usage.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createToolBrick(overrides?: Partial<ToolArtifact>): ToolArtifact {
  return {
    id: "brick_test",
    kind: "tool",
    name: "test-brick",
    description: "A test brick",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    createdBy: "agent-1",
    createdAt: Date.now(),
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    contentHash: "test-hash",
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
    await store.save(createToolBrick({ id: "brick_1", usageCount: 0 }));

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
    await store.save(createToolBrick({ id: "brick_1", usageCount: 4, trustTier: "sandbox" }));

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
    await store.save(createToolBrick({ id: "brick_1", usageCount: 19, trustTier: "verified" }));

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
    await store.save(createToolBrick({ id: "brick_1", usageCount: 4, trustTier: "sandbox" }));

    const config = createDefaultForgeConfig({
      autoPromotion: {
        enabled: true,
        sandboxToVerifiedThreshold: 5,
        verifiedToPromotedThreshold: 20,
      },
    });

    await recordBrickUsage(store, "brick_1", config);

    const loaded = await store.load("brick_1");
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
    await store.save(createToolBrick({ id: "brick_1" }));

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
    await store.save(createToolBrick({ id: "brick_1", usageCount: 4, trustTier: "sandbox" }));

    // autoPromotion disabled by default
    const config = createDefaultForgeConfig();

    const result = await recordBrickUsage(store, "brick_1", config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("recorded");
      expect(result.value.newUsageCount).toBe(5);
    }

    // Verify trust tier unchanged
    const loaded = await store.load("brick_1");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.trustTier).toBe("sandbox");
    }
  });
});
