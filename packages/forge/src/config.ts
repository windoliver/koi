/**
 * Forge configuration — Zod schema, validation, factory with defaults.
 */

import type { KoiError, Result, TrustTier } from "@koi/core";
import { validateWith } from "@koi/validation";
import { z } from "zod";
import type { ForgeScope } from "./types.js";

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
  readonly failFast: boolean;
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
// Zod schemas
// ---------------------------------------------------------------------------

const trustTierSchema = z.union([
  z.literal("sandbox"),
  z.literal("verified"),
  z.literal("promoted"),
]);

const forgeScopeSchema = z.union([z.literal("agent"), z.literal("zone"), z.literal("global")]);

const scopePromotionSchema = z.object({
  requireHumanApproval: z.boolean().optional(),
  minTrustForZone: trustTierSchema.optional(),
  minTrustForGlobal: trustTierSchema.optional(),
});

const verificationSchema = z.object({
  staticTimeoutMs: z.number().int().positive().optional(),
  sandboxTimeoutMs: z.number().int().positive().optional(),
  selfTestTimeoutMs: z.number().int().positive().optional(),
  totalTimeoutMs: z.number().int().positive().optional(),
  maxBrickSizeBytes: z.number().int().positive().optional(),
  failFast: z.boolean().optional(),
});

const forgeConfigInputSchema = z.object({
  enabled: z.boolean().optional(),
  maxForgeDepth: z.number().int().min(0).optional(),
  maxForgesPerSession: z.number().int().positive().optional(),
  defaultScope: forgeScopeSchema.optional(),
  defaultTrustTier: trustTierSchema.optional(),
  scopePromotion: scopePromotionSchema.optional(),
  verification: verificationSchema.optional(),
});

// ---------------------------------------------------------------------------
// Defaults
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
  failFast: true,
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates raw input and resolves a full ForgeConfig with defaults applied.
 *
 * @param raw - Unknown input to validate.
 * @returns Result containing the fully resolved ForgeConfig or a validation error.
 */
export function validateForgeConfig(raw: unknown): Result<ForgeConfig, KoiError> {
  const parsed = validateWith(forgeConfigInputSchema, raw, "Forge config validation failed");
  if (!parsed.ok) {
    return parsed;
  }
  const p = parsed.value;
  const config: ForgeConfig = {
    enabled: p.enabled ?? DEFAULT_CONFIG.enabled,
    maxForgeDepth: p.maxForgeDepth ?? DEFAULT_CONFIG.maxForgeDepth,
    maxForgesPerSession: p.maxForgesPerSession ?? DEFAULT_CONFIG.maxForgesPerSession,
    defaultScope: p.defaultScope ?? DEFAULT_CONFIG.defaultScope,
    defaultTrustTier: p.defaultTrustTier ?? DEFAULT_CONFIG.defaultTrustTier,
    scopePromotion:
      p.scopePromotion !== undefined
        ? {
            requireHumanApproval:
              p.scopePromotion.requireHumanApproval ?? DEFAULT_SCOPE_PROMOTION.requireHumanApproval,
            minTrustForZone:
              p.scopePromotion.minTrustForZone ?? DEFAULT_SCOPE_PROMOTION.minTrustForZone,
            minTrustForGlobal:
              p.scopePromotion.minTrustForGlobal ?? DEFAULT_SCOPE_PROMOTION.minTrustForGlobal,
          }
        : DEFAULT_SCOPE_PROMOTION,
    verification:
      p.verification !== undefined
        ? {
            staticTimeoutMs: p.verification.staticTimeoutMs ?? DEFAULT_VERIFICATION.staticTimeoutMs,
            sandboxTimeoutMs:
              p.verification.sandboxTimeoutMs ?? DEFAULT_VERIFICATION.sandboxTimeoutMs,
            selfTestTimeoutMs:
              p.verification.selfTestTimeoutMs ?? DEFAULT_VERIFICATION.selfTestTimeoutMs,
            totalTimeoutMs: p.verification.totalTimeoutMs ?? DEFAULT_VERIFICATION.totalTimeoutMs,
            maxBrickSizeBytes:
              p.verification.maxBrickSizeBytes ?? DEFAULT_VERIFICATION.maxBrickSizeBytes,
            failFast: p.verification.failFast ?? DEFAULT_VERIFICATION.failFast,
          }
        : DEFAULT_VERIFICATION,
  };
  return { ok: true, value: config };
}
