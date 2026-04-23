/**
 * Zod schemas for KoiSettings validation.
 *
 * Provides:
 * - `validateKoiSettings` for validation with Result<T, KoiError> return
 * - `getSettingsJsonSchema` for JSON Schema export (IDE autocompletion)
 */

import type { KoiError, Result } from "@koi/core";
import { validateWith } from "@koi/validation";
import { z } from "zod";
import type { KoiSettings } from "./types.js";

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

const hookCommandSchema = z
  .object({
    type: z.literal("command"),
    command: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
  })
  .readonly();

const hookEventSchema = z.array(hookCommandSchema).readonly();

const permissionsSchema = z
  .object({
    defaultMode: z.enum(["default", "bypass", "plan", "auto"]).optional(),
    allow: z.array(z.string().min(1)).optional(),
    ask: z.array(z.string().min(1)).optional(),
    deny: z.array(z.string().min(1)).optional(),
    additionalDirectories: z.array(z.string().min(1)).optional(),
  })
  .readonly();

const hooksSchema = z.object({
  PreToolUse: hookEventSchema.optional(),
  PostToolUse: hookEventSchema.optional(),
  SessionStart: hookEventSchema.optional(),
  SessionEnd: hookEventSchema.optional(),
  Stop: hookEventSchema.optional(),
});

// ---------------------------------------------------------------------------
// Top-level schema
// ---------------------------------------------------------------------------

const koiSettingsSchema: z.ZodType<KoiSettings> = z
  .object({
    $schema: z.string().optional(),
    permissions: permissionsSchema.optional(),
    env: z.record(z.string(), z.string()).optional(),
    hooks: hooksSchema.optional(),
    apiBaseUrl: z.string().url().optional(),
    theme: z.enum(["dark", "light", "system"]).optional(),
    enableAllProjectMcpServers: z.boolean().optional(),
    disabledMcpServers: z.array(z.string().min(1)).optional(),
  })
  .strip()
  .readonly();

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Validate raw input against the KoiSettings schema.
 * Unknown top-level keys are stripped (not rejected).
 * Returns Result<KoiSettings, KoiError> — never throws.
 */
export function validateKoiSettings(raw: unknown): Result<KoiSettings, KoiError> {
  return validateWith(koiSettingsSchema, raw, "KoiSettings validation failed");
}

/** JSON Schema representation for IDE autocompletion. */
export function getSettingsJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(koiSettingsSchema, { target: "draft-2020-12" }) as Record<string, unknown>;
}
