/**
 * Forge configuration — Zod schema, validation, factory with defaults.
 */

import type { KoiError, Result, ToolPolicy, TrailConfig } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, DEFAULT_TRAIL_CONFIG } from "@koi/core";
import { validateWith } from "@koi/validation";
import { z } from "zod";
import type { ReverificationConfig } from "./reverification.js";
import type { ForgeScope } from "./types.js";

// ---------------------------------------------------------------------------
// Configuration interfaces
// ---------------------------------------------------------------------------

export interface ScopePromotionConfig {
  readonly requireHumanApproval: boolean;
}

export interface VerificationConfig {
  readonly staticTimeoutMs: number;
  readonly sandboxTimeoutMs: number;
  readonly selfTestTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly maxBrickSizeBytes: number;
  readonly failFast: boolean;
  readonly maxAutoTestCases: number;
}

export interface DependencyConfig {
  /** Package names explicitly allowed (empty = all allowed). */
  readonly allowedPackages?: readonly string[];
  /** Package names explicitly blocked (takes precedence over allowedPackages). */
  readonly blockedPackages?: readonly string[];
  /** Maximum number of dependencies per brick. */
  readonly maxDependencies: number;
  /** Timeout for a single `bun install` in milliseconds. */
  readonly installTimeoutMs: number;
  /** Maximum total disk space for all brick workspaces. */
  readonly maxCacheSizeBytes: number;
  /** Maximum age (in days) for unused workspaces before LRU eviction. */
  readonly maxWorkspaceAgeDays: number;
  /** Maximum number of transitive dependencies allowed after resolution. */
  readonly maxTransitiveDependencies: number;
  /** Maximum virtual memory (MB) for brick subprocess. */
  readonly maxBrickMemoryMb: number;
  /** Maximum number of child processes for brick subprocess (Linux only). */
  readonly maxBrickPids: number;
  /**
   * Existing workspace path to reuse (skip audit + install).
   * When set, verifyResolve skips workspace creation and only writes the entry file.
   * Used by harness-search to avoid repeating dependency resolution per refinement iteration.
   */
  readonly reuseWorkspace?: string | undefined;
}

