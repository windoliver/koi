import { describe, expect, test } from "bun:test";
import { createDefaultForgeConfig } from "./config.js";

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

  test("returns new object each time", () => {
    const a = createDefaultForgeConfig();
    const b = createDefaultForgeConfig();
    expect(a).toEqual(b);
  });
});
