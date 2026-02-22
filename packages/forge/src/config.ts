/**
 * Forge configuration — required fields with factory defaults.
 */

import type { ForgeScope, TrustTier } from "@koi/core";

// ---------------------------------------------------------------------------
// Configuration interfaces
// ---------------------------------------------------------------------------

export interface ScopePromotionConfig {
  readonly requireHumanApproval: boolean;
  readonly minTrustForZone: TrustTier;
  readonly minTrustForGlobal: TrustTier;
}

export interface VerificationConfig {
  readonly staticTimeoutMs: number;
  readonly sandboxTimeoutMs: number;
  readonly selfTestTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly maxBrickSizeBytes: number;
}

export interface ForgeConfig {
  readonly enabled: boolean;
  readonly maxForgeDepth: number;
  readonly maxForgesPerSession: number;
  readonly defaultScope: ForgeScope;
  readonly defaultTrustTier: TrustTier;
  readonly scopePromotion: ScopePromotionConfig;
  readonly verification: VerificationConfig;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_SCOPE_PROMOTION: ScopePromotionConfig = {
  requireHumanApproval: true,
  minTrustForZone: "verified",
  minTrustForGlobal: "promoted",
} as const;

const DEFAULT_VERIFICATION: VerificationConfig = {
  staticTimeoutMs: 1_000,
  sandboxTimeoutMs: 5_000,
  selfTestTimeoutMs: 10_000,
  totalTimeoutMs: 30_000,
  maxBrickSizeBytes: 50_000,
} as const;

const DEFAULT_CONFIG: ForgeConfig = {
  enabled: true,
  maxForgeDepth: 1,
  maxForgesPerSession: 5,
  defaultScope: "agent",
  defaultTrustTier: "sandbox",
  scopePromotion: DEFAULT_SCOPE_PROMOTION,
  verification: DEFAULT_VERIFICATION,
} as const;

export function createDefaultForgeConfig(overrides?: Partial<ForgeConfig>): ForgeConfig {
  if (overrides === undefined) {
    return DEFAULT_CONFIG;
  }
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    scopePromotion:
      overrides.scopePromotion !== undefined
        ? { ...DEFAULT_SCOPE_PROMOTION, ...overrides.scopePromotion }
        : DEFAULT_SCOPE_PROMOTION,
    verification:
      overrides.verification !== undefined
        ? { ...DEFAULT_VERIFICATION, ...overrides.verification }
        : DEFAULT_VERIFICATION,
  };
}
