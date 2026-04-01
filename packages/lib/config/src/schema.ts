/**
 * Zod schemas for all 8 KoiConfig sections + validation + JSON Schema export.
 */

import type { KoiError, Result } from "@koi/core";
import type { KoiConfig } from "@koi/core/config";
import { validateWith } from "@koi/validation";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Section schemas
// ---------------------------------------------------------------------------

const logLevelSchema = z.enum(["debug", "info", "warn", "error", "silent"]);

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
  threshold: z.number().int().positive(),
  warningThreshold: z.number().int().positive().optional(),
});

const spawnSchema = z.object({
  maxDepth: z.number().int().positive(),
  maxFanOut: z.number().int().positive(),
  maxTotalProcesses: z.number().int().positive(),
  spawnToolIds: z.array(z.string()).optional(),
});

const forgeSchema = z.object({
  enabled: z.boolean(),
  maxForgeDepth: z.number().int().nonnegative(),
  maxForgesPerSession: z.number().int().positive(),
  defaultScope: z.string(),
  defaultPolicy: z.string(),
});

const modelTargetSchema = z.object({
  provider: z.string(),
  model: z.string(),
  weight: z.number().positive().optional(),
  enabled: z.boolean().optional(),
});

const modelRouterSchema = z.object({
  strategy: z.string(),
  targets: z.array(modelTargetSchema),
});

const featuresSchema = z.record(z.string(), z.boolean());

// ---------------------------------------------------------------------------
// Top-level KoiConfig schema
// ---------------------------------------------------------------------------

/** Zod schema for the full KoiConfig type. */
const koiConfigSchema = z.object({
  logLevel: logLevelSchema,
  telemetry: telemetrySchema,
  limits: limitsSchema,
  loopDetection: loopDetectionSchema,
  spawn: spawnSchema,
  forge: forgeSchema,
  modelRouter: modelRouterSchema,
  features: featuresSchema,
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates raw input against the full KoiConfig schema.
 *
 * Returns `Result<KoiConfig, KoiError>` — never throws for validation errors.
 */
export function validateKoiConfig(raw: unknown): Result<KoiConfig, KoiError> {
  return validateWith(koiConfigSchema, raw, "KoiConfig validation failed");
}

// ---------------------------------------------------------------------------
// JSON Schema export
// ---------------------------------------------------------------------------

/**
 * Returns a JSON Schema representation of the KoiConfig schema.
 *
 * Useful for IDE autocompletion in YAML/JSON config files.
 */
export function getKoiConfigJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(koiConfigSchema, { target: "draft-2020-12" });
}
