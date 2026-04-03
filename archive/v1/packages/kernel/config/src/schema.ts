/**
 * Zod schemas for KoiConfig sections + top-level validateKoiConfig().
 *
 * Follows the @koi/model-router pattern: schema → validateWith() → resolved config.
 * Schemas are module-private; only validateKoiConfig() is exported.
 */

import type { KoiConfig, KoiError, Result } from "@koi/core";
import { validateWith } from "@koi/validation";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Section schemas (not exported — tested via validateKoiConfig)
// ---------------------------------------------------------------------------

const logLevelSchema = z.union([
  z.literal("debug"),
  z.literal("info"),
  z.literal("warn"),
  z.literal("error"),
  z.literal("silent"),
]);

const telemetrySchema = z.object({
  enabled: z.boolean(),
  endpoint: z.string().url().optional(),
  sampleRate: z.number().min(0).max(1).optional(),
});

const limitsSchema = z.object({
  maxTurns: z.number().int().positive(),
  maxDurationMs: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
});

const loopDetectionSchema = z.object({
  enabled: z.boolean(),
  windowSize: z.number().int().positive(),
  threshold: z.number().int().min(2),
  warningThreshold: z.number().int().positive().optional(),
});

const spawnSchema = z.object({
  maxDepth: z.number().int().min(0),
  maxFanOut: z.number().int().positive(),
  maxTotalProcesses: z.number().int().positive(),
  spawnToolIds: z.array(z.string().min(1)).optional(),
});

const forgeConfigSchema = z.object({
  enabled: z.boolean(),
  maxForgeDepth: z.number().int().min(0),
  maxForgesPerSession: z.number().int().positive(),
  defaultScope: z.union([z.literal("agent"), z.literal("zone"), z.literal("global")]),
  defaultPolicy: z.union([z.literal("sandbox"), z.literal("verified"), z.literal("promoted")]),
});

const modelTargetEntrySchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  weight: z.number().min(0).max(1).optional(),
  enabled: z.boolean().optional(),
});

const modelRouterSchema = z.object({
  strategy: z.union([z.literal("fallback"), z.literal("round-robin"), z.literal("weighted")]),
  targets: z.array(modelTargetEntrySchema).min(1),
});

const featureFlagsSchema = z.record(z.string(), z.boolean());

// ---------------------------------------------------------------------------
// Top-level KoiConfig schema (not exported — use validateKoiConfig)
// ---------------------------------------------------------------------------

const koiConfigSchema = z.object({
  logLevel: logLevelSchema,
  telemetry: telemetrySchema,
  limits: limitsSchema,
  loopDetection: loopDetectionSchema,
  spawn: spawnSchema,
  forge: forgeConfigSchema,
  modelRouter: modelRouterSchema,
  features: featureFlagsSchema,
});

// ---------------------------------------------------------------------------
// Validation function
// ---------------------------------------------------------------------------

/**
 * Validates raw input against the full KoiConfig schema.
 */
export function validateKoiConfig(raw: unknown): Result<KoiConfig, KoiError> {
  return validateWith(koiConfigSchema, raw, "KoiConfig validation failed");
}

/**
 * Returns the JSON Schema representation of the KoiConfig schema.
 * Uses Zod 4's built-in `z.toJSONSchema()` — no external dependency needed.
 */
export function getKoiConfigJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(koiConfigSchema, { target: "draft-2020-12" }) as Record<string, unknown>;
}