export interface FormatConfig {
  readonly enabled: boolean;
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

export interface MutationPressureConfig {
  /** Whether mutation pressure checks are enabled. Default: false (opt-in). */
  readonly enabled: boolean;
  /** Fitness above this threshold → frozen (block forge). Default: 0.9. */
  readonly frozenThreshold: number;
  /** Fitness above this threshold → stable (normal). Default: 0.5. */
  readonly stableThreshold: number;
  /** Fitness above this threshold → experimental. Default: 0.2. Below → aggressive. */
  readonly experimentalThreshold: number;
}

export interface ForgeConfig {
  readonly enabled: boolean;
  readonly maxForgeDepth: number;
  readonly maxForgesPerSession: number;
  readonly defaultScope: ForgeScope;
  readonly defaultPolicy: ToolPolicy;
  readonly scopePromotion: ScopePromotionConfig;
  readonly verification: VerificationConfig;
  readonly dependencies: DependencyConfig;
  readonly format: FormatConfig;
  readonly reverification?: ReverificationConfig;
  readonly mutationPressure?: MutationPressureConfig;
  /** Trail strength config for stigmergic coordination. */
  readonly trail?: TrailConfig;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const networkCapabilitySchema = z.object({
  allow: z.boolean(),
  hosts: z.array(z.string()).optional(),
});

const filesystemCapabilitySchema = z.object({
  read: z.array(z.string()).optional(),
  write: z.array(z.string()).optional(),
});

const resourceCapabilitySchema = z.object({
  maxMemoryMb: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxPids: z.number().int().positive().optional(),
  maxOpenFiles: z.number().int().positive().optional(),
});

const toolCapabilitiesSchema = z.object({
  network: networkCapabilitySchema.optional(),
  filesystem: filesystemCapabilitySchema.optional(),
  resources: resourceCapabilitySchema.optional(),
});

const toolPolicySchema = z.object({
  sandbox: z.boolean(),
  capabilities: toolCapabilitiesSchema,
});

const forgeScopeSchema = z.union([z.literal("agent"), z.literal("zone"), z.literal("global")]);

const scopePromotionSchema = z.object({
  requireHumanApproval: z.boolean().optional(),
});

const verificationSchema = z.object({
  staticTimeoutMs: z.number().int().positive().optional(),
  sandboxTimeoutMs: z.number().int().positive().optional(),
  selfTestTimeoutMs: z.number().int().positive().optional(),
  totalTimeoutMs: z.number().int().positive().optional(),
  maxBrickSizeBytes: z.number().int().positive().optional(),
  failFast: z.boolean().optional(),
  maxAutoTestCases: z.number().int().min(0).optional(),
});

const dependencySchema = z.object({
  allowedPackages: z.array(z.string()).optional(),
  blockedPackages: z.array(z.string()).optional(),
  maxDependencies: z.number().int().positive().optional(),
  installTimeoutMs: z.number().int().positive().optional(),
  maxCacheSizeBytes: z.number().int().positive().optional(),
  maxWorkspaceAgeDays: z.number().int().positive().optional(),
  maxTransitiveDependencies: z.number().int().positive().optional(),
  maxBrickMemoryMb: z.number().int().positive().optional(),
  maxBrickPids: z.number().int().positive().optional(),
});

const formatSchema = z.object({
  enabled: z.boolean().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const mutationPressureSchema = z.object({
  enabled: z.boolean().optional(),
  frozenThreshold: z.number().min(0).max(1).optional(),
  stableThreshold: z.number().min(0).max(1).optional(),
  experimentalThreshold: z.number().min(0).max(1).optional(),
});

const forgeConfigInputSchema = z.object({
  enabled: z.boolean().optional(),
  maxForgeDepth: z.number().int().min(0).optional(),
  maxForgesPerSession: z.number().int().positive().optional(),
  defaultScope: forgeScopeSchema.optional(),
  defaultPolicy: toolPolicySchema.optional(),
  scopePromotion: scopePromotionSchema.optional(),
  verification: verificationSchema.optional(),
  dependencies: dependencySchema.optional(),
  format: formatSchema.optional(),
  mutationPressure: mutationPressureSchema.optional(),
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_SCOPE_PROMOTION: ScopePromotionConfig = {
  requireHumanApproval: true,
} as const;

const DEFAULT_VERIFICATION: VerificationConfig = {
  staticTimeoutMs: 1_000,
  sandboxTimeoutMs: 5_000,
  selfTestTimeoutMs: 10_000,
  totalTimeoutMs: 60_000,
  maxBrickSizeBytes: 50_000,
  failFast: true,
  maxAutoTestCases: 20,
} as const;

const DEFAULT_FORMAT: FormatConfig = {
  enabled: true,
  command: "biome",
  args: ["format", "--write"],
  timeoutMs: 5_000,
} as const;

const DEFAULT_MUTATION_PRESSURE: MutationPressureConfig = {
  enabled: true,
  frozenThreshold: 0.9,
  stableThreshold: 0.5,
  experimentalThreshold: 0.2,
} as const;

const DEFAULT_DEPENDENCY: DependencyConfig = {
  maxDependencies: 20,
  installTimeoutMs: 15_000,
  maxCacheSizeBytes: 1_073_741_824, // 1 GB
  maxWorkspaceAgeDays: 30,
  maxTransitiveDependencies: 200,
  maxBrickMemoryMb: 256,
  maxBrickPids: 32,
} as const;

const DEFAULT_CONFIG: ForgeConfig = {
  enabled: true,
  maxForgeDepth: 1,
  maxForgesPerSession: 5,
  defaultScope: "global",
  defaultPolicy: DEFAULT_SANDBOXED_POLICY,
  scopePromotion: DEFAULT_SCOPE_PROMOTION,
  verification: DEFAULT_VERIFICATION,
  dependencies: DEFAULT_DEPENDENCY,
  format: DEFAULT_FORMAT,
  trail: DEFAULT_TRAIL_CONFIG,
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
    dependencies:
      overrides.dependencies !== undefined
        ? { ...DEFAULT_DEPENDENCY, ...overrides.dependencies }
        : DEFAULT_DEPENDENCY,
    format:
      overrides.format !== undefined ? { ...DEFAULT_FORMAT, ...overrides.format } : DEFAULT_FORMAT,
    ...(overrides.mutationPressure !== undefined
      ? {
          mutationPressure: { ...DEFAULT_MUTATION_PRESSURE, ...overrides.mutationPressure },
        }
      : {}),
    ...(overrides.trail !== undefined
      ? { trail: { ...DEFAULT_TRAIL_CONFIG, ...overrides.trail } }
      : {}),
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
    defaultPolicy: (p.defaultPolicy ?? DEFAULT_CONFIG.defaultPolicy) as ToolPolicy,
    scopePromotion:
      p.scopePromotion !== undefined
        ? {
            requireHumanApproval:
              p.scopePromotion.requireHumanApproval ?? DEFAULT_SCOPE_PROMOTION.requireHumanApproval,
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
            maxAutoTestCases:
              p.verification.maxAutoTestCases ?? DEFAULT_VERIFICATION.maxAutoTestCases,
          }
        : DEFAULT_VERIFICATION,
    dependencies:
      p.dependencies !== undefined
        ? {
            ...(p.dependencies.allowedPackages !== undefined
              ? { allowedPackages: p.dependencies.allowedPackages }
              : {}),
            ...(p.dependencies.blockedPackages !== undefined
              ? { blockedPackages: p.dependencies.blockedPackages }
              : {}),
            maxDependencies: p.dependencies.maxDependencies ?? DEFAULT_DEPENDENCY.maxDependencies,
            installTimeoutMs:
              p.dependencies.installTimeoutMs ?? DEFAULT_DEPENDENCY.installTimeoutMs,
            maxCacheSizeBytes:
              p.dependencies.maxCacheSizeBytes ?? DEFAULT_DEPENDENCY.maxCacheSizeBytes,
            maxWorkspaceAgeDays:
              p.dependencies.maxWorkspaceAgeDays ?? DEFAULT_DEPENDENCY.maxWorkspaceAgeDays,
            maxTransitiveDependencies:
              p.dependencies.maxTransitiveDependencies ??
              DEFAULT_DEPENDENCY.maxTransitiveDependencies,
            maxBrickMemoryMb:
              p.dependencies.maxBrickMemoryMb ?? DEFAULT_DEPENDENCY.maxBrickMemoryMb,
            maxBrickPids: p.dependencies.maxBrickPids ?? DEFAULT_DEPENDENCY.maxBrickPids,
          }
        : DEFAULT_DEPENDENCY,
    format:
      p.format !== undefined
        ? {
            enabled: p.format.enabled ?? DEFAULT_FORMAT.enabled,
            command: p.format.command ?? DEFAULT_FORMAT.command,
            args: p.format.args ?? DEFAULT_FORMAT.args,
            timeoutMs: p.format.timeoutMs ?? DEFAULT_FORMAT.timeoutMs,
          }
        : DEFAULT_FORMAT,
    ...(p.mutationPressure !== undefined
      ? {
          mutationPressure: {
            enabled: p.mutationPressure.enabled ?? DEFAULT_MUTATION_PRESSURE.enabled,
            frozenThreshold:
              p.mutationPressure.frozenThreshold ?? DEFAULT_MUTATION_PRESSURE.frozenThreshold,
            stableThreshold:
              p.mutationPressure.stableThreshold ?? DEFAULT_MUTATION_PRESSURE.stableThreshold,
            experimentalThreshold:
              p.mutationPressure.experimentalThreshold ??
              DEFAULT_MUTATION_PRESSURE.experimentalThreshold,
          },
        }
      : {}),
  };
  return { ok: true, value: config };
}
