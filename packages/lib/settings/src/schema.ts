/**
 * Zod schemas for KoiSettings validation.
 *
 * Provides:
 * - `validateKoiSettings` for validation with Result<T, KoiError> return
 * - `validatePolicySettings` for strict policy validation (rejects unknown keys)
 * - `getSettingsJsonSchema` for JSON Schema export (IDE autocompletion)
 *
 * Only fields that are actively consumed by the runtime are included.
 * Fields are added here when their enforcement path is wired in.
 *
 * Two validation modes:
 *   - user/project/local/flag layers: strip unknown keys (backwards compatible)
 *   - policy layer: strict (unknown keys are rejected) — prevents admins from
 *     believing a setting like `disabledMcpServers` is active when it is not.
 */

import type { KoiError, Result } from "@koi/core";
import { validateWith } from "@koi/validation";
import { z } from "zod";
import type { KoiSettings } from "./types.js";

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

/**
 * Valid tool name: starts with a letter, followed by letters/digits/underscores.
 * Rejects glob metacharacters and colons that would silently create overbroad patterns.
 */
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Validates a single permission string, catching the most common structural errors. */
const permissionStringSchema = z
  .string()
  .min(1)
  .superRefine((s, ctx) => {
    if (s === "*") return;
    const parenIdx = s.indexOf("(");
    if (parenIdx === -1) {
      // Bare tool name — must be a plain identifier to prevent glob metacharacters
      // like "Read**" or "Bash:**" from creating overbroad permission patterns.
      if (!TOOL_NAME_RE.test(s)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid permission string "${s}": bare names must be plain tool identifiers (letters, digits, underscores starting with a letter). Use "ToolName(*)" to match all invocations.`,
        });
      }
      return;
    }
    if (!s.endsWith(")")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Missing closing ")" in permission string "${s}"`,
      });
      return;
    }
    const toolName = s.slice(0, parenIdx);
    if (!TOOL_NAME_RE.test(toolName)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid tool name "${toolName}" in permission string "${s}": must be a plain identifier (letters, digits, underscores starting with a letter).`,
      });
    }
  });

const permissionsFields = {
  // "bypass" excluded: settings cannot disable rule evaluation.
  // "plan" excluded: plan mode hard-denies all "invoke" actions, which would
  //   brick the TUI. Wire plan-mode action vocabulary before accepting this.
  // Programmatic callers use createPermissionBackend({ mode }) directly.
  defaultMode: z.enum(["default", "auto"]).optional(),
  allow: z.array(permissionStringSchema).optional(),
  ask: z.array(permissionStringSchema).optional(),
  deny: z.array(permissionStringSchema).optional(),
} as const;

/** Strip mode: unknown permission keys silently dropped. Used for user/project/local/flag. */
const permissionsSchema = z.object(permissionsFields).readonly();

/** Strict mode: unknown permission keys rejected. Used for policy + explicit --settings. */
const permissionsSchemaStrict = z.object(permissionsFields).strict().readonly();

// ---------------------------------------------------------------------------
// Top-level schemas (strip vs strict)
// ---------------------------------------------------------------------------

const settingsFields = {
  $schema: z.string().optional(),
  permissions: permissionsSchema.optional(),
} as const;

const settingsFieldsStrict = {
  $schema: z.string().optional(),
  permissions: permissionsSchemaStrict.optional(),
} as const;

/** Strip mode: unknown top-level keys are silently dropped. Used for user/project/local/flag. */
const koiSettingsSchema: z.ZodType<KoiSettings> = z.object(settingsFields).strip().readonly();

/** Strict mode: unknown top-level and nested permission keys produce a validation error. */
const koiSettingsStrictSchema: z.ZodType<KoiSettings> = z
  .object(settingsFieldsStrict)
  .strict()
  .readonly();

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Validate raw input against the KoiSettings schema.
 * Unknown top-level keys are stripped (not rejected) — for user/project/local/flag.
 * Returns Result<KoiSettings, KoiError> — never throws.
 */
export function validateKoiSettings(raw: unknown): Result<KoiSettings, KoiError> {
  return validateWith(koiSettingsSchema, raw, "KoiSettings validation failed");
}

/**
 * Validate raw input for the policy layer.
 * Unknown top-level keys are rejected — prevents admins from believing
 * unsupported settings keys (e.g. `disabledMcpServers`) are enforced.
 * Returns Result<KoiSettings, KoiError> — never throws.
 */
export function validatePolicySettings(raw: unknown): Result<KoiSettings, KoiError> {
  return validateWith(koiSettingsStrictSchema, raw, "Policy settings validation failed");
}

/** JSON Schema representation for IDE autocompletion. */
export function getSettingsJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(koiSettingsSchema, { target: "draft-2020-12" });
}
