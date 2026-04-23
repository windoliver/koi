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

const permissionsSchema = z
  .object({
    // "bypass" is excluded: settings cannot disable rule evaluation.
    // Programmatic callers use createPermissionBackend({ mode: "bypass" }) directly.
    defaultMode: z.enum(["default", "plan", "auto"]).optional(),
    allow: z.array(permissionStringSchema).optional(),
    ask: z.array(permissionStringSchema).optional(),
    deny: z.array(permissionStringSchema).optional(),
    additionalDirectories: z.array(z.string().min(1)).optional(),
  })
  .readonly();

const hooksSchema = z
  .object({
    PreToolUse: hookEventSchema.optional(),
    PostToolUse: hookEventSchema.optional(),
    SessionStart: hookEventSchema.optional(),
    SessionEnd: hookEventSchema.optional(),
    Stop: hookEventSchema.optional(),
  })
  .readonly();

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
  return z.toJSONSchema(koiSettingsSchema, { target: "draft-2020-12" });
}
