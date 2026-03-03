/**
 * Tests for SandboxMiddlewareConfig validation.
 */

import { describe, expect, it } from "bun:test";
import type { TrustTier } from "@koi/core/ecs";
import type { SandboxProfile } from "@koi/core/sandbox-profile";
import { validateConfig } from "./config.js";

const stubProfile: SandboxProfile = {
  tier: "sandbox",
  filesystem: {},
  network: { allow: false },
  resources: { timeoutMs: 100 },
};

const validConfig = {
  profileFor: (_tier: TrustTier) => stubProfile,
  tierFor: (_toolId: string) => "sandbox" as const,
};

describe("validateConfig", () => {
  it("accepts a valid config with required fields only", () => {
    const result = validateConfig(validConfig);
    expect(result.ok).toBe(true);
  });

  it("accepts a valid config with all optional fields", () => {
    const result = validateConfig({
      ...validConfig,
      outputLimitBytes: 512,
      timeoutGraceMs: 1000,
      skipTiers: ["promoted"],
      perToolOverrides: new Map(),
      failClosedOnLookupError: false,
      onSandboxError: () => {},
      onSandboxMetrics: () => {},
    });
    expect(result.ok).toBe(true);
  });

  it("rejects null", () => {
    const result = validateConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("non-null object");
    }
  });

  it("rejects undefined", () => {
    const result = validateConfig(undefined);
    expect(result.ok).toBe(false);
  });

  it("rejects non-object", () => {
    const result = validateConfig("string");
    expect(result.ok).toBe(false);
  });

  it("rejects missing profileFor", () => {
    const result = validateConfig({ tierFor: validConfig.tierFor });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("profileFor");
    }
  });

  it("rejects non-function profileFor", () => {
    const result = validateConfig({ ...validConfig, profileFor: "not-a-fn" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("profileFor");
    }
  });

  it("rejects missing tierFor", () => {
    const result = validateConfig({ profileFor: validConfig.profileFor });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("tierFor");
    }
  });

  it("rejects non-function tierFor", () => {
    const result = validateConfig({ ...validConfig, tierFor: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("tierFor");
    }
  });

  it("rejects non-positive outputLimitBytes", () => {
    const result = validateConfig({ ...validConfig, outputLimitBytes: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("outputLimitBytes");
    }
  });

  it("rejects Infinity outputLimitBytes", () => {
    const result = validateConfig({ ...validConfig, outputLimitBytes: Infinity });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("finite");
    }
  });

  it("rejects NaN outputLimitBytes", () => {
    const result = validateConfig({ ...validConfig, outputLimitBytes: NaN });
    expect(result.ok).toBe(false);
  });

  it("rejects negative timeoutGraceMs", () => {
    const result = validateConfig({ ...validConfig, timeoutGraceMs: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("timeoutGraceMs");
    }
  });

  it("rejects Infinity timeoutGraceMs", () => {
    const result = validateConfig({ ...validConfig, timeoutGraceMs: Infinity });
    expect(result.ok).toBe(false);
  });

  it("accepts zero timeoutGraceMs", () => {
    const result = validateConfig({ ...validConfig, timeoutGraceMs: 0 });
    expect(result.ok).toBe(true);
  });

  it("rejects non-array skipTiers", () => {
    const result = validateConfig({ ...validConfig, skipTiers: "promoted" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("skipTiers");
    }
  });

  it("rejects skipTiers with invalid tier values", () => {
    const result = validateConfig({ ...validConfig, skipTiers: ["sandbox", "invalid-tier"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("valid TrustTier");
    }
  });

  it("rejects non-boolean failClosedOnLookupError", () => {
    const result = validateConfig({ ...validConfig, failClosedOnLookupError: "yes" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("failClosedOnLookupError");
    }
  });

  it("rejects non-function onSandboxError", () => {
    const result = validateConfig({ ...validConfig, onSandboxError: "callback" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("onSandboxError");
    }
  });

  it("rejects non-function onSandboxMetrics", () => {
    const result = validateConfig({ ...validConfig, onSandboxMetrics: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("onSandboxMetrics");
    }
  });
});
