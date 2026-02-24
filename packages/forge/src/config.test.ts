import { describe, expect, test } from "bun:test";
import { createDefaultForgeConfig, validateForgeConfig } from "./config.js";

// ---------------------------------------------------------------------------
// createDefaultForgeConfig (existing tests preserved)
// ---------------------------------------------------------------------------

describe("createDefaultForgeConfig", () => {
  test("returns defaults when no overrides", () => {
    const config = createDefaultForgeConfig();
    expect(config.enabled).toBe(true);
    expect(config.maxForgeDepth).toBe(1);
    expect(config.maxForgesPerSession).toBe(5);
    expect(config.defaultScope).toBe("agent");
    expect(config.defaultTrustTier).toBe("sandbox");
  });

  test("returns defaults for nested scopePromotion", () => {
    const config = createDefaultForgeConfig();
    expect(config.scopePromotion.requireHumanApproval).toBe(true);
    expect(config.scopePromotion.minTrustForZone).toBe("verified");
    expect(config.scopePromotion.minTrustForGlobal).toBe("promoted");
  });

  test("returns defaults for nested verification", () => {
    const config = createDefaultForgeConfig();
    expect(config.verification.staticTimeoutMs).toBe(1_000);
    expect(config.verification.sandboxTimeoutMs).toBe(5_000);
    expect(config.verification.selfTestTimeoutMs).toBe(10_000);
    expect(config.verification.totalTimeoutMs).toBe(30_000);
    expect(config.verification.maxBrickSizeBytes).toBe(50_000);
  });

  test("overrides top-level fields", () => {
    const config = createDefaultForgeConfig({ enabled: false, maxForgeDepth: 3 });
    expect(config.enabled).toBe(false);
    expect(config.maxForgeDepth).toBe(3);
    expect(config.maxForgesPerSession).toBe(5); // unchanged
  });

  test("overrides nested scopePromotion", () => {
    const config = createDefaultForgeConfig({
      scopePromotion: {
        requireHumanApproval: false,
        minTrustForZone: "sandbox",
        minTrustForGlobal: "verified",
      },
    });
    expect(config.scopePromotion.requireHumanApproval).toBe(false);
    expect(config.scopePromotion.minTrustForZone).toBe("sandbox");
    expect(config.scopePromotion.minTrustForGlobal).toBe("verified");
  });

  test("overrides nested verification", () => {
    const config = createDefaultForgeConfig({
      verification: {
        staticTimeoutMs: 500,
        sandboxTimeoutMs: 2_000,
        selfTestTimeoutMs: 5_000,
        totalTimeoutMs: 15_000,
        maxBrickSizeBytes: 25_000,
        failFast: true,
      },
    });
    expect(config.verification.sandboxTimeoutMs).toBe(2_000);
    expect(config.verification.maxBrickSizeBytes).toBe(25_000);
  });

  test("returns defaults for nested autoPromotion", () => {
    const config = createDefaultForgeConfig();
    expect(config.autoPromotion.enabled).toBe(false);
    expect(config.autoPromotion.sandboxToVerifiedThreshold).toBe(5);
    expect(config.autoPromotion.verifiedToPromotedThreshold).toBe(20);
  });

  test("overrides nested autoPromotion", () => {
    const config = createDefaultForgeConfig({
      autoPromotion: {
        enabled: true,
        sandboxToVerifiedThreshold: 10,
        verifiedToPromotedThreshold: 50,
      },
    });
    expect(config.autoPromotion.enabled).toBe(true);
    expect(config.autoPromotion.sandboxToVerifiedThreshold).toBe(10);
    expect(config.autoPromotion.verifiedToPromotedThreshold).toBe(50);
  });

  test("returns new object each time", () => {
    const a = createDefaultForgeConfig();
    const b = createDefaultForgeConfig();
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// validateForgeConfig — positive cases
// ---------------------------------------------------------------------------

describe("validateForgeConfig (positive)", () => {
  test("accepts empty object and returns defaults", () => {
    const result = validateForgeConfig({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.enabled).toBe(true);
      expect(result.value.maxForgeDepth).toBe(1);
    }
  });

  test("accepts partial overrides", () => {
    const result = validateForgeConfig({ enabled: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.enabled).toBe(false);
      expect(result.value.maxForgeDepth).toBe(1); // default
    }
  });

  test("accepts full config", () => {
    const result = validateForgeConfig({
      enabled: false,
      maxForgeDepth: 2,
      maxForgesPerSession: 10,
      defaultScope: "zone",
      defaultTrustTier: "verified",
      scopePromotion: {
        requireHumanApproval: false,
        minTrustForZone: "sandbox",
        minTrustForGlobal: "promoted",
      },
      verification: {
        staticTimeoutMs: 2_000,
        sandboxTimeoutMs: 10_000,
        selfTestTimeoutMs: 20_000,
        totalTimeoutMs: 60_000,
        maxBrickSizeBytes: 100_000,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.maxForgeDepth).toBe(2);
      expect(result.value.defaultScope).toBe("zone");
    }
  });

  test("accepts partial autoPromotion overrides", () => {
    const result = validateForgeConfig({
      autoPromotion: { enabled: true },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.autoPromotion.enabled).toBe(true);
      expect(result.value.autoPromotion.sandboxToVerifiedThreshold).toBe(5);
      expect(result.value.autoPromotion.verifiedToPromotedThreshold).toBe(20);
    }
  });

  test("accepts full autoPromotion config", () => {
    const result = validateForgeConfig({
      autoPromotion: {
        enabled: true,
        sandboxToVerifiedThreshold: 10,
        verifiedToPromotedThreshold: 50,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.autoPromotion.enabled).toBe(true);
      expect(result.value.autoPromotion.sandboxToVerifiedThreshold).toBe(10);
      expect(result.value.autoPromotion.verifiedToPromotedThreshold).toBe(50);
    }
  });
});

// ---------------------------------------------------------------------------
// validateForgeConfig — negative cases
// ---------------------------------------------------------------------------

describe("validateForgeConfig (negative)", () => {
  test("rejects null input", () => {
    const result = validateForgeConfig(null);
    expect(result.ok).toBe(false);
  });

  test("rejects string input", () => {
    const result = validateForgeConfig("bad");
    expect(result.ok).toBe(false);
  });

  test("rejects number input", () => {
    const result = validateForgeConfig(42);
    expect(result.ok).toBe(false);
  });

  test("rejects enabled as string", () => {
    const result = validateForgeConfig({ enabled: "yes" });
    expect(result.ok).toBe(false);
  });

  test("rejects negative maxForgeDepth", () => {
    const result = validateForgeConfig({ maxForgeDepth: -1 });
    expect(result.ok).toBe(false);
  });

  test("rejects float maxForgeDepth", () => {
    const result = validateForgeConfig({ maxForgeDepth: 1.5 });
    expect(result.ok).toBe(false);
  });

  test("rejects zero maxForgesPerSession", () => {
    const result = validateForgeConfig({ maxForgesPerSession: 0 });
    expect(result.ok).toBe(false);
  });

  test("rejects negative maxForgesPerSession", () => {
    const result = validateForgeConfig({ maxForgesPerSession: -1 });
    expect(result.ok).toBe(false);
  });

  test("rejects invalid defaultScope", () => {
    const result = validateForgeConfig({ defaultScope: "universe" });
    expect(result.ok).toBe(false);
  });

  test("rejects invalid defaultTrustTier", () => {
    const result = validateForgeConfig({ defaultTrustTier: "untrusted" });
    expect(result.ok).toBe(false);
  });

  test("rejects negative staticTimeoutMs in verification", () => {
    const result = validateForgeConfig({ verification: { staticTimeoutMs: -100 } });
    expect(result.ok).toBe(false);
  });

  test("rejects zero sandboxTimeoutMs in verification", () => {
    const result = validateForgeConfig({ verification: { sandboxTimeoutMs: 0 } });
    expect(result.ok).toBe(false);
  });

  test("rejects float maxBrickSizeBytes in verification", () => {
    const result = validateForgeConfig({ verification: { maxBrickSizeBytes: 50.5 } });
    expect(result.ok).toBe(false);
  });

  test("error includes proper prefix", () => {
    const result = validateForgeConfig({ maxForgeDepth: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("Forge config validation failed");
    }
  });

  test("rejects invalid minTrustForZone in scopePromotion", () => {
    const result = validateForgeConfig({
      scopePromotion: { minTrustForZone: "invalid" },
    });
    expect(result.ok).toBe(false);
  });

  test("rejects negative sandboxToVerifiedThreshold in autoPromotion", () => {
    const result = validateForgeConfig({
      autoPromotion: { sandboxToVerifiedThreshold: -1 },
    });
    expect(result.ok).toBe(false);
  });

  test("rejects zero verifiedToPromotedThreshold in autoPromotion", () => {
    const result = validateForgeConfig({
      autoPromotion: { verifiedToPromotedThreshold: 0 },
    });
    expect(result.ok).toBe(false);
  });
});
